"""Library landing-page API.

GET /api/library renders the corpus index for the viewer's landing page:
every kind of artifact we store (evals, training runs, chats, agent sessions,
probes, debug traces) grouped with recency, counts, and graded badges.

Hard constraints (from the design review): the index is derived from S3
LISTING ONLY — no crawler, no daemon, no persistent index, and no per-file
HEAD/GET calls. One listing pass over the known prefixes, cached in-process
with a 120s TTL. Grade badges come from the same listing: a file is graded iff
its viz/ sidecar key (dirname/viz/basename) appeared in the listing.

GET /api/library/preview does the lazy per-card enrichment: a single ranged
GET of the first 32KB of one file, parsing the first complete JSONL line.
Any failure degrades to {"available": false} — never a 5xx. Separate 300s TTL
cache so hovering/scrolling the landing page cannot hammer S3.

Auth: normal middleware applies — cookie session or Authorization: Bearer
<VIZ_API_TOKEN> (see auth_middleware in backend.main). Neither endpoint is
auth-exempt.
"""

import asyncio
import posixpath
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import orjson
from fastapi import APIRouter, Query

router = APIRouter()

# Kind -> (title, source prefixes, grouping depth in path segments under the
# prefix). Chats have two source prefixes; their groups merge by date segment.
_KIND_SPECS: List[Tuple[str, str, Tuple[str, ...], int]] = [
    ("evals", "Evals", ("logs_jsonl/auto_eval/",), 1),
    ("training_runs", "Training runs", ("logs_jsonl/rollout_traces_tinker/",), 2),
    ("chats", "Chats", ("logs_jsonl/chats/", "logs_jsonl/online_chats/"), 1),
    # Root-level prefixes are the LEGACY locations (historical files stay put
    # — links point at paths); viz_writer.dest_for routes new writes under
    # logs_jsonl/. Groups merge across both, like the two chat prefixes.
    ("agent_sessions", "Agent sessions", ("cli_sessions/", "logs_jsonl/cli_sessions/"), 1),
    ("probes", "Probes", ("target_probes/", "logs_jsonl/target_probes/"), 1),
    ("debug_traces", "Debug traces", ("debug_traces/", "logs_jsonl/debug_traces/"), 1),
]

_DEFAULT_BUCKET = "rewardseeker"
_GROUP_CAP = 50
_FILE_CAP = 60

# Long TTL + stale-while-revalidate: a cold scan of the real bucket takes
# ~90s (auto_eval alone is ~390k keys), so past-TTL requests serve the stale
# copy instantly while ONE background rescan refreshes it.
_LIBRARY_TTL = 900.0  # seconds
_PREVIEW_TTL = 300.0  # seconds
# auto_eval orchestrator transcripts routinely exceed 32KB on their FIRST
# line — 256KB keeps previews working there while still being one cheap GET.
_PREVIEW_RANGE_BYTES = 256 * 1024
_PREVIEW_USER_MSG_MAX = 240
_PREVIEW_CACHE_MAX = 2000  # FIFO cap; entries are tiny dicts

# Indirection so tests can control the clock (monkeypatch backend.library_api._now)
_now = time.monotonic

# (inserted_at_monotonic, kinds_payload, generated_at_iso)
_library_cache: Optional[Tuple[float, List[dict], str]] = None
# Single-flight guard: (event_loop, task) of the scan currently in progress.
# Cold scans of the real bucket take tens of seconds; concurrent landing-page
# hits piggyback on the in-flight scan instead of each listing 400k keys.
# Keyed by loop identity so test event loops never share a task.
_inflight_scan: Optional[Tuple[Any, "asyncio.Task"]] = None
# file param -> (inserted_at_monotonic, payload)
_preview_cache: Dict[str, Tuple[float, dict]] = {}

_WHITESPACE_RE = re.compile(r"\s+")


def _clear_library_cache() -> None:
    """Clear both the library index cache and the preview cache. Used by tests."""
    global _library_cache, _inflight_scan
    _library_cache = None
    _inflight_scan = None
    _preview_cache.clear()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Listing + grouping
# ---------------------------------------------------------------------------

# Parallel sub-prefix listings. Pagination within ONE prefix is inherently
# sequential (continuation tokens), and logs_jsonl/auto_eval/ alone holds
# ~390k keys — ~390 sequential pages ≈ 87s. Splitting each kind prefix into
# its top-level sub-prefixes (one cheap Delimiter listing) lets those paginate
# concurrently: same result set, ~10x faster cold scans.
_SCAN_WORKERS = 24  # just under the shared client's 25-connection pool


