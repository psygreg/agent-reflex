"""Syntax and bug-check helpers for the agent-reflex Hermes plugin.

Ported from the shell ports' scripts/check.sh. Provides find_syntax_errors()
(language parsers) and excerpt_around_edit() (context window around an edit),
used by the post_tool_call hook after a file edit.
"""

from __future__ import annotations

import json
import os
import py_compile
import re
import subprocess
import tempfile
from typing import List, Optional

CONTEXT_LINES = int(os.getenv("AGENT_REFLEX_CONTEXT_LINES", "40"))
MAX_CHARS = int(os.getenv("AGENT_REFLEX_MAX_CHARS", "8000"))

TS_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}

# Command-line syntax checkers: (binary, [args]) with the file path appended.
COMMAND_PARSERS = {
    ".sh": ["bash", ["-n"]],
    ".bash": ["bash", ["-n"]],
    ".zsh": ["zsh", ["-n"]],
    ".py": ["python3", ["-m", "py_compile"]],
    ".rb": ["ruby", ["-c"]],
    ".php": ["php", ["-l"]],
    ".pl": ["perl", ["-c"]],
    ".lua": ["luac", ["-p"]],
    ".go": ["gofmt", ["-e"]],
}


def _run_parser(cmd: str, args: List[str], file_path: str) -> Optional[List[str]]:
    """Run a parser; return its error lines, [] when clean, None when not installed."""
    try:
        proc = subprocess.run(
            [cmd, *args, file_path],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except FileNotFoundError:
        return None
    except Exception as exc:
        return [str(exc)]
    if proc.returncode == 0:
        return []
    output = (proc.stderr or proc.stdout or "").strip().split("\n")
    return output[-5:]


def find_syntax_errors(file_path: str) -> Optional[List[str]]:
    """Return syntax errors, [] when the file parses, None when no parser covers it."""
    ext = os.path.splitext(file_path)[1].lower()

    if ext in TS_EXTENSIONS:
        # Prefer TypeScript's transpileModule when available; else node --check.
        try:
            import typescript  # type: ignore  # noqa: F401  (optional)
        except Exception:
            try:
                proc = subprocess.run(
                    ["node", "--check", file_path],
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                if proc.returncode == 0:
                    return []
                return (proc.stderr or "").strip().split("\n")[-5:]
            except Exception:
                return None
        # TypeScript is importable — use it for accurate diagnostics.
        try:
            import typescript as ts  # type: ignore

            with open(file_path, encoding="utf-8") as fh:
                code = fh.read()
            result = ts.transpileModule(code, fileName=file_path, reportDiagnostics=True)
            diags = getattr(result, "diagnostics", None) or []
            out = []
            for d in diags:
                msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
                out.append(f"line {d.start}: {msg}" if getattr(d, "start", None) else msg)
            return out
        except Exception:
            return None

    if ext == ".json":
        try:
            with open(file_path, encoding="utf-8") as fh:
                json.load(fh)
            return []
        except Exception as exc:
            return [str(exc)]

    parser = COMMAND_PARSERS.get(ext)
    if not parser:
        return None
    cmd, args = parser
    return _run_parser(cmd, args, file_path)


def excerpt_around_edit(content: str, edited: Optional[str]) -> str:
    """Lines around the edited text, or the file start when it cannot be located."""
    fallback = content[:MAX_CHARS]
    if not edited:
        return fallback

    index = content.find(edited)
    if index == -1:
        return fallback

    lines = content.split("\n")
    first = content[:index].count("\n")
    last = first + edited.count("\n")
    lo = max(0, first - CONTEXT_LINES)
    hi = min(len(lines), last + CONTEXT_LINES + 1)
    return "\n".join(lines[lo:hi])[:MAX_CHARS]
