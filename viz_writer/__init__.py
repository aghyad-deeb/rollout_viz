"""viz_writer — the one blessed way to write rollout_viz JSONL files.

Every producer (agent skills, web_chat, auto_eval, tinker recipes) should
write trace files through this module instead of hand-rolling JSONL + boto3.
It owns the schema contract:

- validates permissively (messages are required; everything else is optional),
- passes unknown fields through UNTOUCHED (lossless by construction),
- stamps a stable ``attributes.viz_id`` per sample,
- never fabricates reward/step/sample_index/rollout_n — omitted stays omitted,
- writes local or s3:// destinations,
- returns canonical, clickable rollout_viz URLs (?file=...&index=...).

Usage:
    from viz_writer import write_rollouts

    result = write_rollouts(samples, "s3://rewardseeker/logs_jsonl/cli_sessions/x.jsonl")
    print(result.url)             # file-level viz link
    print(result.sample_urls[0])  # deep link to the first sample just written

Training loops must never depend on the viz server being up: this module
talks to storage directly and only *builds* URLs, it never calls the API.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

__all__ = [
    "ValidationError",
    "WriteResult",
    "validate_sample",
    "canonicalize_sample",
    "write_rollouts",
    "rollout_url",
    "dest_for",
]

_DEFAULT_VIZ_BASE_URL = "http://localhost:3000"

# The canonical bucket layout, enforced at WRITE time. Historical data lives
# under legacy prefixes (root-level cli_sessions/, target_probes/,
# debug_traces/) and STAYS there — links point at paths, so old files are
# never moved. The viewer's Library lists both old and new locations.
_DEFAULT_BUCKET = "rewardseeker"
_KIND_DESTINATIONS = {
    "session": "logs_jsonl/cli_sessions",
    "probe": "logs_jsonl/target_probes",
    "debug": "logs_jsonl/debug_traces",
    "chat": "logs_jsonl/chats",
    "online_chat": "logs_jsonl/online_chats",
    "eval": "logs_jsonl/auto_eval",
    "training_run": "logs_jsonl/rollout_traces_tinker",
}

# Append safety valve: refuse to rewrite S3 objects beyond this size (S3 has
# no real append — we download + concatenate + re-upload).
_S3_APPEND_MAX_BYTES = 200 * 1024 * 1024


class ValidationError(ValueError):
    """A sample failed the (deliberately permissive) schema check."""


@dataclass
class WriteResult:
    uri: str
    """Normalized destination (s3://bucket/key or absolute local path)."""
    count: int
    """Samples written by this call."""
    total: int
    """Total samples now in the file (== count unless appending)."""
    url: str
    """File-level rollout_viz link."""
    sample_urls: List[str] = field(default_factory=list)
    """Canonical ?file=...&index=... deep links for THIS call's samples."""


def rollout_url(dest: str, index: Optional[int] = None) -> str:
    """Canonical rollout_viz link for a trace file or one sample in it.

    ``index`` is the file-relative line index — the stable, canonical sample
    identifier. Base URL comes from $VIZ_BASE_URL (default localhost:3000).

    Caveats: local-path links only load if the path is inside the viz
    server's project root (its path-traversal guard rejects the rest) — use
    s3:// destinations for shareable links. And if a graded viz/ sidecar
    already exists for the file, the viewer prefers it, so samples appended
    to the ORIGINAL after grading won't show until the sidecar is refreshed.
    """
    base = os.environ.get("VIZ_BASE_URL", _DEFAULT_VIZ_BASE_URL).rstrip("/")
    url = f"{base}/?file={urllib.parse.quote(str(dest), safe='')}"
    if index is not None:
        url += f"&index={index}"
    return url


def _sanitize_segment(segment: str) -> str:
    """One path segment: safe charset, no dot-only names, non-empty."""
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in segment)
    cleaned = cleaned.lstrip(".")
    if not cleaned:
        raise ValueError(f"unusable path segment {segment!r}")
    return cleaned


