"""agent-reflex Hermes plugin — System One guardrail and checks.

Ports the agent-reflex OpenCode plugin (plugins/opencode/index.ts) to Hermes.
Unlike the shell ports (Claude Code, Codex), Hermes hooks cannot block a tool
call, so the shell guardrail is delivered as a safe_run command-execution
wrapper that scores a command before it runs and either blocks it (returns an
error) or delegates to Hermes's built-in terminal tool via ctx.dispatch_tool.

Registered in register(ctx):
- safe_run tool: guardrail wrapper around shell command execution.
- post_tool_call hook: syntax + bug check after file edits.
- pre_llm_call hook: complexity classification + confidence suggestion.
- /confidence command and confidence_check tool: on-demand confidence scoring.

Classifier-driven per-request effort and history pruning stay OpenCode-only: no
Hermes hook can rewrite the model request or return a pruned message list.
"""

from __future__ import annotations

import json
import re
from typing import Any

import classifier
import syntax

CONFIDENCE_TOOL = "confidence_check"
GUARD_THRESHOLD = 0.75
SEMANTIC_CHECK_CONFIDENCE = 0.75
EDIT_TOOLS = {"patch", "write_file", "edit_file", "edit", "write"}


# ---------------------------------------------------------------------------
# Complexity classification (mirrors classifyComplexity in the OpenCode plugin).
# ---------------------------------------------------------------------------
def classify_complexity(score: float) -> str:
    if score > 0.80:
        return "high"
    if score > 0.50:
        return "medium"
    return "simple"


def _session_state_dir() -> str:
    import os
    import tempfile

    d = os.path.join(tempfile.gettempdir(), "agent-reflex-hermes")
    os.makedirs(d, exist_ok=True)
    return d


def _save_level(session_id: str, level: str) -> None:
    import os

    try:
        with open(os.path.join(_session_state_dir(), f"level-{session_id or 'default'}"), "w") as fh:
            fh.write(level)
    except Exception:
        pass


def _load_level(session_id: str) -> str:
    import os

    try:
        with open(os.path.join(_session_state_dir(), f"level-{session_id or 'default'}")) as fh:
            return fh.read().strip()
    except Exception:
        return "simple"


# ---------------------------------------------------------------------------
# safe_run tool — the command-execution wrapper guardrail.
# ---------------------------------------------------------------------------
SAFE_RUN_SCHEMA = {
    "name": "safe_run",
    "description": (
        "Run a shell command after a safety check. Prefer this over the plain terminal "
        "tool for shell commands: it scores the command for damage potential first and "
        "blocks dangerous ones before they execute. Returns the command output on success, "
        "or an error when the guardrail blocks it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to execute.",
            }
        },
        "required": ["command"],
        "additionalProperties": False,
    },
}


def _score_command(command: str) -> float | None:
    state = f"Command to be executed in terminal: {command}"
    question = (
        "Determine if this command may damage system files, remove directories "
        "without backup or leak environment keys."
    )
    return classifier.ask(state, question)


def handle_safe_run(args: dict, **kwargs: Any) -> str:
    """Score the command, then block it or delegate to the terminal tool."""
    command = (args or {}).get("command", "")
    if not command:
        return json.dumps({"error": "No command provided."})

    score = _score_command(command)
    classifier.log(f"guard command={command[:200]!r} score={score}")

    if score is not None and score > GUARD_THRESHOLD:
        return json.dumps(
            {
                "error": "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted.",
                "blocked": True,
                "score": score,
            }
        )

    # Classifier unavailable (score None) or safe (<= threshold): run it.
    dispatch = kwargs.get("ctx_dispatch_tool")
    if callable(dispatch):
        try:
            return dispatch("terminal", {"command": command})
        except Exception as exc:
            return json.dumps({"error": f"Failed to run command: {exc}"})

    # No dispatch bridge available: report that we could not execute.
    return json.dumps(
        {
            "error": (
                "safe_run could not reach the terminal tool. Enable the terminal "
                "toolset, or run the command directly."
            )
        }
    )


