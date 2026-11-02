"""Check launcher failures and process boundaries without Node tools."""

import contextlib
import io
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import call, patch

import manage


class ManageTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def test_check_stops_on_failure_and_preserves_exit_code(self):
        for stage in range(3):
            with self.subTest(stage=stage), patch.object(manage, "run") as run:
                error = subprocess.CalledProcessError(7, ["tool"])
                run.side_effect = [None] * stage + [error]
                with (
                    patch.object(manage.shutil, "which", return_value="npm"),
                    patch.object(Path, "is_dir", return_value=True),
                ):
                    self.assertEqual(manage.main(["check"]), 7)
                self.assertEqual(run.call_count, stage + 1)

    def test_check_includes_launcher_verify_and_build(self):
        with (
            patch.object(manage, "launcher_tests") as tests,
            patch.object(manage, "npm") as npm,
        ):
            self.assertEqual(manage.main(["check"]), 0)
        tests.assert_called_once_with()
        self.assertEqual(
            npm.call_args_list, [call("run", "verify"), call("run", "build")]
        )

    def test_proxy_and_server_arguments_preserve_environment(self):
        original_proxy = os.environ.get("BEELINE_DEV_PROXY")
        options = ["--host", "127.0.0.1", "--port", "5187"]
        with (
            patch.dict(os.environ, {"MANAGE_TEST": "kept"}),
            patch.object(manage, "npm") as npm,
        ):
            argv = ["dev", "--proxy", "--", *options]
            self.assertEqual(manage.main(argv), 0)
        self.assertEqual(npm.call_args.args, ("run", "dev", "--", *options))
        self.assertEqual(npm.call_args.kwargs["env"]["BEELINE_DEV_PROXY"], "1")
        self.assertEqual(npm.call_args.kwargs["env"]["MANAGE_TEST"], "kept")
        self.assertEqual(os.environ.get("BEELINE_DEV_PROXY"), original_proxy)

    def test_read_only_and_fix_commands(self):
        for argv, script, extra in [
            (["lint"], "lint", ()),
            (["lint", "--fix"], "lint", ("--", "--write")),
            (["format", "--check"], "format:check", ()),
            (["fmt"], "format", ()),
            (["fix"], "check:fix", ()),
        ]:
            with self.subTest(argv=argv), patch.object(manage, "npm") as npm:
                self.assertEqual(manage.main(argv), 0)
                npm.assert_called_once_with("run", script, *extra)

    def test_test_watch_forwards_filters(self):
        with (
            patch.object(manage, "launcher_tests"),
            patch.object(manage, "npm") as npm,
        ):
            argv = ["test", "--watch", "--", "tests/format.test.ts"]
            self.assertEqual(manage.main(argv), 0)
        npm.assert_called_once_with(
            "run", "test:watch", "--", "tests/format.test.ts"
        )

    def test_child_always_runs_at_repository_root(self):
        with patch.object(manage.subprocess, "run") as run:
            manage.run("node", "some path/file.mjs")
        run.assert_called_once_with(
            ("node", "some path/file.mjs"),
            cwd=manage.ROOT, env=None, check=True,
        )

    def test_missing_tools_and_dependencies_do_not_install_implicitly(self):
        with (
            patch.object(manage.shutil, "which", return_value=None),
            patch.object(manage, "run") as run,
        ):
            self.assertEqual(manage.main(["typecheck"]), 2)
            run.assert_not_called()
        with (
            patch.object(manage.shutil, "which", return_value="npm"),
            patch.object(Path, "is_dir", return_value=False),
            patch.object(manage, "run") as run,
        ):
            self.assertEqual(manage.main(["typecheck"]), 2)
            run.assert_not_called()
            self.assertEqual(manage.main(["setup"]), 0)
            run.assert_called_once_with("npm", "ci", env=None)

    def test_interrupt_and_signal_exit_codes(self):
        cases = [
            (KeyboardInterrupt(), 130),
            (subprocess.CalledProcessError(-15, ["npm"]), 143),
        ]
        for error, code in cases:
            with (
                self.subTest(code=code),
                patch.object(manage, "npm", side_effect=error),
            ):
                self.assertEqual(manage.main(["dev"]), code)

    def test_help_works_outside_repository_without_node(self):
        result = subprocess.run(
            [sys.executable, "-B", str(manage.ROOT / "scripts" / "manage.py")],
            cwd=manage.ROOT.parent,
            env={**os.environ, "PATH": ""},
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("full gate", result.stdout)

    def test_unknown_command_is_rejected(self):
        with self.assertRaises(SystemExit) as error:
            manage.main(["typo"])
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
