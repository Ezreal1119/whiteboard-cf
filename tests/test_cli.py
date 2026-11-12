import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("patrick_wb", Path(__file__).parents[1] / "scripts" / "patrick-wb.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def reply(data, status=200):
    return SimpleNamespace(returncode=0 if status < 400 else 22,
                           stdout=json.dumps(data).encode() + b"\n" + str(status).encode(), stderr=b"")


class CLITests(unittest.TestCase):
    def test_text_json_escaping(self):
        text = 'Text "quoted"\nUnicode: 中文'
        with patch.object(cli.subprocess, "run", return_value=reply({})) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                cli.main([text])
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"text": text})

    def test_get_lists_images_and_gigabyte_files_in_english(self):
        data = {"text": "all\ntext", "files": [{"id": "file-id", "name": "image.png", "size": 2_000_000_000}]}
        output = io.StringIO()
        with patch.object(cli.subprocess, "run", return_value=reply(data)), contextlib.redirect_stdout(output):
            cli.main(["--get"])
        self.assertIn("all\ntext", output.getvalue())
        self.assertIn("image.png (2.00 GB)", output.getvalue())
        self.assertIn("/api/files/file-id?download", output.getvalue())

    def test_rejected_metadata_is_not_retried(self):
        with patch.object(cli.subprocess, "run", return_value=reply({"error": "Quota exceeded"}, 413)) as run:
            with self.assertRaisesRegex(cli.APIError, "Quota exceeded"):
                cli.request("POST", "/api/uploads", metadata={})
        self.assertEqual(run.call_count, 1)

    def test_file_chunks_retry_and_complete(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "image.png"
            file.write_bytes(b"abcde")
            chunks, attempts = [], []

            def run(command, **kwargs):
                method = command[command.index("-X") + 1]
                url = command[command.index("-X") + 2]
                if method == "POST" and url.endswith("/api/uploads"):
                    metadata = json.loads(kwargs["input"])
                    self.assertEqual(metadata["size"], 5)
                    self.assertEqual(metadata["type"], "image/png")
                    return reply({"partSize": 2, "partCount": 3})
                if method == "PUT":
                    attempts.append(kwargs["input"])
                    if len(attempts) == 1:
                        return reply({"error": "Transient failure"}, 503)
                    chunks.append(kwargs["input"])
                    return reply({})
                if url.endswith("/complete"):
                    return reply({"id": "file-id", "name": file.name})
                self.fail(f"Unexpected request: {method} {url}")

            with patch.object(cli.subprocess, "run", side_effect=run), patch.object(cli.time, "sleep"), contextlib.redirect_stderr(io.StringIO()):
                result = cli.upload_file(str(file))
            self.assertEqual(chunks, [b"ab", b"cd", b"e"])
            self.assertEqual(attempts[:2], [b"ab", b"ab"])
            self.assertEqual(result["id"], "file-id")

    def test_interruption_cancels_reservation(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "cancel.bin"
            file.write_bytes(b"abc")
            methods = []

            def run(command, **kwargs):
                method = command[command.index("-X") + 1]
                methods.append(method)
                if method == "POST":
                    return reply({"partSize": 3, "partCount": 1})
                if method == "PUT":
                    raise KeyboardInterrupt()
                if method == "GET":
                    return reply({"status": "uploading"})
                return reply({"cancelled": True})

            with patch.object(cli.subprocess, "run", side_effect=run), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    cli.upload_file(str(file))
            self.assertEqual(methods, ["POST", "PUT", "GET", "DELETE"])

    def test_files_above_3_gb_rejected_before_network(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "oversize.bin"
            with file.open("wb") as stream:
                stream.truncate(3_000_000_001)
            with patch.object(cli.subprocess, "run") as run:
                with self.assertRaisesRegex(cli.APIError, "3 GB"):
                    cli.upload_file(str(file))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