# ---------------------------------------------------------------------------
# post_tool_call hook — syntax + bug check after file edits.
# ---------------------------------------------------------------------------
def _check_file(file_path: str, edited: str | None, session_id: str) -> list[str]:
    notes: list[str] = []
    errors = syntax.find_syntax_errors(file_path)

    if errors:
        notes.append(
            f"[Syntax check]: {file_path} has {len(errors)} syntax error(s). "
            "Fix them before continuing:\n" + "\n".join(f"- {e}" for e in errors)
        )
        return notes

    level = _load_level(session_id)
    if level in ("medium", "high"):
        try:
            with open(file_path, encoding="utf-8") as fh:
                content = fh.read()
        except Exception:
            content = ""
        excerpt = syntax.excerpt_around_edit(content, edited)
        state = (
            f"Excerpt of edited file {file_path}. It contains only the edited code plus "
            f"{syntax.CONTEXT_LINES} lines on each side, so code outside it is not shown:\n{excerpt}"
        )
        question = (
            "Does this code contain a bug that would prevent it from running or produce "
            "a wrong result? Judge only the visible excerpt; do not assume bugs in code "
            "that is not shown."
        )
        bug = classifier.ask(state, question)
        if bug is not None:
            correctness = 1.0 - bug
            if correctness < SEMANTIC_CHECK_CONFIDENCE:
                pct = int(correctness * 100)
                thr = int(SEMANTIC_CHECK_CONFIDENCE * 100)
                notes.append(
                    f"[System One check]: The edit to {file_path} is only {pct}% "
                    f"confident to be correct (threshold {thr}%). Review it before continuing."
                )
    return notes


def _extract_edited_files(tool_name: str, args: dict) -> list[tuple[str, str | None]]:
    """Return (file_path, edited_text) pairs a file-edit tool touched."""
    if not isinstance(args, dict):
        return []

    # Direct file_path forms (write_file, edit_file, etc.).
    for key in ("file_path", "filePath", "path", "filename"):
        if args.get(key):
            edited = args.get("new_string") or args.get("content") or args.get("newString")
            return [(str(args[key]), edited if isinstance(edited, str) else None)]

    # patch form: a unified/V4A diff in args["patch"] or args["command"].
    patch = args.get("patch") or (args.get("command") if tool_name == "patch" else None)
    if isinstance(patch, str) and patch:
        files: list[tuple[str, str | None]] = []
        # V4A headers: *** Add/Update File: <path>
        for m in re.finditer(r"^\*\*\* (?:Add|Update) File: (.+)$", patch, flags=re.M):
            files.append((m.group(1).strip(), None))
        # Unified diff headers: +++ b/<path>
        if not files:
            for m in re.finditer(r"^\+\+\+ b/(.+)$", patch, flags=re.M):
                files.append((m.group(1).strip(), None))
        return files

    return []


def on_post_tool_call(tool_name: str, args: dict, result: str, task_id: str = "", **kwargs: Any) -> None:
    if tool_name not in EDIT_TOOLS:
        return
    try:
        edited_files = _extract_edited_files(tool_name, args or {})
        all_notes: list[str] = []
        for file_path, edited in edited_files:
            if not file_path or not _path_exists(file_path):
                continue
            all_notes.extend(_check_file(file_path, edited, task_id))
        if all_notes:
            message = "\n\n".join(all_notes)
            print(f"[agent-reflex] {message}")
            inject = kwargs.get("ctx_inject_message")
            if callable(inject):
                try:
                    inject(message, role="system")
                except Exception:
                    pass
    except Exception as exc:
        classifier.log(f"post_tool_call error: {exc}")


def _path_exists(path: str) -> bool:
    import os

    return os.path.isfile(path)


# ---------------------------------------------------------------------------
# pre_llm_call hook — complexity classification + confidence suggestion.
# ---------------------------------------------------------------------------
def on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    conversation_history: list | None = None,
    is_first_turn: bool = False,
    model: str = "",
    platform: str = "",
    **kwargs: Any,
):
    if not user_message:
        return None
    state = f"User prompt: {user_message}"
    question = (
        "Does this prompt require deep logic thinking, complex algorithms or "
        "mathematical/concurrence bugs?"
    )
    score = classifier.ask(state, question)
    if score is None:
        return None

    level = classify_complexity(score)
    _save_level(session_id, level)
    classifier.log(f"classify score={score} level={level}")

    if level == "simple":
        return None

    pct = int(score * 100)
    return {
        "context": (
            f"This is a {level} complexity task ({pct}%). Before committing to a "
            f"solution, consider calling the {CONFIDENCE_TOOL} tool with your current "
            "plan and follow its verdict."
        )
    }


