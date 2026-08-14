"""Canonical single-rollout fetch API.

GET /api/rollout is the ONE way for other apps (web_chat, auto_eval, agent
skills) to pull a rollout out of the viewer: same viz/ overlay resolution as
the UI, same attribute normalization, grades included. It replaces the
S3-parse+fetch+format code that consumers used to reimplement — and drift
apart on — individually.

Accepts either a full viz link (url=) or file= plus index=/rollout=.
A specific sample is required: file-level URLs are rejected with a pointer to
/api/samples, so no consumer ever "accidentally" processes a whole file.

format=json (default) returns the canonical sample object.
format=plaintext returns a fixed, readable transcript rendering. There is
exactly ONE plaintext format and truncation policy — per-caller formatting
options are deliberately refused so the format can't fork per consumer.

Auth: normal middleware applies — cookie session or Authorization: Bearer
<VIZ_API_TOKEN> (see auth_middleware in backend.main).
"""

import asyncio
import urllib.parse
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

router = APIRouter()

# --- The one plaintext truncation policy ---
_MSG_MAX_CHARS = 6000
_MSG_HEAD_CHARS = 3500
_MSG_TAIL_CHARS = 2000
_EXPLANATION_MAX_CHARS = 500


def _parse_viz_url(url: str) -> Dict[str, Optional[str]]:
    """Extract file/index/rollout/step from a rollout_viz link."""
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(parsed.query)

    def first(key: str) -> Optional[str]:
        values = params.get(key)
        return values[0] if values else None

    if first("share"):
        raise HTTPException(
            status_code=400,
            detail="Share links are not supported here — pass a direct link "
                   "(?file=...&index=...) or file=/index= parameters.",
        )
    return {
        "file": first("file"),
        "index": first("index"),
        "rollout": first("rollout"),
        "step": first("step"),
    }


def _to_int(value: Optional[str], name: str) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be an integer, got {value!r}")


def _select_sample(samples: List[dict], index: Optional[int],
                   rollout: Optional[int], step: Optional[int]) -> int:
    """Mirror the frontend's resolution: index first, rollout(+step) fallback."""
    if index is not None:
        if 0 <= index < len(samples):
            return index
        raise HTTPException(
            status_code=404,
            detail=f"index {index} out of range (file has {len(samples)} samples)",
        )
    if rollout is not None:
        for i, s in enumerate(samples):
            attrs = s.get("attributes", {})
            try:
                if int(attrs.get("rollout_n", -1)) != rollout:
                    continue
            except (TypeError, ValueError):
                continue
            if step is not None:
                try:
                    if int(attrs.get("step", -1)) != step:
                        continue
                except (TypeError, ValueError):
                    continue
            return i
        raise HTTPException(status_code=404, detail=f"no sample with rollout_n={rollout}" +
                            (f" and step={step}" if step is not None else ""))
    raise HTTPException(
        status_code=400,
        detail="A specific sample is required: pass index= or rollout= "
               "(or a link containing them). For whole files use GET /api/samples.",
    )


def _truncate_middle(text: str) -> str:
    if len(text) <= _MSG_MAX_CHARS:
        return text
    elided = len(text) - _MSG_HEAD_CHARS - _MSG_TAIL_CHARS
    return (
        text[:_MSG_HEAD_CHARS]
        + f"\n[... {elided} chars elided ...]\n"
        + text[-_MSG_TAIL_CHARS:]
    )


def _message_blocks(message: dict) -> List[str]:
    """Flatten one message's content into labeled text blocks.

    Handles the shapes producers actually write: plain string content,
    OpenAI-style content lists, content_parts with text/reasoning/thinking,
    and tool_calls. Never raises on malformed shapes — a bad line must not
    make the plaintext format 500 where the JSON format succeeds.
    """
    blocks: List[str] = []

    parts = message.get("content_parts")
    if isinstance(parts, list) and parts:
        for part in parts:
            if not isinstance(part, dict):
                continue
            kind = part.get("type", "text")
            text = part.get("text") or part.get("thinking") or ""
            if not text:
                continue
            text = text if isinstance(text, str) else str(text)
            if kind in ("reasoning", "thinking"):
                blocks.append(f"[reasoning]\n{text}")
            else:
                blocks.append(text)
    else:
        content = message.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("text"):
                    text = part["text"]
                    blocks.append(text if isinstance(text, str) else str(text))
                elif isinstance(part, str):
                    blocks.append(part)
        elif content:
            blocks.append(str(content))

    tool_calls = message.get("tool_calls")
    for call in tool_calls if isinstance(tool_calls, list) else []:
        if not isinstance(call, dict):
            continue
        fn = call.get("function", call)
        if not isinstance(fn, dict):
            fn = {"name": fn}
        name = fn.get("name", "unknown")
        args = fn.get("arguments", "")
        blocks.append(f"[tool_call] {name}({args})")

    return blocks