def _scan_bucket(bucket: str) -> List[Dict[str, Any]]:
    """One listing pass: LIST over each known prefix, parallelized across the
    prefix's top-level sub-directories. No HEAD/GET.

    Returns raw object dicts: {"key", "size", "last_modified" (datetime)}.
    Runs in a worker thread (boto3 clients are thread-safe).
    """
    from concurrent.futures import ThreadPoolExecutor

    from backend import main  # call-time import, see module docstring in fetch_api

    s3_client = main._get_s3_client()

    def _obj(obj: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "key": obj["Key"],
            "size": obj["Size"],
            "last_modified": obj["LastModified"],
        }

    # Pass 1 (sequential, one Delimiter page-set per kind prefix): collect
    # root-level files and the sub-prefixes to fan out over.
    objects: List[Dict[str, Any]] = []
    sub_prefixes: List[str] = []
    seen_prefixes: set = set()
    for _, _, prefixes, _ in _KIND_SPECS:
        for prefix in prefixes:
            if prefix in seen_prefixes:  # defensive: never list a prefix twice
                continue
            seen_prefixes.add(prefix)
            paginator = s3_client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
                for obj in page.get("Contents", []):
                    objects.append(_obj(obj))
                for cp in page.get("CommonPrefixes", []):
                    sub_prefixes.append(cp["Prefix"])

    # Pass 2 (parallel): fully paginate each sub-prefix.
    def _list_sub(sub: str) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=sub):
            for obj in page.get("Contents", []):
                out.append(_obj(obj))
        return out

    if sub_prefixes:
        with ThreadPoolExecutor(max_workers=min(_SCAN_WORKERS, len(sub_prefixes))) as pool:
            for chunk in pool.map(_list_sub, sub_prefixes):
                objects.extend(chunk)
    return objects


def _is_viz_sidecar(key: str) -> bool:
    """True when 'viz' appears as a directory segment — grade sidecars."""
    return "viz" in key.split("/")[:-1]


def _build_kinds(bucket: str, objects: List[Dict[str, Any]]) -> List[dict]:
    """Pure grouping: raw listed objects -> the kinds payload of the contract.

    Only .jsonl keys outside viz/ segments are loadable files. graded flags are
    computed against the set of keys that WERE listed under viz/ segments, so
    the whole payload costs zero S3 calls beyond the listing itself.
    """
    viz_keys = {o["key"] for o in objects if _is_viz_sidecar(o["key"])}
    kinds_out: List[dict] = []

    for kind, title, prefixes, depth in _KIND_SPECS:
        groups: Dict[str, dict] = {}

        for obj in objects:
            key = obj["key"]
            if not key.endswith(".jsonl") or _is_viz_sidecar(key):
                continue
            src_prefix = next((p for p in prefixes if key.startswith(p)), None)
            if src_prefix is None:
                continue
            segments = [s for s in key[len(src_prefix):].split("/") if s]
            if not segments:
                continue

            if len(segments) == 1:
                # A file directly under the prefix is its own group.
                group_name = segments[0]
                group_prefix = f"s3://{bucket}/{key}"
                file_name = segments[0]
            else:
                group_depth = min(depth, len(segments) - 1)
                group_name = "/".join(segments[:group_depth])
                group_prefix = f"s3://{bucket}/{src_prefix}{group_name}/"
                file_name = "/".join(segments[group_depth:])

            graded = (
                posixpath.dirname(key) + "/viz/" + posixpath.basename(key)
            ) in viz_keys
            last_modified = obj["last_modified"]

            group = groups.get(group_name)
            if group is None:
                group = groups[group_name] = {
                    "name": group_name,
                    "prefix": group_prefix,
                    "_lm": last_modified,
                    "file_count": 0,
                    "total_bytes": 0,
                    "graded": False,
                    "files": [],
                }
            group["file_count"] += 1
            group["total_bytes"] += obj["size"]
            group["graded"] = group["graded"] or graded
            if last_modified > group["_lm"]:
                group["_lm"] = last_modified
                # Chats groups can merge across two source prefixes; the
                # group's prefix follows its most recent file.
                group["prefix"] = group_prefix
            group["files"].append({
                "path": f"s3://{bucket}/{key}",
                "name": file_name,
                "size": obj["size"],
                "last_modified": last_modified.isoformat(),
                "graded": graded,
                "_lm": last_modified,
            })

        dated: List[Tuple[Any, dict]] = []
        for group in groups.values():
            group["files"].sort(key=lambda f: f["_lm"], reverse=True)
            group["files"] = group["files"][:_FILE_CAP]
            for f in group["files"]:
                del f["_lm"]
            group_lm = group.pop("_lm")
            group["last_modified"] = group_lm.isoformat()
            dated.append((group_lm, group))
        # Sort on the datetime (not the ISO string): mixed microsecond
        # formatting would break lexicographic ordering.
        dated.sort(key=lambda pair: pair[0], reverse=True)
        finished = [group for _, group in dated]

        kinds_out.append({
            "kind": kind,
            "title": title,
            "total_group_count": len(finished),
            "groups": finished[:_GROUP_CAP],
        })

    return kinds_out