# ---------------------------------------------------------------------------
# confidence_check tool + /confidence command.
# ---------------------------------------------------------------------------
CONFIDENCE_SCHEMA = {
    "name": CONFIDENCE_TOOL,
    "description": (
        "Ask System One to evaluate your current line of thought before you commit to "
        "it. Pass your reasoning so far, or your draft solution. Returns a confidence "
        "score and a verdict. If the verdict is RESTART, discard that line of thought "
        "and solve the problem again more directly."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "Your current line of thought or draft solution to evaluate.",
            }
        },
        "required": ["thought"],
        "additionalProperties": False,
    },
}


def _confidence_verdict(thought: str, session_id: str = "") -> str:
    thought = (thought or "").strip()
    if not thought:
        return json.dumps({"error": "No thought provided. Pass your current reasoning in `thought`."})

    level = _load_level(session_id)
    threshold = 0.75 if level == "simple" else 0.85

    state = f"AI line of thought:\n{thought}"
    question = (
        "Does this line of thought seem direct, correct and without hesitation or "
        "redundant loops?"
    )
    confidence = classifier.ask(state, question)
    if confidence is None:
        return json.dumps(
            {
                "verdict": "CONTINUE",
                "message": "System One confidence check unavailable. Continue with your current approach.",
            }
        )

    pct = round(confidence * 100, 1)
    if confidence < threshold:
        return json.dumps(
            {
                "verdict": "RESTART",
                "confidence": pct,
                "threshold": threshold * 100,
                "message": (
                    f"Confidence {pct}% is below the {threshold * 100}% threshold. "
                    "Verdict: RESTART. Discard this line of thought and solve the problem "
                    "again, focusing on the cleanest, most direct solution."
                ),
            }
        )
    return json.dumps(
        {
            "verdict": "CONTINUE",
            "confidence": pct,
            "threshold": threshold * 100,
            "message": f"Confidence {pct}%. Verdict: CONTINUE.",
        }
    )


def handle_confidence_check(args: dict, **kwargs: Any) -> str:
    thought = (args or {}).get("thought", "")
    return _confidence_verdict(thought)


# ---------------------------------------------------------------------------
# Registration.
# ---------------------------------------------------------------------------
def register(ctx) -> None:
    """Wire tools, hooks, and the /confidence command."""

    # Bridge so safe_run can delegate to the built-in terminal tool.
    def _dispatch(tool_name: str, tool_args: dict) -> str:
        return ctx.dispatch_tool(tool_name, tool_args)

    def safe_run_handler(args: dict, **kwargs: Any) -> str:
        return handle_safe_run(args, ctx_dispatch_tool=_dispatch, **kwargs)

    ctx.register_tool(
        name="safe_run",
        toolset="agent_reflex",
        schema=SAFE_RUN_SCHEMA,
        handler=safe_run_handler,
        description="Run a shell command after a System One safety check; blocks dangerous ones.",
    )

    ctx.register_tool(
        name=CONFIDENCE_TOOL,
        toolset="agent_reflex",
        schema=CONFIDENCE_SCHEMA,
        handler=handle_confidence_check,
        description="Evaluate your current line of thought and return CONTINUE or RESTART.",
    )

    # Guardrail is delivered via the safe_run tool (hooks cannot block), but we
    # still log/warn on raw terminal calls that bypass it.
    def pre_tool_warning(tool_name: str, args: dict, task_id: str = "", **kwargs: Any) -> None:
        if tool_name == "terminal":
            command = (args or {}).get("command", "")
            if command:
                print(
                    "[agent-reflex] Note: this command ran via the plain terminal tool, "
                    "not the guarded safe_run tool. Use safe_run to have commands scored "
                    "and blocked when dangerous."
                )

    ctx.register_hook("pre_tool_call", pre_tool_warning)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("pre_llm_call", on_pre_llm_call)

    # /confidence slash command: /confidence <thought>
    def confidence_command(args: str = "", **kwargs: Any) -> None:
        verdict = _confidence_verdict(args)
        print(f"[agent-reflex] {json.loads(verdict).get('message', verdict)}")

    ctx.register_command("confidence", confidence_command, "Evaluate your current line of thought (CONTINUE/RESTART)")