def dest_for(kind: str, name: str, *, bucket: str = _DEFAULT_BUCKET,
             date: Optional[str] = None) -> str:
    """Canonical S3 destination for a NEW trace file.

    This is how producers stop inventing prefixes: pick a kind, get the one
    blessed spot — s3://<bucket>/<kind prefix>/<YYYY-MM-DD>/<name>.jsonl.
    ``name`` may contain '/' subpath segments (e.g. a run subdir); each
    segment is sanitized. ``date`` defaults to today.

    Only affects NEW files. Historical files stay under their legacy
    prefixes forever — moving them would break every existing ?file&index
    link and desync positional viz/ grade sidecars.
    """
    prefix = _KIND_DESTINATIONS.get(kind)
    if prefix is None:
        raise ValueError(
            f"unknown kind {kind!r}; expected one of {sorted(_KIND_DESTINATIONS)}"
        )
    day = date or datetime.now().strftime("%Y-%m-%d")
    segments = [_sanitize_segment(s) for s in str(name).split("/") if s]
    if not segments:
        raise ValueError("name must be non-empty")
    path = "/".join(segments)
    if not path.endswith(".jsonl"):
        path += ".jsonl"
    return f"s3://{bucket}/{prefix}/{day}/{path}"


def validate_sample(sample: Any) -> List[str]:
    """Return a list of problems (empty == valid).

    Permissive on purpose: only the structural minimum is enforced so no
    producer is ever tempted to fake fields to satisfy the writer.
    """
    problems: List[str] = []
    if not isinstance(sample, dict):
        return [f"sample must be a dict, got {type(sample).__name__}"]

    messages = sample.get("messages")
    if not isinstance(messages, list) or not messages:
        problems.append("messages must be a non-empty list")
        return problems

    for i, message in enumerate(messages):
        if not isinstance(message, dict):
            problems.append(f"messages[{i}] must be a dict")
            continue
        role = message.get("role")
        if not isinstance(role, str) or not role:
            problems.append(f"messages[{i}].role must be a non-empty string")
        if not any(k in message for k in ("content", "content_parts", "tool_calls")):
            problems.append(
                f"messages[{i}] needs content, content_parts, or tool_calls"
            )

    attrs = sample.get("attributes")
    if attrs is not None and not isinstance(attrs, dict):
        problems.append("attributes must be a dict when present")
    return problems


def canonicalize_sample(sample: Dict[str, Any]) -> Dict[str, Any]:
    """Shallow-copy + canonical stamps. Never mutates the caller's dict.

    - attributes.viz_id: stamped with a fresh uuid4 hex if absent
    - timestamp: filled with now() if absent
    - everything else passes through untouched (lossless)
    """
    out = dict(sample)
    attrs = dict(out.get("attributes") or {})
    if not attrs.get("viz_id"):
        attrs["viz_id"] = uuid.uuid4().hex
    out["attributes"] = attrs
    if not out.get("timestamp"):
        out["timestamp"] = datetime.now().isoformat()
    return out


def _parse_env_file() -> Dict[str, str]:
    """Parse ~/.env the same way the viz backend does (no shell env needed)."""
    env: Dict[str, str] = {}
    path = Path.home() / ".env"
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def _s3_client():
    import boto3
    from botocore.exceptions import NoCredentialsError

    client = boto3.client("s3")
    try:
        # Cheap credential probe; get_caller_identity needs STS perms, so
        # just check the credential chain resolved at all.
        if boto3.Session().get_credentials() is not None:
            return client
    except Exception:
        pass
    env = _parse_env_file()
    if env.get("AWS_ACCESS_KEY_ID") and env.get("AWS_SECRET_ACCESS_KEY"):
        session = boto3.Session(
            aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
            region_name=env.get("AWS_DEFAULT_REGION"),
        )
        return session.client("s3")
    raise NoCredentialsError()


def _json_default(value: Any) -> Any:
    """Serialize non-JSON-native values without corrupting numerics.

    numpy scalars/arrays convert to real numbers/lists (a blanket default=str
    would turn np.float32(0.5) into "0.5" and an ndarray into its repr —
    irrecoverably lossy). Everything else (datetimes, paths) falls back to str.
    """
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return value.item()
        except (ValueError, TypeError):
            pass
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return value.tolist()
    return str(value)


def _encode_lines(samples: List[Dict[str, Any]]) -> bytes:
    return "".join(json.dumps(s, default=_json_default) + "\n" for s in samples).encode("utf-8")


def _count_lines(data: bytes) -> int:
    return sum(1 for line in data.split(b"\n") if line.strip())


