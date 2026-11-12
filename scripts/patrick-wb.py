#!/usr/bin/env python3
"""Patrick whiteboard client: text, shared-file lists, and bounded multipart uploads."""
import json
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


class APIError(RuntimeError):
    pass


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
            raise APIError(message)
        time.sleep(0.5 * 2 ** attempt)
    raise APIError("Request failed.")


def format_size(size):
    for divisor, unit in [(1_000_000_000, "GB"), (1_000_000, "MB"), (1000, "KB")]:
        if size >= divisor:
            return f"{size / divisor:.2f} {unit}"
    return f"{size} B"


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
        print(f"   {BASE_URL}/api/files/{quote(item['id'], safe='')}?download")
    if "storage" in board and "limits" in board:
        print(f"\nStorage: {format_size(board['storage']['usedBytes'])} / {format_size(board['limits']['totalBytes'])} (including uploads)")


def upload_file(path):
    file = Path(path).expanduser().resolve()
    # Pasting a path from rich text can accidentally append a non-breaking space.
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
    upload_id = str(uuid.uuid4())
    upload_path = "/api/uploads/" + upload_id
    try:
        session = request("POST", "/api/uploads", metadata={
            "id": upload_id, "name": file.name, "size": initial.st_size,
            "type": mimetypes.guess_type(file.name)[0] or "application/octet-stream",
        })
        if session.get("status") == "ready":
            return session["file"]
        part_size, part_count = session["partSize"], session["partCount"]
        if not isinstance(part_size, int) or not 0 < part_size <= 32 * 1024 * 1024:
            raise APIError("Unexpected upload part size.")
        if part_count != (initial.st_size + part_size - 1) // part_size:
            raise APIError("Unexpected upload part count.")
        uploaded = 0
        with file.open("rb") as source:
            for number in range(1, part_count + 1):
                expected = min(part_size, initial.st_size - uploaded)
                chunk = source.read(expected)
                if len(chunk) != expected:
                    raise APIError("The file changed during upload. Please retry.")
                print(f"Uploading {file.name}: part {number}/{part_count} ({uploaded / initial.st_size:.0%})", file=sys.stderr, flush=True)
                request("PUT", f"{upload_path}/parts/{number}", data=chunk)
                uploaded += len(chunk)
                del chunk
        current = file.stat()
        if current.st_size != initial.st_size or current.st_mtime_ns != initial.st_mtime_ns:
            raise APIError("The file changed during upload. Please retry.")
        print("Upload complete. Finalizing shared file...", file=sys.stderr, flush=True)
        return request("POST", upload_path + "/complete")
    except BaseException:
        # Completion may have succeeded even if the response was lost.
        try:
            status = request("GET", upload_path, attempts=1, timeout=15)
            if status.get("status") == "ready":
                return status["file"]
        except (APIError, KeyboardInterrupt):
            pass
        try:
            request("DELETE", upload_path, attempts=2, timeout=15)
        except (APIError, KeyboardInterrupt):
            print("Cleanup will retry automatically on the server.", file=sys.stderr)
        raise


def main(args):
    if args == ["--get"]:
        show_board()
    elif len(args) == 2 and args[0] == "-f":
        file = upload_file(args[1])
        print(f"{file['name']} uploaded. Expires in 3 days.")
        print(f"{BASE_URL}/api/files/{quote(file['id'], safe='')}?download")
    elif len(args) == 1 and args[0] != "-f":
        request("PUT", "/api/board", metadata={"text": args[0]}, timeout=30)
        print("Text uploaded. Expires in 24 hours.")
        print(BASE_URL + "/")
    else:
        raise APIError('Usage: patrick wb "text..." | patrick wb -f <path> | patrick wb --get')


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
