"""Companion-file endpoints: discover and read the context files that live
next to a loaded rollout file.

An auto_eval run directory holds context alongside the rollout the viewer
shows — runs/run_NN/{target.jsonl, execution.jsonl, summary.json} and, two
levels up, {plan.md, meta.json, results_summary.json}. The viewer loads only
target.jsonl; these endpoints let the frontend list (GET /api/companion) and
read (GET /api/raw) the siblings generically, for any producer's layout,
degrading to an empty list when there is nothing to show.

/api/companion is passive enrichment: missing files, bad paths, and S3 errors
all return 200 {"companions": []} — never a 5xx. /api/raw is the sensitive
surface: local paths must pass backend.main._safe_resolve_path (project-root
confinement, symlinks resolved), S3 buckets must pass the allowlist, and only
a small set of text extensions is served, capped at 2MB.

Auth: normal middleware applies — cookie session or Authorization: Bearer
<VIZ_API_TOKEN> (see auth_middleware in backend.main).
"""

import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

router = APIRouter()

_COMPANION_CAP = 30
_OWN_DIR_EXTS = {".md", ".json", ".jsonl"}
_PARENT_EXTS = {".md", ".json"}  # parent levels: context docs only, no data files
_KIND_BY_EXT = {".md": "markdown", ".json": "json", ".jsonl": "jsonl"}
_RAW_ALLOWED_EXTS = {".md", ".json", ".jsonl", ".txt", ".yaml", ".yml"}
_RAW_MAX_BYTES = 2 * 1024 * 1024


def _split_s3_path(file_path: str) -> Tuple[str, str]:
    """'s3://bucket/some/key' -> ('bucket', 'some/key'). Raises ValueError."""
    s3_path = file_path[len("s3://"):]
    if "/" not in s3_path:
        raise ValueError(f"Invalid S3 path (need s3://bucket/key): {file_path}")
    bucket, key = s3_path.split("/", 1)
    if not bucket or not key or key.endswith("/"):
        raise ValueError(f"Invalid S3 path (need s3://bucket/key): {file_path}")
    return bucket, key


def _kind_for(name: str) -> Optional[str]:
    return _KIND_BY_EXT.get(Path(name).suffix.lower())


# --- GET /api/companion ------------------------------------------------------


def _list_local_companions(file_path: str) -> List[Dict[str, Any]]:
    # Call-time import: backend.main imports this module at its bottom, so a
    # module-level back-import only works when main loads first (same pattern
    # as backend/fetch_api.py). Also lets tests patch main.PROJECT_ROOT.
    from backend import main

    try:
        loaded = main._safe_resolve_path(file_path)
    except ValueError:
        return []
    if not loaded.is_file():
        return []

    root = main.PROJECT_ROOT.resolve()
    own_dir = loaded.parent

    # Own directory plus up to two parents, never above PROJECT_ROOT.
    levels: List[Path] = [own_dir]
    for parent in (own_dir.parent, own_dir.parent.parent):
        try:
            parent.resolve().relative_to(root)
        except ValueError:
            break
        if parent.resolve() == levels[-1].resolve():
            break  # hit the filesystem root; no distinct parent above
        levels.append(parent)

    found: List[Tuple[int, Path]] = []  # (level index, absolute path)
    for level_idx, directory in enumerate(levels):
        if len(found) >= _COMPANION_CAP:
            break
        allowed_exts = _OWN_DIR_EXTS if level_idx == 0 else _PARENT_EXTS
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for entry in entries:
            if len(found) >= _COMPANION_CAP:
                break
            if entry.name.startswith("."):
                continue
            if entry.suffix.lower() not in allowed_exts:
                continue
            if entry == loaded:
                continue
            try:
                if not entry.is_file():
                    continue
                rel_to_root = entry.resolve().relative_to(root)
            except (OSError, ValueError):
                continue  # broken symlink, or symlink escaping the root
            if "viz" in rel_to_root.parts:
                continue
            found.append((level_idx, entry))

    if not found:
        return []

    # Names are relative to the deepest directory common to the loaded file
    # and every companion — i.e. the shallowest level that contributed one.
    common_dir = levels[max(level for level, _ in found)]
    companions = []
    for _, path in found:
        try:
            size: Optional[int] = path.stat().st_size
        except OSError:
            size = None
        companions.append({
            "path": str(path),
            "name": str(path.relative_to(common_dir)),
            "size": size,
            "kind": _kind_for(path.name),
        })
    return companions