def write_rollouts(
    samples: Iterable[Dict[str, Any]],
    dest: str,
    mode: str = "create",
) -> WriteResult:
    """Validate, canonicalize, and write samples to ``dest``.

    dest: s3://bucket/key.jsonl or a local path.
    mode: 'create' (fail if dest exists), 'append', or 'overwrite'.
    """
    if mode not in ("create", "append", "overwrite"):
        raise ValueError(f"mode must be create|append|overwrite, got {mode!r}")

    batch = list(samples)
    if not batch:
        raise ValidationError("no samples to write")
    for i, sample in enumerate(batch):
        problems = validate_sample(sample)
        if problems:
            raise ValidationError(f"sample {i}: " + "; ".join(problems))

    canonical = [canonicalize_sample(s) for s in batch]
    payload = _encode_lines(canonical)

    if dest.startswith("s3://"):
        uri, existing_count = _write_s3(dest, payload, mode)
    else:
        uri, existing_count = _write_local(dest, payload, mode)

    start = existing_count
    total = existing_count + len(canonical)
    return WriteResult(
        uri=uri,
        count=len(canonical),
        total=total,
        url=rollout_url(uri),
        sample_urls=[rollout_url(uri, i) for i in range(start, total)],
    )


def _write_local(dest: str, payload: bytes, mode: str) -> tuple[str, int]:
    path = Path(dest).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    existing_count = 0
    if path.exists():
        if mode == "create":
            raise FileExistsError(f"{path} already exists (use mode='append' or 'overwrite')")
        if mode == "append":
            existing = path.read_bytes()
            existing_count = _count_lines(existing)
            # Hand-rolled files may lack a trailing newline; appending without
            # one would merge two samples into a single unparseable line.
            if existing and not existing.endswith(b"\n"):
                payload = b"\n" + payload

    if mode == "append":
        with open(path, "ab") as f:
            f.write(payload)
    else:
        path.write_bytes(payload)
    return str(path), existing_count


def _write_s3(dest: str, payload: bytes, mode: str) -> tuple[str, int]:
    """Write to S3.

    Concurrency contract: ONE writer per file. S3 has no real append, so
    'append' is head→get→concat→put; conditional puts (IfMatch/IfNoneMatch)
    turn a lost race into a loud ClientError instead of silent sample loss,
    but retrying is the caller's job. Producers satisfy this naturally today
    (the skill writes fresh timestamped filenames; the tracer owns one file
    per step)."""
    bucket, _, key = dest[len("s3://"):].partition("/")
    if not bucket or not key:
        raise ValueError(f"bad s3 destination {dest!r} (want s3://bucket/key.jsonl)")
    client = _s3_client()

    existing: Optional[bytes] = None
    try:
        head = client.head_object(Bucket=bucket, Key=key)
        exists = True
        size = head["ContentLength"]
        etag = head.get("ETag")
    except client.exceptions.ClientError as e:
        # ONLY a definitive 404 means "does not exist". Anything else (403
        # AccessDenied, 503 SlowDown, throttling) must propagate — treating it
        # as absence would let mode='create' overwrite, or mode='append'
        # replace, an existing file's contents.
        code = str(e.response.get("Error", {}).get("Code", ""))
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code not in ("404", "NoSuchKey", "NotFound") and status != 404:
            raise
        exists = False
        size = 0
        etag = None

    if exists and mode == "create":
        raise FileExistsError(f"{dest} already exists (use mode='append' or 'overwrite')")

    existing_count = 0
    if exists and mode == "append":
        if size + len(payload) > _S3_APPEND_MAX_BYTES:
            raise ValueError(
                f"append would make {dest} exceed {_S3_APPEND_MAX_BYTES // (1024 * 1024)}MB; "
                "start a new file instead"
            )
        existing = client.get_object(Bucket=bucket, Key=key)["Body"].read()
        existing_count = _count_lines(existing)
        if existing and not existing.endswith(b"\n"):
            existing += b"\n"
        payload = existing + payload

    put_kwargs: Dict[str, Any] = {}
    if mode == "create":
        put_kwargs["IfNoneMatch"] = "*"  # lose the create race loudly
    elif mode == "append" and exists and etag:
        put_kwargs["IfMatch"] = etag  # lose the append race loudly, not silently
    client.put_object(Bucket=bucket, Key=key, Body=payload, **put_kwargs)
    return f"s3://{bucket}/{key}", existing_count