def _latest_grade_lines(grades: Optional[Dict[str, List[dict]]]) -> List[str]:
    # grades comes straight from the raw JSONL with no normalization — guard
    # every level so a malformed grades field degrades to omission, not a 500.
    if not isinstance(grades, dict) or not grades:
        return []
    lines = ["", "=== Grades (latest per metric) ==="]
    for metric in sorted(grades, key=str):
        entries = grades[metric]
        if not isinstance(entries, list) or not entries:
            continue
        entry = entries[-1]
        if not isinstance(entry, dict):
            continue
        grade = entry.get("grade")
        model = entry.get("model", "?")
        explanation = entry.get("explanation")
        explanation = explanation.strip() if isinstance(explanation, str) else ""
        if len(explanation) > _EXPLANATION_MAX_CHARS:
            explanation = explanation[:_EXPLANATION_MAX_CHARS] + "…"
        lines.append(f"{metric}: {grade} ({model})")
        if explanation:
            lines.append(f"  {explanation}")
    return lines if len(lines) > 2 else []


def _render_plaintext(sample: dict, file_path: str, index: int, total: int) -> str:
    attrs = sample.get("attributes", {})
    header = (
        f"=== Rollout {attrs.get('rollout_n')} — index {index}/{total - 1} ===\n"
        f"file: {file_path}\n"
        f"experiment: {attrs.get('experiment_name')} | reward: {attrs.get('reward')}"
        f" | step: {attrs.get('step')}"
    )
    out = [header]
    for i, message in enumerate(sample.get("messages", [])):
        role = message.get("role", "unknown") if isinstance(message, dict) else "unknown"
        body = "\n\n".join(_message_blocks(message)) if isinstance(message, dict) else str(message)
        out.append(f"\n--- [{i}] {role} ---\n{_truncate_middle(body)}")
    out.extend(_latest_grade_lines(sample.get("grades")))
    return "\n".join(out) + "\n"


@router.get("/api/rollout")
async def get_rollout(
    url: Optional[str] = Query(None, description="Full rollout_viz link (?file=...&index=... / &rollout=...)"),
    file: Optional[str] = Query(None, description="JSONL path (local or s3://bucket/key)"),
    index: Optional[int] = Query(None, description="File-relative sample index (canonical)"),
    rollout: Optional[int] = Query(None, description="attributes.rollout_n (legacy fallback)"),
    step: Optional[int] = Query(None, description="Disambiguates rollout matches"),
    format: str = Query("json", pattern="^(json|plaintext)$"),
) -> Any:
    if url:
        if file or index is not None or rollout is not None:
            raise HTTPException(status_code=400, detail="Pass either url= or file=/index=/rollout=, not both")
        link = _parse_viz_url(url)
        file = link["file"]
        index = _to_int(link["index"], "index")
        rollout = _to_int(link["rollout"], "rollout")
        step = _to_int(link["step"], "step")
    if not file:
        raise HTTPException(status_code=400, detail="file= is required (directly or inside url=)")

    # Imported here, not at module level: backend.main imports this module at
    # its bottom, so a module-level back-import only works when main loads
    # first. A call-time import is order-independent.
    from backend import main

    try:
        data = await asyncio.to_thread(main._load_samples_sync, file)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Could not load {file}: {e}")

    samples = data["samples"]
    picked = _select_sample(samples, index, rollout, step)
    sample = dict(samples[picked])
    # The sample IS its own raw entry here — shipping raw_jsonl_entry would
    # just double the payload.
    sample.pop("raw_jsonl_entry", None)

    if format == "plaintext":
        return PlainTextResponse(
            _render_plaintext(sample, data["file_path"], picked, data["total"])
        )

    return {
        "file": data["file_path"],
        "index": picked,
        "total_in_file": data["total"],
        "experiment_name": data["experiment_name"],
        "has_grades": data["has_grades"],
        "sample": sample,
    }
