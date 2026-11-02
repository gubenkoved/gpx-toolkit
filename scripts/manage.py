#!/usr/bin/env python3
"""GPX Toolkit's development entrypoint; Python standard library only.

Run from any directory. npm scripts define the tool commands; this launcher
provides the local workflow and the full, non-mutating CI gate.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*command: str, env: dict[str, str] | None = None) -> None:
    print(f"\n$ {shlex.join(command)}", flush=True)
    started = time.monotonic()
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    print(f"Passed in {time.monotonic() - started:.1f}s", flush=True)


def npm(*args: str, env: dict[str, str] | None = None) -> None:
    executable = shutil.which("npm")
    if not executable or not shutil.which("node"):
        raise FileNotFoundError(
            "Node.js 20+ and npm are required; install them first."
        )
    if args[0] != "ci" and not (ROOT / "node_modules").is_dir():
        raise FileNotFoundError(
            "Dependencies missing. Run: python3 scripts/manage.py setup"
        )
    run(executable, *args, env=env)


def launcher_tests() -> None:
    run(
        sys.executable, "-B", "-m", "unittest", "discover",
        "-s", "scripts", "-p", "test_*.py",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("setup", help="install locked dependencies (npm ci)")
    dev = commands.add_parser("dev", help="start Vite")
    dev.add_argument(
        "--proxy", action="store_true", help="enable the Beeline GPX dev proxy"
    )
    dev.add_argument(
        "args", nargs=argparse.REMAINDER, help="Vite options after --"
    )
    lint = commands.add_parser("lint", help="lint; --fix applies safe fixes")
    lint.add_argument("--fix", action="store_true")
    fmt = commands.add_parser(
        "format", aliases=["fmt"], help="format code; --check only checks"
    )
    fmt.add_argument("--check", action="store_true")
    commands.add_parser("fix", help="apply safe lint fixes and formatting")
    commands.add_parser("typecheck", help="check TypeScript types")
    test = commands.add_parser("test", help="test the launcher and app")
    test.add_argument("--watch", action="store_true", help="watch app tests")
    test.add_argument(
        "args", nargs=argparse.REMAINDER, help="Vitest options after --"
    )
    commands.add_parser("build", help="type-check and build for production")
    preview = commands.add_parser("preview", help="serve the production build")
    preview.add_argument(
        "args", nargs=argparse.REMAINDER, help="Vite options after --"
    )
    commands.add_parser("gen-icons", help="regenerate app icons")
    commands.add_parser(
        "check",
        help="full gate: launcher/app tests, types, lint, format and build",
    )
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    extra = getattr(args, "args", [])
    if extra[:1] == ["--"]:
        extra = extra[1:]
    try:
        if args.command == "setup":
            npm("ci")
        elif args.command == "check":
            launcher_tests()
            npm("run", "verify")
            npm("run", "build")
            print("\nAll quality gates passed.", flush=True)
        elif args.command == "dev":
            env = None
            if args.proxy:
                env = {**os.environ, "BEELINE_DEV_PROXY": "1"}
            npm("run", "dev", "--", *extra, env=env)
        elif args.command == "test":
            launcher_tests()
            npm("run", "test:watch" if args.watch else "test", "--", *extra)
        elif args.command == "lint":
            npm("run", "lint", *(["--", "--write"] if args.fix else []))
        elif args.command in {"format", "fmt"}:
            npm("run", "format:check" if args.check else "format")
        elif args.command == "fix":
            npm("run", "check:fix")
        elif args.command == "preview":
            npm("run", "preview", "--", *extra)
        else:
            npm("run", args.command)
    except subprocess.CalledProcessError as exc:
        print(
            f"\nFailed (exit {exc.returncode}): {shlex.join(exc.cmd)}",
            file=sys.stderr,
        )
        return exc.returncode if exc.returncode > 0 else 128 - exc.returncode
    except OSError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