def _list_s3_companions(file_path: str) -> List[Dict[str, Any]]:
    from backend import main

    try:
        bucket, key = _split_s3_path(file_path)
        main._validate_s3_bucket(bucket)
    except ValueError:
        return []

    # Own prefix plus up to two parents, never above the bucket root.
    dir_parts = key.split("/")[:-1]
    prefixes: List[str] = []
    for up in range(3):
        depth = len(dir_parts) - up
        if depth < 0:
            break
        joined = "/".join(dir_parts[:depth])
        prefixes.append(joined + "/" if joined else "")
        if depth == 0:
            break  # reached the bucket root

    client = main._get_s3_client()
    found: List[Tuple[int, str, Optional[int]]] = []  # (level, key, size)
    try:
        for level_idx, prefix in enumerate(prefixes):
            if len(found) >= _COMPANION_CAP:
                break
            allowed_exts = _OWN_DIR_EXTS if level_idx == 0 else _PARENT_EXTS
            # Delimiter='/' keeps each call to one directory level — 2-3
            # cheap listings total, no recursion.
            response = client.list_objects_v2(
                Bucket=bucket, Prefix=prefix, Delimiter="/"
            )
            level: List[Tuple[str, Optional[int]]] = []
            for obj in response.get("Contents", []):
                obj_key = obj.get("Key", "")
                if not obj_key or obj_key == key:
                    continue
                name = obj_key.rsplit("/", 1)[-1]
                if not name or name.startswith("."):
                    continue
                if Path(name).suffix.lower() not in allowed_exts:
                    continue
                if "viz" in obj_key.split("/"):
                    continue
                level.append((obj_key, obj.get("Size")))
            level.sort(key=lambda item: item[0])  # same prefix => alphabetical by name
            for obj_key, size in level:
                if len(found) >= _COMPANION_CAP:
                    break
                found.append((level_idx, obj_key, size))
    except Exception:
        # Passive enrichment: any S3 failure degrades to "no companions".
        return []

    if not found:
        return []

    common_prefix = prefixes[max(level for level, _, _ in found)]
    return [
        {
            "path": f"s3://{bucket}/{obj_key}",
            "name": obj_key[len(common_prefix):],
            "size": size,
            "kind": _kind_for(obj_key),
        }
        for _, obj_key, size in found
    ]


@router.get("/api/companion")
async def get_companions(
    file: str = Query(..., description="Loaded JSONL path (local or s3://bucket/key)"),
) -> Dict[str, Any]:
    """List context files near a loaded rollout file.

    Looks in the file's own directory (.md/.json/.jsonl, minus the file
    itself) and up to two parent directories (.md/.json only). Excludes viz/
    paths and dotfiles. Capped at 30, nearest-first, alphabetical per level.
    Never 5xx: anything unexpected degrades to an empty list.
    """
    try:
        if file.startswith("s3://"):
            companions = await asyncio.to_thread(_list_s3_companions, file)
        else:
            companions = await asyncio.to_thread(_list_local_companions, file)
    except Exception:
        companions = []
    return {"companions": companions}


# --- GET /api/raw ------------------------------------------------------------


def _check_raw_name(name: str) -> None:
    """Shared filename gate for /api/raw: no dotfiles, allowlisted extensions.

    For local paths this runs on the RESOLVED filename, so tricks like
    'plan.md/../secret.py' are judged by what would actually be opened.
    """
    if name.startswith("."):
        raise HTTPException(status_code=400, detail="Hidden files are not served")
    suffix = Path(name).suffix.lower()
    if suffix not in _RAW_ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Extension {suffix or '(none)'} not allowed; "
                   f"one of {sorted(_RAW_ALLOWED_EXTS)} required",
        )


def _read_local_raw(file_path: str) -> Tuple[bytes, bool]:
    from backend import main

    try:
        resolved = main._safe_resolve_path(file_path)
    except ValueError as e:
        # Traversal / outside PROJECT_ROOT. 400 matches how main.py's
        # endpoints surface _safe_resolve_path failures.
        raise HTTPException(status_code=400, detail=str(e))
    _check_raw_name(resolved.name)
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    try:
        with open(resolved, "rb") as f:
            data = f.read(_RAW_MAX_BYTES + 1)
    except OSError:
        raise HTTPException(status_code=404, detail=f"Could not read: {file_path}")
    return data[:_RAW_MAX_BYTES], len(data) > _RAW_MAX_BYTES


def _read_s3_raw(file_path: str) -> Tuple[bytes, bool]:
    from backend import main
    from botocore.exceptions import ClientError

    try:
        bucket, key = _split_s3_path(file_path)
        main._validate_s3_bucket(bucket)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _check_raw_name(key.rsplit("/", 1)[-1])

    client = main._get_s3_client()
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
        raise HTTPException(status_code=502, detail=f"S3 error: {code or 'unknown'}")

    size = int(head.get("ContentLength", 0))
    if size > _RAW_MAX_BYTES:
        response = client.get_object(
            Bucket=bucket, Key=key, Range=f"bytes=0-{_RAW_MAX_BYTES - 1}"
        )
        # Defensive slice in case the store ignores the Range header.
        return response["Body"].read()[:_RAW_MAX_BYTES], True
    response = client.get_object(Bucket=bucket, Key=key)
    return response["Body"].read()[:_RAW_MAX_BYTES], False


@router.get("/api/raw")
async def get_raw(
    file: str = Query(..., description="Companion file path (local or s3://bucket/key)"),
) -> Response:
    """Return a companion file's raw content as text/plain.

    Capped at 2MB — larger files return the first 2MB with X-Truncated: true.
    Only .md/.json/.jsonl/.txt/.yaml/.yml are served; anything else is 400.
    Local paths are confined to PROJECT_ROOT; S3 buckets must be allowlisted.
    """
    if file.startswith("s3://"):
        data, truncated = await asyncio.to_thread(_read_s3_raw, file)
    else:
        data, truncated = await asyncio.to_thread(_read_local_raw, file)
    headers = {"X-Truncated": "true"} if truncated else {}
    return Response(
        content=data, media_type="text/plain; charset=utf-8", headers=headers
    )