async def _scan_and_build() -> dict:
    """One fresh generation of the library response. Runs as a shared task."""
    global _library_cache, _inflight_scan
    from backend import main

    try:
        bucket = (main._env_config.get("VIZ_LIBRARY_BUCKET") or _DEFAULT_BUCKET).strip()
        try:
            main._validate_s3_bucket(bucket)
        except ValueError as e:
            return {
                "kinds": [], "generated_at": _utc_now_iso(),
                "from_cache": False, "error": str(e),
            }

        try:
            objects = await asyncio.to_thread(_scan_bucket, bucket)
        except Exception as e:  # creds missing, endpoint unreachable, throttled, ...
            reason = main._redact_error_detail(f"{type(e).__name__}: {e}")[:200]
            return {
                "kinds": [], "generated_at": _utc_now_iso(),
                "from_cache": False, "error": reason,
            }

        kinds = _build_kinds(bucket, objects)
        generated_at = _utc_now_iso()
        # Errors are never cached — only successful scans enter the TTL window.
        _library_cache = (_now(), kinds, generated_at)
        return {"kinds": kinds, "generated_at": generated_at, "from_cache": False}
    finally:
        _inflight_scan = None


def _ensure_scan_task() -> "asyncio.Task[dict]":
    """Start (or join) the single shared scan task."""
    global _inflight_scan
    loop = asyncio.get_running_loop()
    inflight = _inflight_scan
    if inflight is None or inflight[0] is not loop or inflight[1].done():
        inflight = (loop, loop.create_task(_scan_and_build()))
        _inflight_scan = inflight
    return inflight[1]


@router.get("/api/library")
async def get_library() -> dict:
    """The corpus index: kinds -> groups -> files, from one cached listing."""
    cached = _library_cache
    if cached is not None:
        stale = _now() - cached[0] >= _LIBRARY_TTL
        if stale:
            # Stale-while-revalidate: serve the old copy instantly, refresh
            # in the background (single-flight).
            _ensure_scan_task()
        return {
            "kinds": cached[1], "generated_at": cached[2],
            "from_cache": True, "stale": stale,
        }

    # Cold: no copy to serve — await ONE shared scan. The task is shielded so
    # one impatient client disconnecting doesn't cancel the scan out from
    # under the others.
    return await asyncio.shield(_ensure_scan_task())


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

def _first_complete_line(content: bytes) -> Optional[bytes]:
    """First JSONL line, or None if the 32KB window cut it off mid-line."""
    idx = content.find(b"\n")
    if idx != -1:
        return content[:idx]
    if len(content) < _PREVIEW_RANGE_BYTES:
        # Ranged GET returned fewer bytes than requested -> whole object.
        return content if content else None
    return None  # a full window with no newline: line is truncated


def _content_to_text(content: Any) -> Optional[str]:
    """Flatten message content (string or parts list) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        if parts:
            return " ".join(parts)
    return None


def _first_user_message(messages: Any) -> Optional[str]:
    if not isinstance(messages, list):
        return None
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "user":
            text = _content_to_text(message.get("content"))
            if text is None:
                return None
            collapsed = _WHITESPACE_RE.sub(" ", text).strip()
            return collapsed[:_PREVIEW_USER_MSG_MAX] or None
    return None


def _build_preview(file: str) -> dict:
    """Ranged GET of the first 32KB; parse the first line. Never raises."""
    from backend import main

    try:
        if not file.startswith("s3://"):
            return {"available": False}
        bucket, _, key = file[len("s3://"):].partition("/")
        if not bucket or not key or not key.endswith(".jsonl"):
            return {"available": False}
        main._validate_s3_bucket(bucket)

        s3_client = main._get_s3_client()
        response = s3_client.get_object(
            Bucket=bucket, Key=key, Range=f"bytes=0-{_PREVIEW_RANGE_BYTES - 1}"
        )
        content = response["Body"].read()

        line = _first_complete_line(content)
        if line is None:
            return {"available": False}
        entry = orjson.loads(line)
        if not isinstance(entry, dict):
            return {"available": False}

        attributes = entry.get("attributes")
        if not isinstance(attributes, dict):
            attributes = {}
        messages = entry.get("messages")
        return {
            "available": True,
            "experiment_name": attributes.get("experiment_name")
                or entry.get("experiment_name"),
            "model_id": attributes.get("model_id")
                or entry.get("model_id") or attributes.get("model"),
            "first_user_message": _first_user_message(messages),
            "message_count": len(messages) if isinstance(messages, list) else None,
            "timestamp": entry.get("timestamp") or attributes.get("timestamp"),
        }
    except Exception:
        # Bad file, truncated line, junk bytes, missing key, disallowed
        # bucket, creds trouble — the card simply has no preview.
        return {"available": False}


@router.get("/api/library/preview")
async def get_library_preview(
    file: str = Query(..., description="s3://bucket/key of a .jsonl file"),
) -> dict:
    """Lazy per-card enrichment for VISIBLE library cards only."""
    cached = _preview_cache.get(file)
    if cached is not None and _now() - cached[0] < _PREVIEW_TTL:
        return cached[1]

    payload = await asyncio.to_thread(_build_preview, file)

    if len(_preview_cache) >= _PREVIEW_CACHE_MAX:  # FIFO eviction, oldest first
        _preview_cache.pop(next(iter(_preview_cache)), None)
    _preview_cache[file] = (_now(), payload)
    return payload
