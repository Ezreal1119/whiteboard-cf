#!/usr/bin/env python3
"""Patrick whiteboard client: text, shared-file lists, and direct rclone uploads."""
import json
import configparser
import getpass
import os
import re
import shutil
import tempfile
import mimetypes
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.parse import quote
import uuid

BASE_URL = "https://whiteboard.patrick-shenzhen.org"
MAX_FILE_SIZE = 3_000_000_000
RCLONE_CONFIG = Path.home() / ".config" / "patrick-wb" / "rclone.conf"
PROJECT_DIR = Path(os.environ.get("PATRICK_WB_PROJECT", Path.home() / "whiteboard-cf"))


class APIError(RuntimeError):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def request(method, path, *, metadata=None, data=None, attempts=3, timeout=600):
    if metadata is not None:
        data = json.dumps(metadata, ensure_ascii=False).encode("utf-8")
    for attempt in range(attempts):
        command = ["curl", "--silent", "--show-error", "--fail-with-body",
                   "--connect-timeout", "15", "--max-time", str(timeout),
                   "--write-out", "\n%{http_code}", "-X", method, BASE_URL + path]
        if data is not None:
            content_type = "application/json" if metadata is not None else "application/octet-stream"
            command += ["-H", "Content-Type: " + content_type, "--data-binary", "@-"]
            if metadata is None:
                command += ["-H", "X-Part-Size: " + str(len(data))]
        try:
            result = subprocess.run(command, input=data, capture_output=True, timeout=timeout + 20)
        except (OSError, subprocess.TimeoutExpired) as error:
            if attempt + 1 == attempts:
                raise APIError(str(error)) from error
            time.sleep(0.5 * 2 ** attempt)
            continue
        raw_body, _, raw_status = result.stdout.rpartition(b"\n")
        try:
            status = int(raw_status)
        except ValueError:
            status = 0
        try:
            response = json.loads(raw_body)
        except (ValueError, UnicodeError):
            response = None
        if result.returncode == 0 and 200 <= status < 300 and isinstance(response, dict):
            return response
        message = response.get("error") if isinstance(response, dict) else None
        message = message or result.stderr.decode("utf-8", errors="replace").strip() or "Unexpected server response."
        if (status not in (0, 429) and status < 500) or attempt + 1 == attempts:
            raise APIError(message, status)
        time.sleep(0.5 * 2 ** attempt)
    raise APIError("Request failed.")


def format_size(size):
    for divisor, unit in [(1_000_000_000, "GB"), (1_000_000, "MB"), (1000, "KB")]:
        if size >= divisor:
            return f"{size / divisor:.2f} {unit}"
    return f"{size} B"


def download_url(file):
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", file["name"])
    if name in ("", ".", ".."):
        name = "download"
    return f"{BASE_URL}/api/files/{quote(file['id'], safe='')}/{name}"


def show_board():
    board = request("GET", "/api/board", timeout=30)
    if not isinstance(board.get("text"), str) or not isinstance(board.get("files"), list):
        raise APIError("Unexpected server response.")
    print("Text:")
    print(board["text"] or "(empty)")
    print(f"\nShared files ({len(board['files'])} total):")
    if not board["files"]:
        print("(none)")
    for index, item in enumerate(board["files"], 1):
        print(f"{index}. {item['name']} ({format_size(item['size'])})")
        print(f"   {download_url(item)}")
    if "storage" in board and "limits" in board:
        print(f"\nStorage: {format_size(board['storage']['usedBytes'])} / {format_size(board['limits']['totalBytes'])} (including uploads)")


def stop_rclone(process):
    if process.poll() is not None:
        return
    for sig, timeout in [(signal.SIGINT, 20), (signal.SIGTERM, 5), (signal.SIGKILL, 5)]:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            continue
    raise APIError("Could not stop rclone; server-side cleanup will retain the reservation.")


def upload_file(path):
    file = Path(path).expanduser().resolve()
    if not file.exists() and path.rstrip() != path:
        candidate = Path(path.rstrip()).expanduser().resolve()
        if candidate.is_file():
            file = candidate
            print("Ignoring trailing whitespace in the file path.", file=sys.stderr)
    if not file.is_file():
        raise APIError(f"File not found: {file}")
    initial = file.stat()
    if not 0 < initial.st_size <= MAX_FILE_SIZE:
        raise APIError("File must be between 1 byte and 3 GB.")
    if not shutil.which("rclone") or not RCLONE_CONFIG.is_file():
        raise APIError("Direct uploads are not configured. Run patrick wb --setup first.")
    upload_id = str(uuid.uuid4())
    token = uuid.uuid4().hex + uuid.uuid4().hex
    upload_path = "/api/uploads/" + upload_id
    process = None
    stopped = True
    try:
        session = request("POST", "/api/uploads", metadata={
            "id": upload_id, "mode": "rclone", "stopToken": token,
            "name": file.name, "size": initial.st_size,
            "type": mimetypes.guess_type(file.name)[0] or "application/octet-stream",
        })
        if session.get("status") == "ready":
            return session["file"]
        if session.get("key") != "attachments/" + upload_id or session.get("bucket") != "whiteboard-attachments":
            raise APIError("Unexpected R2 upload destination.")
        command = ["rclone", "--config", str(RCLONE_CONFIG), "copyto", str(file),
                   "wb:" + session["bucket"] + "/" + session["key"],
                   "--s3-no-check-bucket", "--s3-upload-cutoff", "0",
                   "--s3-chunk-size", "16Mi", "--s3-upload-concurrency", "4",
                   "--max-duration", "22h", "-P"]
        # A separate process group lets us stop every transfer before acknowledging
        # cancellation. Native multipart uploads can then be aborted atomically.
        process = subprocess.Popen(command, start_new_session=True)
        stopped = False
        while True:
            try:
                code = process.wait(timeout=5)
                stopped = True
                break
            except subprocess.TimeoutExpired:
                try:
                    request("GET", upload_path, attempts=1, timeout=10)
                except APIError as error:
                    if error.status in (404, 409):
                        raise APIError("Upload was cancelled on the board.") from error
        if code:
            raise APIError(f"Rclone upload failed (exit code {code}).")
        current = file.stat()
        if current.st_size != initial.st_size or current.st_mtime_ns != initial.st_mtime_ns:
            raise APIError("The file changed during upload. Please retry.")
        print("Upload complete. Registering shared file...", file=sys.stderr, flush=True)
        return request("POST", upload_path + "/complete", metadata={"stopToken": token})
    except BaseException:
        if process is not None:
            try:
                stop_rclone(process)
                stopped = process.poll() is not None
            except (APIError, KeyboardInterrupt):
                stopped = False
        try:
            status = request("GET", upload_path, attempts=1, timeout=15)
            if status.get("status") == "ready":
                return status["file"]
        except (APIError, KeyboardInterrupt):
            pass
        try:
            if stopped:
                result = request("POST", upload_path + "/cancel", metadata={"stopToken": token}, attempts=2, timeout=30)
            else:
                result = request("DELETE", upload_path, attempts=2, timeout=15)
            if result.get("cleanupPending"):
                print("Cleanup is pending; the server will retry before releasing reserved capacity.", file=sys.stderr)
        except (APIError, KeyboardInterrupt):
            print("Cleanup will retry automatically on the server.", file=sys.stderr)
        raise


