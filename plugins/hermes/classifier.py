"""Shared System One classifier client for the agent-reflex Hermes plugin.

Ported from the OpenCode plugin plugins/opencode/index.ts and the shell ports'
scripts/common.sh. The classifier is a System One decision model asked through
the System One shape (model, state, questions -> answers.q.noul) at
<baseURL>/systemone. Configuration is read from agent-reflex.jsonc in the plugin
root (same option names as the OpenCode plugin: provider / baseURL / model /
apiKey / fallbackModel / debugLog).

Every helper fails open: when the classifier is unavailable, callers get None and
must let the operation proceed. The tool must never block work when the decision
model is down.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# Plugin root: the directory holding this plugin (and agent-reflex.jsonc).
PLUGIN_ROOT = Path(__file__).resolve().parent

# Classifier presets -> default base URL. Mirrors PRESET_BASE_URLS in the
# OpenCode plugin.
PRESET_BASE_URLS = {
    "llamacpp": "http://127.0.0.1:8080/v1",
    "ollama": "http://127.0.0.1:11434/v1",
    "lmstudio": "http://127.0.0.1:1234/v1",
    "typesafe": "https://api.typesafe.ai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "vercel": "https://ai-gateway.vercel.sh/typesafe/v1",
    "opencode": "https://opencode.ai/zen/v1",
}

REQUEST_TIMEOUT_S = float(os.getenv("AGENT_REFLEX_TIMEOUT", "20"))

_config_cache: Optional[dict] = None


def _strip_jsonc(text: str) -> str:
    """Remove // line comments (only when // begins a token) and trailing commas."""
    # Strip comments but keep URLs like https://...
    text = re.sub(r'(^|[^:\"])//.*', r'\1', text, flags=re.M)
    # Strip trailing commas before } or ].
    text = re.sub(r',(\s*[}\]])', r'\1', text)
    return text


def _load_config() -> dict:
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    cfg: dict = {}
    for candidate in (
        PLUGIN_ROOT / "agent-reflex.jsonc",
        PLUGIN_ROOT / "agent-reflex.json",
    ):
        try:
            cfg = json.loads(_strip_jsonc(candidate.read_text(encoding="utf-8")))
            break
        except Exception:
            continue
    _config_cache = cfg if isinstance(cfg, dict) else {}
    return _config_cache


def resolve_env(value: Any) -> Any:
    """Resolve an {env:NAME} placeholder to the environment value."""
    if isinstance(value, str):
        m = re.fullmatch(r"\{env:([A-Za-z_][A-Za-z0-9_]*)\}", value)
        if m:
            return os.getenv(m.group(1), "")
    return value


def config(key: str, default: Any = "") -> Any:
    return _load_config().get(key, default)


def base_url() -> str:
    base = str(config("baseURL", "") or "")
    if base:
        return base.rstrip("/")
    provider = str(config("provider", "") or "")
    return PRESET_BASE_URLS.get(provider, "")


def _ask_model(state: str, question: str, model: str) -> Optional[float]:
    """One System One request. Returns P(YES) in [0, 1] or None on failure."""
    base = base_url()
    if not base or not model:
        return None
    key = resolve_env(config("apiKey", "")) or None

    body = json.dumps(
        {
            "model": model,
            "state": state,
            "questions": {"q": {"type": "noul", "instructions": question}},
        }
    ).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(f"{base}/systemone", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    value = data.get("answers", {}).get("q", {}).get("noul")
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, num))


def ask(state: str, question: str) -> Optional[float]:
    """Ask the classifier, falling back to fallbackModel when the primary rejects."""
    model = str(config("model", "") or "")
    if not model:
        return None

    value = _ask_model(state, question, model)
    if value is not None:
        return value

    fallback = str(config("fallbackModel", "") or "")
    if fallback and fallback != model:
        log(f'classifier model "{model}" unavailable, retrying with "{fallback}"')
        return _ask_model(state, question, fallback)
    return None


def log(message: str) -> None:
    """Append to the debug log when configured (best effort)."""
    path = str(config("debugLog", "") or "")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{message}\n")
    except Exception:
        pass
