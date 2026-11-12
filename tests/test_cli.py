import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location("patrick_wb", Path(__file__).parents[1] / "scripts" / "patrick-wb.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def reply(data, status=200):
    return SimpleNamespace(returncode=0 if status < 400 else 22,
                           stdout=json.dumps(data).encode() + b"\n" + str(status).encode(), stderr=b"")


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "rclone.conf"
        self.config.write_text("[wb]\ntype = s3\n")
        config_patch = patch.object(cli, "RCLONE_CONFIG", self.config)
        config_patch.start()
        self.addCleanup(config_patch.stop)
        binary_patch = patch.object(cli.shutil, "which", return_value="/usr/bin/rclone")
        binary_patch.start()
        self.addCleanup(binary_patch.stop)

    def test_text_json_escaping(self):
        text = 'Text "quoted"\nUnicode: 中文'
        with patch.object(cli.subprocess, "run", return_value=reply({})) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                cli.main(["-t", text])
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"text": text})

    def test_list_shows_images_and_gigabyte_files_in_english(self):
        data = {"text": "all\ntext", "files": [{"id": "file-id", "name": "image.png", "size": 2_000_000_000}]}
        output = io.StringIO()
        with patch.object(cli.subprocess, "run", return_value=reply(data)), contextlib.redirect_stdout(output):
            cli.main(["list"])
        self.assertIn("all\ntext", output.getvalue())
        self.assertIn("image.png (2.00 GB)", output.getvalue())
        self.assertIn("/api/files/file-id/image.png", output.getvalue())

    def test_rejected_metadata_is_not_retried(self):
        with patch.object(cli.subprocess, "run", return_value=reply({"error": "Quota exceeded"}, 413)) as run:
            with self.assertRaisesRegex(cli.APIError, "Quota exceeded"):
                cli.request("POST", "/api/uploads", metadata={})
        self.assertEqual(run.call_count, 1)

    def test_rclone_direct_upload_and_registration(self):
        file = self.root / "image.png"
        file.write_bytes(b"abcde")
        created = {}
        def run(command, **kwargs):
            method = command[command.index("-X") + 1]
            url = command[command.index("-X") + 2]
            self.assertNotEqual(method, "PUT", "File data must never pass through curl/Worker")
            body = json.loads(kwargs.get("input") or b"{}")
            if url.endswith("/api/uploads"):
                created.update(body)
                self.assertEqual(body["mode"], "rclone")
                return reply({"key": "attachments/" + body["id"], "bucket": "whiteboard-attachments"})
            if url.endswith("/complete"):
                self.assertEqual(body["stopToken"], created["stopToken"])
                return reply({"id": created["id"], "name": file.name})
            self.fail("Unexpected request")
        process = MagicMock()
        process.wait.return_value = 0
        with patch.object(cli.subprocess, "run", side_effect=run), patch.object(cli.subprocess, "Popen", return_value=process) as launch, contextlib.redirect_stderr(io.StringIO()):
            result = cli.upload_file(str(file))
        command = launch.call_args.args[0]
        self.assertEqual(command[0], "rclone")
        self.assertIn("wb:whiteboard-attachments/attachments/" + created["id"], command)
        self.assertEqual(command[command.index("--s3-upload-cutoff") + 1], "0")
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        self.assertEqual(result["id"], created["id"])

    def test_interruption_stops_rclone_before_acknowledging_cancellation(self):
        file = self.root / "cancel.bin"
        file.write_bytes(b"abc")
        events, created = [], {}
        def run(command, **kwargs):
            method = command[command.index("-X") + 1]
            url = command[command.index("-X") + 2]
            body = json.loads(kwargs.get("input") or b"{}")
            if url.endswith("/api/uploads"):
                created.update(body)
                return reply({"key":"attachments/"+body["id"],"bucket":"whiteboard-attachments"})
            if method == "GET": return reply({"status":"uploading"})
            if url.endswith("/cancel"):
                events.append("acknowledge")
                self.assertEqual(events[0], "stop")
                self.assertEqual(body["stopToken"], created["stopToken"])
                return reply({"cancelled":True})
            self.fail("Unexpected request")
        process = MagicMock()
        process.wait.side_effect = KeyboardInterrupt()
        process.poll.return_value = None
        def stop(_process):
            events.append("stop")
            process.poll.return_value = 0
        with patch.object(cli.subprocess,"run",side_effect=run), patch.object(cli.subprocess,"Popen",return_value=process), patch.object(cli,"stop_rclone",side_effect=stop):
            with self.assertRaises(KeyboardInterrupt): cli.upload_file(str(file))
        self.assertEqual(events, ["stop", "acknowledge"])

    def test_remote_cancellation_stops_active_rclone(self):
        file = self.root / "cancel.bin"
        file.write_bytes(b"abc")
        def run(command, **kwargs):
            method = command[command.index("-X") + 1]
            url = command[command.index("-X") + 2]
            if url.endswith("/api/uploads"):
                body=json.loads(kwargs["input"])
                return reply({"key":"attachments/"+body["id"],"bucket":"whiteboard-attachments"})
            if method == "GET": return reply({"error":"Upload not found"},404)
            return reply({"cancelled":True})
        process=MagicMock()
        process.wait.side_effect=subprocess.TimeoutExpired("rclone",5)
        process.poll.return_value=None
        def stop(_process): process.poll.return_value=0
        with patch.object(cli.subprocess,"run",side_effect=run), patch.object(cli.subprocess,"Popen",return_value=process), patch.object(cli,"stop_rclone",side_effect=stop) as stop_call:
            with self.assertRaisesRegex(cli.APIError,"cancelled on the board"): cli.upload_file(str(file))
        stop_call.assert_called_once()

    def test_setup_keeps_credentials_out_of_arguments_and_private_on_disk(self):
        project=self.root/'project';project.mkdir();(project/'wrangler.jsonc').write_text('{}')
        config={'rclone':{'configured':True,'endpoint':'https://test.r2.cloudflarestorage.com','bucket':'whiteboard-attachments'}}
        with patch.object(cli,'PROJECT_DIR',project), patch.object(cli,'request',return_value=config), patch.object(cli.getpass,'getpass',side_effect=['test-access-key','test-secret-key']), patch.object(cli.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as run, contextlib.redirect_stdout(io.StringIO()) as output:
            cli.setup_rclone()
        self.assertNotIn('test-secret-key',output.getvalue())
        self.assertIn('secret_access_key = test-secret-key',self.config.read_text())
        self.assertEqual(self.config.stat().st_mode & 0o777,0o600)
        for call in run.call_args_list:
            self.assertNotIn('test-secret-key',' '.join(call.args[0]))
        secrets=json.loads(run.call_args_list[1].kwargs['input'])
        self.assertEqual(secrets['R2_SECRET_ACCESS_KEY'],'test-secret-key')
        self.assertFalse(list(self.root.glob('.setup-*')))

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