def setup_rclone():
    if not shutil.which("rclone"):
        raise APIError("Install rclone first: brew install rclone")
    config_path = PROJECT_DIR / "wrangler.jsonc"
    if not config_path.is_file():
        raise APIError("Cannot find the project. Set PATRICK_WB_PROJECT to the whiteboard-cf directory.")
    config = request("GET", "/api/uploads/config", timeout=30)["rclone"]
    endpoint, bucket = config["endpoint"], config["bucket"]
    from urllib.parse import urlsplit
    host = urlsplit(endpoint).hostname or ""
    if not endpoint.startswith("https://") or not host.endswith(".r2.cloudflarestorage.com") or bucket != "whiteboard-attachments":
        raise APIError("Unexpected R2 configuration returned by the server.")
    print("Use an R2 Object Read & Write key scoped to whiteboard-attachments.")
    print("The key will be stored in a private local rclone file and Cloudflare Worker Secrets for background cleanup.")
    access_key = getpass.getpass("R2 Access Key ID (hidden): ").strip()
    secret_key = getpass.getpass("R2 Secret Access Key (hidden): ").strip()
    if any(not value or len(value) > 512 or not value.isascii() or any(char.isspace() for char in value) for value in (access_key, secret_key)):
        raise APIError("Invalid R2 credentials.")
    parser = configparser.ConfigParser(interpolation=None)
    parser["wb"] = {"type": "s3", "provider": "Cloudflare", "access_key_id": access_key,
                    "secret_access_key": secret_key, "endpoint": endpoint, "region": "auto"}
    RCLONE_CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    RCLONE_CONFIG.parent.chmod(0o700)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=RCLONE_CONFIG.parent, prefix=".setup-", delete=False) as stream:
            pending = Path(stream.name)
            parser.write(stream)
        pending.chmod(0o600)
        check = subprocess.run(["rclone", "--config", str(pending), "lsf", "wb:" + bucket,
                                "--dirs-only", "--max-depth", "1", "--s3-no-check-bucket",
                                "--contimeout", "10s", "--timeout", "20s", "--retries", "1", "--low-level-retries", "1"],
                               capture_output=True, timeout=45)
        if check.returncode:
            raise APIError("R2 access check failed. Verify the credentials and bucket permissions, then rerun --setup.")
        secrets = json.dumps({"R2_ACCESS_KEY_ID": access_key, "R2_SECRET_ACCESS_KEY": secret_key}).encode()
        result = subprocess.run(["npx", "--no-install", "wrangler", "secret", "bulk", "--config", str(config_path)],
                                input=secrets, cwd=PROJECT_DIR, capture_output=True, timeout=60)
        if result.returncode:
            raise APIError("Worker secret setup failed. Check Wrangler login in the project directory, then rerun --setup.")
        active = False
        for attempt in range(5):
            try:
                active = request("GET", "/api/uploads/config", attempts=1, timeout=10)["rclone"].get("configured", False)
            except APIError:
                active = False
            if active:
                break
            time.sleep(1)
        if not active:
            raise APIError("Worker credentials are not active yet. Rerun --setup after the deployment finishes.")
        pending.replace(RCLONE_CONFIG)
        print("Rclone direct uploads configured. Run: patrick wb -f <file_path>")
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def main(args):
    if args == ["--setup"]:
        setup_rclone()
    elif args == ["list"]:
        show_board()
    elif len(args) == 2 and args[0] == "-f":
        file = upload_file(args[1])
        print(f"{file['name']} uploaded. Expires in 3 days.")
        print(download_url(file))
    elif len(args) == 2 and args[0] == "-t":
        request("PUT", "/api/board", metadata={"text": args[1]}, timeout=30)
        print("Text uploaded. Expires in 24 hours.")
        print(BASE_URL + "/")
    else:
        raise APIError('Usage: patrick wb -t "<text>" | patrick wb -f <file_or_image_path> | patrick wb list | patrick wb --setup')


if __name__ == "__main__":
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        sys.exit("Upload cancelled.")
    except (APIError, OSError, KeyError, TypeError, ValueError) as error:
        sys.exit(str(error))
