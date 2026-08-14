"""
FastAPI backend for Rollout Trace Visualizer.

Provides REST API endpoints for loading JSONL data from local files or S3.
"""

import asyncio
import copy
import gzip
import ipaddress
import json
import os
import re
import secrets
import threading as _threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import hmac as _hmac
import tempfile
import posixpath
from urllib.parse import unquote

import httpx
import orjson
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, ORJSONResponse, StreamingResponse
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from pydantic import BaseModel, ConfigDict
from starlette.middleware.gzip import GZipMiddleware

from backend.llm_providers import (
    get_grading_provider,
    GradeResult,
    InvalidGradeResponse,
    Quote as LLMQuote,
    PRESET_METRICS,
    reset_grading_log_context,
    set_grading_log_context,
)

# Backward-compatible patch point for tests and local scripts that mocked
# backend.main.get_provider before grading moved to model_router.
get_provider = get_grading_provider


# Project root directory (parent of backend/)
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"

# Never serve Vite/dev-only or local project internals from the public SPA fallback.
_DENIED_FRONTEND_PREFIXES = ("@fs", "@vite", "node_modules", "src")
_DENIED_FRONTEND_FILES = {
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
}

# Load environment variables exclusively from ~/.env
# All config (API keys, VIZ_PASSWORD, etc.) lives in one place
_env_file = Path.home() / ".env"
_env_config: Dict[str, str] = {}
if _env_file.exists():
    with open(_env_file, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                # Strip surrounding quotes if present
                value = value.strip().strip('"').strip("'")
                _env_config[key.strip()] = value
    print(f"[CONFIG] Loaded {len(_env_config)} vars from {_env_file}")
else:
    print(f"[CONFIG] WARNING: {_env_file} not found")

# Keep ~/.env as the app's source of truth while still allowing helpers such as
# ModelRouterProvider to read shared tuning knobs with os.getenv(). Existing
# process env wins, which keeps one-off overrides possible.
for _env_key, _env_value in _env_config.items():
    os.environ.setdefault(_env_key, _env_value)

# Shared model_router (stateless model-inference proxy in the monorepo).
# Used by the "discuss this rollout" chat feature via its litellm provider.
MODEL_ROUTER_URL = (
    _env_config.get("MODEL_ROUTER_URL")
    or _env_config.get("TINKER_SERVICE_URL")
    or "http://localhost:8235"
).rstrip("/")

# API key environment variable names for each provider. Values are aliases in
# precedence order; Google/Gemini key names differ across SDKs and LiteLLM.
API_KEY_ENV_VARS = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_AI_API_KEY"),
    "openrouter": ("OPENROUTER_API_KEY",),
}


def _config_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name) or _env_config.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"[CONFIG] WARNING: invalid integer for {name}; using {default}")
        return default
    return max(minimum, value)


def _config_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name) or _env_config.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def get_env_api_key(provider: str) -> Optional[str]:
    """Get API key from ~/.env for a provider (ignores shell environment)."""
    for env_var in API_KEY_ENV_VARS.get(provider.lower(), ()):
        key = _env_config.get(env_var)
        if key:
            return key
    return None


# S3 bucket allowlist: only these buckets can be accessed.
# Set VIZ_ALLOWED_S3_BUCKETS=bucket1,bucket2 in ~/.env to restrict.
_allowed_s3_raw = _env_config.get("VIZ_ALLOWED_S3_BUCKETS", "")
VIZ_ALLOWED_S3_BUCKETS: Optional[set] = (
    {b.strip() for b in _allowed_s3_raw.split(",") if b.strip()} if _allowed_s3_raw else None
)
_cors_origins_raw = _env_config.get("VIZ_CORS_ORIGINS", "")
VIZ_CORS_ORIGINS = [origin.strip() for origin in _cors_origins_raw.split(",") if origin.strip()]


TrustedProxyNetwork = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]


def _parse_trusted_proxy_networks(raw: str) -> List[TrustedProxyNetwork]:
    networks: List[TrustedProxyNetwork] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            print(f"[CONFIG] WARNING: invalid VIZ_TRUSTED_PROXIES entry: {item}")
    return networks


_trusted_proxies_raw = os.getenv("VIZ_TRUSTED_PROXIES") or _env_config.get("VIZ_TRUSTED_PROXIES", "")
VIZ_TRUSTED_PROXY_NETWORKS = _parse_trusted_proxy_networks(_trusted_proxies_raw)

# Max JSONL file size to load (prevents OOM). Default 500 MB.
MAX_FILE_SIZE = int(_env_config.get("VIZ_MAX_FILE_SIZE_MB", "500")) * 1024 * 1024
_BATCH_MAX_FILES = _config_int("VIZ_BATCH_MAX_FILES", 50)
_BATCH_MAX_AGGREGATE_BYTES = _config_int("VIZ_BATCH_MAX_AGGREGATE_MB", 500) * 1024 * 1024
_BATCH_MAX_SAMPLES = _config_int("VIZ_BATCH_MAX_SAMPLES", 50_000)
_BATCH_MAX_RESPONSE_BYTES = _config_int("VIZ_BATCH_MAX_RESPONSE_MB", 200) * 1024 * 1024


def _validate_s3_bucket(bucket: str) -> None:
    """Raise ValueError if S3 access is not explicitly scoped to this bucket."""
    if VIZ_ALLOWED_S3_BUCKETS is None:
        raise ValueError("S3 bucket allowlist not configured; set VIZ_ALLOWED_S3_BUCKETS")
    if bucket not in VIZ_ALLOWED_S3_BUCKETS:
        raise ValueError(f"S3 bucket not allowed: {bucket}")


_SECRET_DETAIL_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|authorization|bearer|token)([=:\s]+)([^\s,;]+)"),
    re.compile(r"sk-[A-Za-z0-9_\-]{12,}"),
)


def _redact_error_detail(message: str) -> str:
    """Remove obvious credential-shaped values from errors before returning them."""
    redacted = message
    redacted = _SECRET_DETAIL_PATTERNS[0].sub(r"\1\2[redacted]", redacted)
    redacted = _SECRET_DETAIL_PATTERNS[1].sub("[redacted-api-key]", redacted)
    return redacted[:1000] + ("..." if len(redacted) > 1000 else "")


def _safe_error_detail(e: Exception, *, expose: bool = False) -> str:
    """Log server-side errors; optionally return a redacted actionable message."""
    print(f"[ERROR] {type(e).__name__}: {e}")
    if not expose:
        return "Internal server error"
    if isinstance(e, HTTPException):
        return _redact_error_detail(str(e.detail))
    return _redact_error_detail(str(e) or type(e).__name__)

app = FastAPI(title="Rollout Visualizer API", docs_url=None, redoc_url=None, openapi_url=None)

# Optional CORS for development. The Vite dev server proxies /api by default,
# so production and normal dev use same-origin requests and need no CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=VIZ_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZip compression for responses > 1KB
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=1)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """Add security headers to all responses."""
    response = await call_next(request)
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
    # img-src needs `blob:` for capture-preview images (URL.createObjectURL);
    # connect-src needs the Google Fonts origins so the image-capture step
    # can fetch + embed the icon/text fonts into the snapshot.
    csp = "frame-ancestors 'none'; default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'"
    response.headers["Content-Security-Policy"] = csp
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if proto == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

# --- Password authentication ---
_raw_password = _env_config.get("VIZ_PASSWORD")
if _raw_password is not None and _raw_password == "":
    print("[AUTH] WARNING: VIZ_PASSWORD is set to empty string — treating as unset (no auth)")
    _raw_password = None
if _config_bool("VIZ_REQUIRE_AUTH") and not _raw_password:
    raise RuntimeError("VIZ_REQUIRE_AUTH=1 requires VIZ_PASSWORD")
VIZ_PASSWORD = _raw_password
# Machine auth for headless first-party consumers (web_chat, auto_eval, agent
# skills). Sent as `Authorization: Bearer <token>`; grants full access like a
# cookie session. Unset (default) disables the bearer path entirely.
VIZ_API_TOKEN = _env_config.get("VIZ_API_TOKEN") or None
SECRET_KEY = _env_config.get("VIZ_SECRET_KEY", secrets.token_hex(32))
cookie_serializer = URLSafeTimedSerializer(SECRET_KEY)


def _password_version() -> str:
    """HMAC of the password keyed by SECRET_KEY. Embedded in session cookies so
    changing the password automatically invalidates sessions. Uses HMAC so the
    value is meaningless without SECRET_KEY (unlike a plain hash)."""
    if not VIZ_PASSWORD:
        return ""
    return _hmac.new(SECRET_KEY.encode(), VIZ_PASSWORD.encode(), "sha256").hexdigest()[:16]
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days
AUTH_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/check", "/api/health", "/api/share/verify"}

# --- Signed share links (read-only access to specific rollouts) ---
SHARE_MAX_AGE = 90 * 24 * 3600  # 90 days
share_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="share-link")

# Simple in-memory rate limiter for login attempts
_login_attempts: Dict[str, List[float]] = {}
RATE_LIMIT_WINDOW = 300  # 5 minutes
RATE_LIMIT_MAX = 5


def _check_rate_limit(client_ip: str) -> bool:
    """Return True if the request should be rate-limited."""
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW
    # Evict only expired entries (preserves active rate limits, unlike clear())
    if len(_login_attempts) > 10_000:
        expired = [ip for ip, times in _login_attempts.items() if not times or max(times) < cutoff]
        for ip in expired:
            del _login_attempts[ip]
    attempts = _login_attempts.get(client_ip, [])
    attempts = [t for t in attempts if t >= cutoff]
    _login_attempts[client_ip] = attempts
    return len(attempts) >= RATE_LIMIT_MAX


def _record_failed_attempt(client_ip: str):
    _login_attempts.setdefault(client_ip, []).append(time.time())


def _clear_attempts(client_ip: str):
    _login_attempts.pop(client_ip, None)


_abuse_rate_limits: Dict[str, Dict[str, List[float]]] = {}


def _is_trusted_proxy(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in network for network in VIZ_TRUSTED_PROXY_NETWORKS)


def _request_client_key(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    if not _is_trusted_proxy(peer):
        return peer

    forwarded_for = request.headers.get("x-forwarded-for", "")
    chain = [part.strip() for part in forwarded_for.split(",") if part.strip()]
    # Walk from the proxy nearest this app toward the original client and use
    # the first non-trusted IP. This resists client-supplied spoof prefixes
    # preserved by an upstream trusted proxy.
    for candidate in reversed(chain):
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if not _is_trusted_proxy(candidate):
            return candidate
    return peer


def _enforce_window_rate_limit(
    bucket_name: str,
    request: Request,
    *,
    max_requests: int,
    window_seconds: int,
) -> None:
    now = time.time()
    cutoff = now - window_seconds
    bucket = _abuse_rate_limits.setdefault(bucket_name, {})
    if len(bucket) > 10_000:
        for key, times in list(bucket.items()):
            if not times or max(times) < cutoff:
                del bucket[key]

    key = _request_client_key(request)
    attempts = [t for t in bucket.get(key, []) if t >= cutoff]
    if len(attempts) >= max_requests:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Try again shortly.",
            headers={"Retry-After": str(window_seconds)},
        )
    attempts.append(now)
    bucket[key] = attempts


def _clear_abuse_rate_limits():
    _abuse_rate_limits.clear()


def _can_use_server_api_keys(request: Request) -> bool:
    return bool(VIZ_PASSWORD) and getattr(request.state, "access_level", None) == "full"


def _resolve_llm_api_key(provider: str, provided_key: Optional[str], request: Request) -> str:
    if provided_key:
        if len(provided_key) > 500:
            raise HTTPException(status_code=400, detail="API key too long")
        return provided_key

    env_key = get_env_api_key(provider)
    if env_key and not _can_use_server_api_keys(request):
        raise HTTPException(
            status_code=403,
            detail="Server API keys require an authenticated password session",
        )
    if env_key:
        return env_key
    raise HTTPException(status_code=400, detail=f"No API key provided for {provider}")


@app.middleware("http")
async def timing_middleware(request: Request, call_next):
    if not request.url.path.startswith("/api"):
        return await call_next(request)
    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start
    # Log slow requests or all sample loads
    path = request.url.path
    if elapsed > 0.5 or "samples" in path:
        short_path = request.url.query if request.url.query else path
        # Truncate long query strings for readability
        if len(short_path) > 80:
            short_path = "..." + short_path[-77:]
        print(f"[PERF] {request.method} {path} — {elapsed:.2f}s ({response.status_code}) {short_path}")
    return response


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Non-API routes always pass (static frontend files)
    if not request.url.path.startswith("/api"):
        return await call_next(request)

    # Auth-exempt paths always pass
    if request.url.path in AUTH_EXEMPT_PATHS:
        return await call_next(request)

    # 1) Session cookie → full access
    session_cookie = request.cookies.get("viz_session")
    if session_cookie:
        try:
            payload = cookie_serializer.loads(session_cookie, max_age=COOKIE_MAX_AGE)
            if not isinstance(payload, dict) or not payload.get("auth"):
                raise BadSignature("legacy cookie format")
            if payload.get("pv", "") != _password_version():
                raise BadSignature("password changed")
            request.state.access_level = "full"
            return await call_next(request)
        except (BadSignature, SignatureExpired):
            pass

    # 1.5) Machine token (Authorization: Bearer) → full access. A request that
    # SENDS a bearer token opted into token auth: a mismatch fails loudly with
    # 401 rather than falling through, so token typos surface immediately
    # instead of silently riding the no-password allowance. Scheme match is
    # case-insensitive (RFC 7235); comparison is over bytes because
    # compare_digest raises on non-ASCII str input (Starlette decodes header
    # obs-text as latin-1) — any such token must 401, not 500.
    auth_header = request.headers.get("authorization", "")
    scheme, _, bearer_candidate = auth_header.partition(" ")
    if VIZ_API_TOKEN and scheme.lower() == "bearer":
        candidate = bearer_candidate.strip()
        if candidate and _hmac.compare_digest(
            candidate.encode("utf-8", "surrogateescape"), VIZ_API_TOKEN.encode("utf-8")
        ):
            request.state.access_level = "full"
            return await call_next(request)
        return JSONResponse(status_code=401, content={"detail": "Invalid API token"})

    # 2) No password configured → full access for everyone
    if not VIZ_PASSWORD:
        request.state.access_level = "full"
        return await call_next(request)

    # 3) Share token → limited read-only access to specific file/samples
    share_token = request.headers.get("x-share-token")
    if share_token:
        try:
            payload = share_serializer.loads(share_token, max_age=SHARE_MAX_AGE)
            method = request.method
            path = request.url.path

            allowed = (
                (method == "GET" and path == "/api/samples")
                or (method == "GET" and path.startswith("/api/sample/"))
            )
            if not allowed:
                return JSONResponse(status_code=403, content={"detail": "Not authorized in shared mode"})

            file_param = request.query_params.get("file")
            if file_param is None or file_param != payload.get("f"):
                return JSONResponse(status_code=403, content={"detail": "File not authorized for this share link"})

            request.state.access_level = "share"
            request.state.share_payload = payload
            return await call_next(request)
        except (SignatureExpired, BadSignature):
            return JSONResponse(status_code=401, content={"detail": "Invalid or expired share link"})

    return JSONResponse(status_code=401, content={"detail": "Authentication required"})


class LoginRequest(BaseModel):
    password: str


@app.post("/api/auth/login")
async def auth_login(body: LoginRequest, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"
    if _check_rate_limit(client_ip):
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many login attempts. Try again in a few minutes."},
            headers={"Retry-After": str(RATE_LIMIT_WINDOW)},
        )
    if not VIZ_PASSWORD or not secrets.compare_digest(body.password, VIZ_PASSWORD):
        _record_failed_attempt(client_ip)
        return JSONResponse(status_code=401, content={"detail": "Invalid password"})
    _clear_attempts(client_ip)
    token = cookie_serializer.dumps({"auth": True, "pv": _password_version()})
    response = JSONResponse(content={"ok": True})
    # Use X-Forwarded-Proto to detect HTTPS behind reverse proxies (Cloudflare, etc.)
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    response.set_cookie(
        key="viz_session",
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=(proto == "https"),
        samesite="lax",
    )
    return response


@app.get("/api/auth/check")
async def auth_check(request: Request):
    auth_required = bool(VIZ_PASSWORD)
    if not auth_required:
        return {"auth_required": False, "authenticated": True}
    session_cookie = request.cookies.get("viz_session")
    if session_cookie:
        try:
            payload = cookie_serializer.loads(session_cookie, max_age=COOKIE_MAX_AGE)
            if not isinstance(payload, dict) or not payload.get("auth"):
                raise BadSignature("legacy cookie format")
            if payload.get("pv", "") != _password_version():
                raise BadSignature("password changed")
            return {"auth_required": True, "authenticated": True}
        except (BadSignature, SignatureExpired):
            pass
    return {"auth_required": True, "authenticated": False}


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Clear the session cookie."""
    resp = JSONResponse(content={"ok": True})
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    resp.delete_cookie("viz_session", httponly=True, secure=(proto == "https"), samesite="lax")
    return resp


if VIZ_PASSWORD:
    print(f"[AUTH] Password protection enabled")
else:
    print(f"[AUTH] No VIZ_PASSWORD set — authentication disabled")

if not _env_config.get("VIZ_SECRET_KEY"):
    print(f"[AUTH] WARNING: VIZ_SECRET_KEY not set — sessions and share links will not survive restarts")

if VIZ_ALLOWED_S3_BUCKETS is None and any(k.startswith("AWS_") for k in _env_config):
    print("[SECURITY] WARNING: VIZ_ALLOWED_S3_BUCKETS not set — S3 browsing is disabled until a bucket allowlist is configured")


class CreateShareRequest(BaseModel):
    """Request to create a signed share link."""
    file: str
    rollout: Optional[int] = None
    step: Optional[int] = None
    # File-relative index of the target sample. Two samples in the same file
    # can share the same (rollout_n, step) tuple, so filtering by those alone
    # can point the recipient at the wrong row. When `index` is present the
    # backend treats it as the authoritative disambiguator.
    index: Optional[int] = None


@app.post("/api/share/create")
async def create_share_link(body: CreateShareRequest):
    """Create a signed share token for read-only access to specific samples.

    Requires full authentication (enforced by auth_middleware).
    Validates that the file path is within allowed boundaries.
    """
    try:
        if body.file.startswith("s3://"):
            s3_path = body.file[5:]
            bucket = s3_path.split("/", 1)[0]
            _validate_s3_bucket(bucket)
        else:
            _safe_resolve_path(body.file)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid file path")
    payload: Dict[str, Any] = {"f": body.file}
    if body.rollout is not None:
        payload["r"] = body.rollout
    if body.step is not None:
        payload["s"] = body.step
    if body.index is not None:
        payload["i"] = body.index
    token = share_serializer.dumps(payload)
    return {"token": token, "expires_in_days": SHARE_MAX_AGE // 86400}


@app.get("/api/share/verify")
async def verify_share_link(token: str = Query(...)):
    """Verify a share token and return its allowed scope. Public endpoint."""
    try:
        payload = share_serializer.loads(token, max_age=SHARE_MAX_AGE)
        return {
            "valid": True,
            "file": payload["f"],
            "rollout": payload.get("r"),
            "step": payload.get("s"),
            "index": payload.get("i"),
        }
    except (SignatureExpired, BadSignature):
        return {"valid": False}


class Message(BaseModel):
    role: str
    content: str


class SampleAttributes(BaseModel):
    step: int = 0
    sample_index: int = 0
    rollout_n: int = 0
    reward: float = 0.0
    data_source: str = "unknown"
    experiment_name: str = "unknown"
    is_validate: bool = False  # Renamed from 'validate' to avoid shadowing BaseModel.validate


class Sample(BaseModel):
    id: int
    messages: List[Message]
    attributes: SampleAttributes
    timestamp: str
    grades: Optional[Dict[str, List[Dict[str, Any]]]] = None  # metric_name -> list of grade entries


class FileInfo(BaseModel):
    key: str
    size: int
    last_modified: str


class SamplesResponse(BaseModel):
    samples: List[Sample]
    total: int
    experiment_name: str
    file_path: str
    has_grades: bool = False


# Grading models
class Quote(BaseModel):
    """A quoted section from a message that supports the grade."""
    message_index: int
    channel: Optional[str] = None
    start: int
    end: int
    text: str


class GradeEntry(BaseModel):
    """A single grade entry for a metric.

    extra="allow": producers write fields this schema doesn't know (e.g. the
    comments feature's tombstone `deletes` target) and the save merge must
    round-trip them losslessly — the default config silently strips them.
    """
    model_config = ConfigDict(extra="allow")

    grade: Union[bool, int, float, str]
    grade_type: str  # "float", "int", "bool", "freeform"
    quotes: List[Quote]
    explanation: str
    model: str
    prompt_version: str
    timestamp: str


_GRADE_MAX_SAMPLES = _config_int("VIZ_GRADE_MAX_SAMPLES", 100_000)
_GRADE_MAX_PROMPT_LEN = _config_int("VIZ_GRADE_MAX_PROMPT_LEN", 10_000)
_GRADE_MAX_PARALLEL = _config_int("VIZ_GRADE_MAX_PARALLEL", 500)
_GRADE_MAX_TOKENS = _config_int("VIZ_GRADE_MAX_TOKENS", 128_000)
_GRADE_DEFAULT_MAX_TOKENS = max(1, min(_config_int("VIZ_GRADE_DEFAULT_MAX_TOKENS", 32_768), _GRADE_MAX_TOKENS))
_GRADE_MAX_ATTEMPTS = _config_int("VIZ_GRADE_MAX_ATTEMPTS", 5)
_GRADE_MAX_QUOTE_RETRIES = _config_int("VIZ_GRADE_MAX_QUOTE_RETRIES", 2, minimum=0)
_GRADE_RATE_LIMIT_MAX = _config_int("VIZ_GRADE_RATE_LIMIT_MAX", 20)
_GRADE_RATE_LIMIT_WINDOW = _config_int("VIZ_GRADE_RATE_LIMIT_WINDOW_SECONDS", 60)
_GLOBAL_GRADING_SEM = asyncio.Semaphore(_config_int("VIZ_GRADE_GLOBAL_CONCURRENCY", 500))

class GradeRequest(BaseModel):
    """Request to grade samples."""
    file_path: str
    sample_ids: List[int]  # Which samples to grade
    metric_name: str
    metric_prompt: str  # The grading prompt
    grade_type: str  # "float", "int", "bool", "freeform"
    provider: str  # "openai", "anthropic", "google", "openrouter"
    model: str  # e.g., "gpt-4o", "claude-3-opus"
    router_provider: Optional[str] = None  # model_router provider: "litellm", "rl_late", or "tinker"
    max_attempts: Optional[int] = None  # Model-router grader attempts per sample
    api_key: Optional[str] = None  # Optional; authenticated sessions can use .env if omitted
    parallel_size: int = 10  # Number of concurrent requests
    require_quotes: bool = True  # Whether to require quotes from the model
    max_quote_retries: int = 2  # Max retries if quotes are required but missing
    # Advanced settings
    temperature: Optional[float] = None  # 0.0 - 2.0, None = model default
    max_tokens: Optional[int] = None  # Max output tokens
    reasoning_effort: Optional[str] = None  # "low", "medium", or "high"; None = provider default
    top_p: Optional[float] = None  # 0.0 - 1.0


_GRADING_PROVIDERS = {"openai", "anthropic", "google", "openrouter"}
_GRADING_REASONING_EFFORTS = {"low", "medium", "high"}
_ROUTER_PROVIDERS = {"litellm", "rl_late", "tinker"}


def _normalize_grading_provider(provider: str) -> str:
    normalized = provider.lower().strip()
    if normalized not in _GRADING_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail="provider must be one of openai, anthropic, google, or openrouter; use router_provider to select model_router backend",
        )
    return normalized


def _normalize_router_provider(router_provider: Optional[str]) -> str:
    normalized = (router_provider or "litellm").lower().strip()
    if normalized not in _ROUTER_PROVIDERS:
        raise HTTPException(status_code=400, detail="router_provider must be litellm, rl_late, or tinker")
    if normalized != "litellm":
        raise HTTPException(
            status_code=400,
            detail="rollout-viz grading currently supports router_provider=litellm only",
        )
    return normalized


def _validate_provider_model_pair(provider: str, model: str) -> None:
    if provider != "openrouter" and "/" in model:
        raise HTTPException(
            status_code=400,
            detail="routed model IDs containing '/' require provider=openrouter; use the provider's direct model ID otherwise",
        )


def _prepare_grading_route(provider: str, model: str, router_provider: Optional[str]) -> tuple[str, str]:
    normalized_provider = _normalize_grading_provider(provider)
    normalized_router = _normalize_router_provider(router_provider)
    _validate_provider_model_pair(normalized_provider, model)
    return normalized_provider, normalized_router


def _prepare_grade_request(request: GradeRequest) -> None:
    request.sample_ids = list(dict.fromkeys(request.sample_ids))
    request.max_quote_retries = max(0, min(request.max_quote_retries, _GRADE_MAX_QUOTE_RETRIES))
    request.parallel_size = max(1, min(request.parallel_size, _GRADE_MAX_PARALLEL))
    request.max_tokens = _GRADE_DEFAULT_MAX_TOKENS if request.max_tokens is None else max(1, min(request.max_tokens, _GRADE_MAX_TOKENS))
    if request.temperature is not None:
        request.temperature = max(0.0, min(request.temperature, 2.0))
    if request.top_p is not None:
        request.top_p = max(0.0, min(request.top_p, 1.0))
    if request.reasoning_effort is not None:
        request.reasoning_effort = request.reasoning_effort.lower().strip()
        if request.reasoning_effort not in _GRADING_REASONING_EFFORTS:
            raise HTTPException(status_code=400, detail="reasoning_effort must be low, medium, or high")
    request.provider, request.router_provider = _prepare_grading_route(
        request.provider, request.model, request.router_provider
    )
    if request.max_attempts is None:
        # The provider's attempt loop owns transport/tool-call/transient retries
        # with the full budget; do not starve it when require_quotes is True.
        request.max_attempts = _GRADE_MAX_ATTEMPTS
    request.max_attempts = max(1, min(request.max_attempts, _GRADE_MAX_ATTEMPTS))
    if len(request.sample_ids) > _GRADE_MAX_SAMPLES:
        raise HTTPException(status_code=400, detail=f"Too many samples (max {_GRADE_MAX_SAMPLES})")
    if len(request.metric_prompt) > _GRADE_MAX_PROMPT_LEN:
        raise HTTPException(status_code=400, detail=f"Prompt too long (max {_GRADE_MAX_PROMPT_LEN} chars)")


def _has_supporting_quotes(result: Optional[GradeResult]) -> bool:
    return bool(result and result.quotes)


def _missing_required_quotes_error(max_attempts: int) -> str:
    attempt_word = "attempt" if max_attempts == 1 else "attempts"
    return f"Missing required quotes after {max_attempts} grading {attempt_word}; no grade was saved"


def _grade_log_prefix(endpoint: str) -> str:
    return f"[{endpoint} Grading:{secrets.token_hex(4)}]"


def _log_grading_start(prefix: str, request: GradeRequest, *, actual_path: Optional[str] = None) -> None:
    path_note = f", file={actual_path}" if actual_path else ""
    print(
        f"{prefix} start samples={len(request.sample_ids)} provider={request.provider} "
        f"router_provider={request.router_provider} model={request.model} "
        f"require_quotes={request.require_quotes} provider_attempts={request.max_attempts} "
        f"max_tokens={request.max_tokens} reasoning_effort={request.reasoning_effort or 'auto'} "
        f"quote_retries_requested={request.max_quote_retries} parallel_size={request.parallel_size}{path_note}"
    )
    if request.require_quotes:
        print(
            f"{prefix} retry plan: backend_attempts=1; provider owns quote/tool-call retries "
            f"up to provider_attempts={request.max_attempts}"
        )


class GradeResponse(BaseModel):
    """Response from grading operation."""
    graded_count: int
    errors: List[Dict[str, Any]]
    grades: Dict[int, GradeEntry]  # sample_id -> grade


class SaveGradedRequest(BaseModel):
    """Request to save graded samples to viz/ directory."""
    file_path: str
    grades: Dict[int, Dict[str, GradeEntry]]  # sample_id -> {metric_name: grade}


class BatchSamplesRequest(BaseModel):
    """Request to load samples from multiple files in one request."""
    files: List[str]  # max 50 files per request
    metadata_only: bool = False


def _prepare_batch_files(files: List[str]) -> List[str]:
    if len(files) > _BATCH_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Too many files (max {_BATCH_MAX_FILES})")

    seen = set()
    total_local_size = 0
    prepared: List[str] = []
    for file_path in files:
        if file_path in seen:
            raise ValueError(f"Duplicate file in batch: {file_path}")
        seen.add(file_path)
        prepared.append(file_path)

        if file_path.startswith("s3://"):
            continue
        resolved = _safe_resolve_path(file_path)
        if resolved.exists() and resolved.is_file():
            total_local_size += resolved.stat().st_size
            if total_local_size > _BATCH_MAX_AGGREGATE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Batch files too large (max {_BATCH_MAX_AGGREGATE_BYTES // (1024 * 1024)}MB)",
                )

    return prepared


class PresetMetricInfo(BaseModel):
    """Information about a preset metric."""
    name: str
    description: str
    grade_type: str
    prompt: str
    is_custom: bool = False  # True if user-created


# --- S3 client singleton ---
_s3_client = None


def _get_s3_client():
    """Get or create a cached S3 client (singleton).
    Passes AWS credentials directly via boto3.Session instead of os.environ."""
    global _s3_client
    if _s3_client is None:
        import boto3
        from botocore.config import Config as BotoConfig
        s3_config = BotoConfig(
            max_pool_connections=25,
            connect_timeout=5,
            read_timeout=30,
            retries={'max_attempts': 3, 'mode': 'standard'},
        )
        session = boto3.Session(
            aws_access_key_id=_env_config.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=_env_config.get("AWS_SECRET_ACCESS_KEY"),
            region_name=_env_config.get("AWS_DEFAULT_REGION"),
        )
        _s3_client = session.client('s3', config=s3_config)
    return _s3_client


def _reset_s3_client():
    """Reset the cached S3 client. Used by tests."""
    global _s3_client
    _s3_client = None


# --- File loading cache ---
_file_cache: Dict[str, tuple] = {}  # key -> (validator, data, nbytes); validator is mtime (local) or ETag (S3)
_FILE_CACHE_MAX = 20
# Byte budget measured in RAW file bytes (parsed Python objects are larger,
# but raw size is proportional and free to obtain). Without this, 20 entries
# of up to MAX_FILE_SIZE each can exceed available memory.
_FILE_CACHE_MAX_BYTES = _config_int("VIZ_FILE_CACHE_MB", 4096) * 1024 * 1024
# Loaders run concurrently in threadpools (batch endpoint uses up to 10
# workers); insert+evict must be atomic or the eviction loop's iteration
# races concurrent inserts (RuntimeError: dict changed size during iteration).
_file_cache_lock = _threading.Lock()


def _cache_put(key: str, validator: Any, data: Any, nbytes: int) -> None:
    """Insert into the file cache, evicting oldest-inserted entries until both
    the entry-count cap and the byte budget hold. The newest entry is always
    kept, even when it alone exceeds the budget — evicting it would only force
    the next request to re-read the same file."""
    with _file_cache_lock:
        if key in _file_cache:
            del _file_cache[key]  # re-insert at the back of the FIFO order
        _file_cache[key] = (validator, data, nbytes)
        while len(_file_cache) > 1 and (
            len(_file_cache) > _FILE_CACHE_MAX
            or sum(entry[2] for entry in _file_cache.values()) > _FILE_CACHE_MAX_BYTES
        ):
            del _file_cache[next(iter(_file_cache))]


def _clear_file_cache():
    """Clear the file loading cache. Used by tests."""
    _file_cache.clear()


# --- viz_file_exists() TTL cache ---
_viz_exists_cache: Dict[str, tuple] = {}  # path -> (timestamp, bool)
_VIZ_EXISTS_TTL = 60  # seconds
_VIZ_EXISTS_MAX = 5000


def _clear_viz_exists_cache():
    """Clear the viz_exists cache. Used by tests."""
    _viz_exists_cache.clear()


def _safe_resolve_path(file_path: str) -> Path:
    """Resolve a file path and ensure it stays within PROJECT_ROOT."""
    path = Path(file_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    resolved = path.resolve()
    try:
        resolved.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        raise ValueError(f"Access denied: path is outside the project directory")
    return resolved


def load_jsonl_from_file(file_path: str) -> List[Dict[str, Any]]:
    """Load JSONL data from a local file. Caches by path + mtime."""
    path = _safe_resolve_path(file_path)
    path_str = str(path)
    stat = path.stat()
    current_mtime = stat.st_mtime
    if stat.st_size > MAX_FILE_SIZE:
        raise ValueError(f"File too large ({stat.st_size // (1024*1024)}MB, max {MAX_FILE_SIZE // (1024*1024)}MB)")

    # Check cache (single .get() is atomic under the GIL — a membership check
    # followed by a separate read could straddle a concurrent eviction)
    cached = _file_cache.get(path_str)
    if cached is not None:
        cached_mtime, cached_data, _ = cached
        if cached_mtime == current_mtime:
            return cached_data

    # Parse from disk (orjson is 5-10x faster than stdlib json)
    samples = []
    with open(path, 'rb') as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(orjson.loads(line))

    _cache_put(path_str, current_mtime, samples, stat.st_size)
    return samples


def _get_s3_etag(bucket: str, key: str) -> str:
    """Get the ETag for an S3 object via head_object (lightweight metadata call)."""
    s3_client = _get_s3_client()
    response = s3_client.head_object(Bucket=bucket, Key=key)
    return response['ETag']


_S3_MULTIPART_THRESHOLD = 5 * 1024 * 1024  # 5 MB — use chunked download above this
_S3_DOWNLOAD_CHUNKS = 3  # Number of parallel Range requests per file


def _download_s3_chunked(s3_client, bucket: str, key: str, size: int) -> bytes:
    """Download an S3 object using parallel Range requests.

    S3 throttles per-connection throughput, so splitting into multiple
    concurrent connections yields ~2x higher aggregate bandwidth.
    """
    n = _S3_DOWNLOAD_CHUNKS
    chunk_size = size // n
    results = [None] * n

    def _fetch(idx: int):
        start = idx * chunk_size
        end = size - 1 if idx == n - 1 else (idx + 1) * chunk_size - 1
        resp = s3_client.get_object(Bucket=bucket, Key=key, Range=f"bytes={start}-{end}")
        results[idx] = resp['Body'].read()

    with ThreadPoolExecutor(max_workers=n) as pool:
        list(pool.map(_fetch, range(n)))

    return b''.join(results)


def load_jsonl_from_s3(bucket: str, key: str) -> List[Dict[str, Any]]:
    """Load JSONL data from S3. Caches by s3://bucket/key + ETag.

    On warm cache: validates via head_object, returns cached data if ETag matches.
    On cold cache: uses head_object to get size, then parallel Range downloads
    for files above the multipart threshold (~2x faster than single-stream).
    """
    _validate_s3_bucket(bucket)
    cache_key = f"s3://{bucket}/{key}"
    s3_client = _get_s3_client()

    # Only check ETag if we have a cached version to compare against
    cached = _file_cache.get(cache_key)
    if cached is not None:
        current_etag = _get_s3_etag(bucket, key)
        cached_etag, cached_data, _ = cached
        if cached_etag == current_etag:
            return cached_data

    # Cold cache or stale — get size + ETag, then download
    head = s3_client.head_object(Bucket=bucket, Key=key)
    size = head['ContentLength']
    etag = head.get('ETag', '')
    if size > MAX_FILE_SIZE:
        raise ValueError(f"S3 file too large ({size // (1024*1024)}MB, max {MAX_FILE_SIZE // (1024*1024)}MB)")

    if size > _S3_MULTIPART_THRESHOLD:
        content = _download_s3_chunked(s3_client, bucket, key, size)
    else:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        content = response['Body'].read()
        etag = response.get('ETag', etag)

    samples = []
    for line in content.split(b'\n'):
        line = line.strip()
        if line:
            samples.append(orjson.loads(line))

    _cache_put(cache_key, etag, samples, size)
    return samples


def list_s3_files(bucket: str, prefix: str = "") -> List[Dict[str, Any]]:
    """List JSONL files in S3."""
    _validate_s3_bucket(bucket)
    s3_client = _get_s3_client()
    
    paginator = s3_client.get_paginator('list_objects_v2')
    files = []
    
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            if obj['Key'].endswith('.jsonl'):
                files.append({
                    'key': obj['Key'],
                    'size': obj['Size'],
                    'last_modified': obj['LastModified'].isoformat(),
                })
    
    return files


def list_s3_contents(bucket: str, prefix: str = "") -> Dict[str, List[Dict[str, Any]]]:
    """List both folders and JSONL files in S3 at the given prefix level (non-recursive)."""
    _validate_s3_bucket(bucket)
    s3_client = _get_s3_client()
    
    # Ensure prefix ends with / if it's not empty
    if prefix and not prefix.endswith('/'):
        prefix = prefix + '/'
    
    # Use delimiter to get "folder-like" behavior
    response = s3_client.list_objects_v2(
        Bucket=bucket,
        Prefix=prefix,
        Delimiter='/'
    )
    
    folders = []
    files = []
    
    # Get "folders" (common prefixes)
    for cp in response.get('CommonPrefixes', []):
        folder_prefix = cp['Prefix']
        # Get folder name (remove trailing /)
        folder_name = folder_prefix.rstrip('/').split('/')[-1]
        folders.append({
            'key': folder_prefix,
            'name': folder_name,
            'type': 'folder',
        })
    
    # Get files at this level
    for obj in response.get('Contents', []):
        key = obj['Key']
        # Skip the prefix itself
        if key == prefix:
            continue
        if key.endswith('.jsonl'):
            files.append({
                'key': key,
                'name': key.split('/')[-1],
                'size': obj['Size'],
                'last_modified': obj['LastModified'].isoformat(),
                'type': 'file',
            })
    
    return {'folders': folders, 'files': files}


def list_local_files(directory: str) -> List[Dict[str, Any]]:
    """List JSONL files in a local directory."""
    files = []
    dir_path = _safe_resolve_path(directory)

    if not dir_path.exists():
        return files
    
    for file_path in dir_path.glob("**/*.jsonl"):
        stat = file_path.stat()
        files.append({
            'key': str(file_path),
            'size': stat.st_size,
            'last_modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    
    return files


def list_local_contents(directory: str) -> Dict[str, List[Dict[str, Any]]]:
    """List both folders and JSONL files in a local directory (non-recursive)."""
    dir_path = _safe_resolve_path(directory)

    folders = []
    files = []

    if not dir_path.exists():
        return {'folders': folders, 'files': files}
    
    for item in dir_path.iterdir():
        if item.is_dir():
            folders.append({
                'key': str(item),
                'name': item.name,
                'type': 'folder',
            })
        elif item.is_file() and item.suffix == '.jsonl':
            stat = item.stat()
            files.append({
                'key': str(item),
                'name': item.name,
                'size': stat.st_size,
                'last_modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                'type': 'file',
            })
    
    # Sort folders and files by name
    folders.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    
    return {'folders': folders, 'files': files}


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/config")
async def server_config():
    """Non-secret cross-app wiring for the frontend.

    web_chat_base_url enables the "Open in web_chat" action on samples that
    carry a chat_id; unset (null) hides the action entirely."""
    web_chat_base = (_env_config.get("WEB_CHAT_BASE_URL") or "").strip().rstrip("/")
    return {"web_chat_base_url": web_chat_base or None}


@app.post("/api/debug/clear-cache")
async def debug_clear_cache():
    """Clear all backend caches. Used for benchmarking cold reads."""
    _clear_file_cache()
    _clear_viz_exists_cache()
    return {"status": "ok", "cleared": ["file_cache", "viz_exists_cache"]}


@app.get("/api/files/local", response_model=List[FileInfo])
async def get_local_files(directory: str = Query(default=".")):
    """List JSONL files in a local directory."""
    try:
        files = list_local_files(directory)
        return files
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e, expose=True))


@app.get("/api/files/s3", response_model=List[FileInfo])
async def get_s3_files(
    bucket: str = Query(...),
    prefix: str = Query(default="")
):
    """List JSONL files in an S3 bucket."""
    try:
        files = list_s3_files(bucket, prefix)
        return files
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_detail(e, expose=True))
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/api/contents/local")
async def get_local_contents(directory: str = Query(default=".")):
    """List folders and JSONL files in a local directory (non-recursive)."""
    try:
        contents = list_local_contents(directory)
        return contents
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/api/contents/s3")
async def get_s3_contents(
    bucket: str = Query(...),
    prefix: str = Query(default="")
):
    """List folders and JSONL files in an S3 bucket at a specific prefix (non-recursive)."""
    try:
        contents = list_s3_contents(bucket, prefix)
        return contents
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


_ATTR_DEFAULTS = {
    "step": 0, "sample_index": 0, "rollout_n": 0, "reward": 0.0,
    "data_source": "unknown", "experiment_name": "unknown", "is_validate": False,
}

# Single-file responses above this size avoid GZipMiddleware's event-loop
# compression path. If the client accepts gzip, compression happens in a worker
# thread; otherwise we mark the response identity to prevent middleware work.
_LARGE_SAMPLES_ASYNC_RENDER_THRESHOLD = 1000


def _render_large_json_response(data: dict, accepts_gzip: bool) -> tuple[bytes, str]:
    body = orjson.dumps(data)
    if accepts_gzip:
        return gzip.compress(body, compresslevel=1), "gzip"
    return body, "identity"


def _load_samples_sync(file: str, metadata_only: bool = False) -> dict:
    """Synchronous helper for loading samples — runs in a thread to avoid blocking the event loop.
    Returns a plain dict (skips Pydantic) for performance."""
    # Check if viz/ version exists and use it if so
    viz_path = get_viz_path(file)
    has_grades = False
    actual_path = file

    if viz_file_exists(viz_path):
        actual_path = viz_path
        has_grades = True

    if actual_path.startswith("s3://"):
        s3_path = actual_path[5:]
        bucket, key = s3_path.split("/", 1)
        raw_samples = load_jsonl_from_s3(bucket, key)
    else:
        raw_samples = load_jsonl_from_file(actual_path)

    # Build response dicts directly — skip Pydantic model construction
    samples = []
    experiment_name = "unknown"

    for i, raw in enumerate(raw_samples):
        attrs = dict(raw.get('attributes', {}))
        if experiment_name == "unknown":
            experiment_name = attrs.get('experiment_name', 'unknown')

        if 'validate' in attrs:
            attrs['is_validate'] = attrs.pop('validate')

        grades = raw.get('grades', None)
        if grades:
            has_grades = True

        # Apply defaults for missing attributes
        filled_attrs = {k: attrs.get(k, v) for k, v in _ATTR_DEFAULTS.items()}
        # Coerce numeric types — raw JSONL may have strings for numeric fields
        for int_key in ('step', 'sample_index', 'rollout_n'):
            try:
                filled_attrs[int_key] = int(filled_attrs[int_key])
            except (ValueError, TypeError):
                pass
        try:
            filled_attrs['reward'] = float(filled_attrs['reward'])
        except (ValueError, TypeError):
            pass
        # Preserve any extra attributes (e.g., source_file)
        for k, v in attrs.items():
            if k not in filled_attrs:
                filled_attrs[k] = v

        messages = raw.get('messages', [])
        samples.append({
            "id": i,
            "messages": [] if metadata_only else messages,
            "message_count": len(messages),
            "attributes": filled_attrs,
            "timestamp": raw.get('timestamp', ''),
            "grades": grades,
            "diagnostics": raw.get('diagnostics'),
            "raw_messages": [] if metadata_only else raw.get('raw_messages'),
            "raw_jsonl_entry": None if metadata_only else raw,
        })

    return {
        "samples": samples,
        "total": len(samples),
        "experiment_name": experiment_name,
        "file_path": file,
        "has_grades": has_grades,
    }


@app.get("/api/samples")
async def get_samples(
    request: Request,
    file: str = Query(..., description="Path to JSONL file (local path or s3://bucket/key)")
):
    """Load samples from a JSONL file.

    Automatically checks for a viz/ version first (which includes grades).
    Falls back to the original file if viz/ doesn't exist.
    Runs in a thread so multiple requests can load concurrently.

    In share mode, filters samples to only those matching the token's
    rollout/step constraints.
    """
    try:
        data = await asyncio.to_thread(_load_samples_sync, file)

        # Share mode: restrict to only the authorized samples
        if getattr(request.state, 'access_level', None) == 'share':
            payload = getattr(request.state, 'share_payload', {})
            samples = data["samples"]
            i = payload.get("i")
            if i is not None:
                # Authoritative: exact file-relative position. Picks the one
                # row the creator clicked even when (rollout_n, step) isn't
                # unique within the file.
                samples = [samples[i]] if 0 <= i < len(samples) else []
            else:
                # Legacy tokens (minted before `i` was added) — filter by
                # rollout/step. These may surface more than one sample when
                # (rollout_n, step) collides; the frontend picks samples[0].
                r = payload.get("r")
                s = payload.get("s")
                if r is not None:
                    samples = [sm for sm in samples if sm["attributes"].get("rollout_n") == r]
                if s is not None:
                    samples = [sm for sm in samples if sm["attributes"].get("step") == s]
            data = {**data, "samples": samples, "total": len(samples)}

        if data["total"] > _LARGE_SAMPLES_ASYNC_RENDER_THRESHOLD:
            accepts_gzip = "gzip" in request.headers.get("accept-encoding", "").lower()
            body, encoding = await asyncio.to_thread(_render_large_json_response, data, accepts_gzip)
            return Response(
                content=body,
                media_type="application/json",
                headers={"Content-Encoding": encoding, "Vary": "Accept-Encoding"},
            )

        return ORJSONResponse(content=data)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


def _load_samples_batch_sync(files: List[str], metadata_only: bool = False) -> dict:
    """Load samples from multiple files concurrently using a flat thread pool.

    For S3 files: uses chunked Range requests (3 chunks/file) across a single
    shared pool — avoids nested ThreadPoolExecutors and maximizes S3 throughput.
    For local files: delegates to _load_samples_sync.

    Returns combined samples with sequential IDs and source_file attributes.
    Partial failures are reported in the errors list without blocking other files.
    """
    if not files:
        return {"samples": [], "total": 0, "file_results": [], "experiment_names": [], "errors": []}

    errors: List[dict] = []
    # Separate S3 and local files
    s3_files = [(i, f) for i, f in enumerate(files) if f.startswith("s3://")]
    local_files = [(i, f) for i, f in enumerate(files) if not f.startswith("s3://")]
    per_file_data: List[Optional[dict]] = [None] * len(files)

    # --- Handle S3 files with flat chunked downloads ---
    if s3_files:
        s3_client = _get_s3_client()
        n_chunks = _S3_DOWNLOAD_CHUNKS

        # Phase 1: get metadata for all S3 files in parallel (viz check + size)
        s3_meta: Dict[int, dict] = {}  # idx -> {bucket, key, size, etag, actual_key, has_grades}

        def _get_meta(idx_file):
            idx, file_path = idx_file
            try:
                s3_path = file_path[5:]
                bucket, key = s3_path.split("/", 1)
                _validate_s3_bucket(bucket)

                viz_path = get_viz_path(file_path)
                has_grades = False
                actual_path = file_path
                if viz_file_exists(viz_path):
                    actual_path = viz_path
                    has_grades = True

                # Check file cache first
                cache_key = f"s3://{bucket}/{key}" if actual_path == file_path else actual_path
                if actual_path.startswith("s3://"):
                    ap = actual_path[5:]
                    a_bucket, a_key = ap.split("/", 1)
                    _validate_s3_bucket(a_bucket)
                    ck = f"s3://{a_bucket}/{a_key}"
                    cached = _file_cache.get(ck)
                    if cached is not None:
                        cached_etag, cached_data, _ = cached
                        curr_etag = _get_s3_etag(a_bucket, a_key)
                        if cached_etag == curr_etag:
                            s3_meta[idx] = {"cached": True, "data": cached_data, "has_grades": has_grades}
                            return

                    head = s3_client.head_object(Bucket=a_bucket, Key=a_key)
                    size = head['ContentLength']
                    if size > MAX_FILE_SIZE:
                        raise ValueError(f"S3 file too large ({size // (1024*1024)}MB)")
                    s3_meta[idx] = {
                        "cached": False, "bucket": a_bucket, "key": a_key,
                        "size": size, "etag": head.get('ETag', ''),
                        "has_grades": has_grades,
                    }
                else:
                    # viz path is local? shouldn't happen for S3 files
                    s3_meta[idx] = {"cached": False, "local_path": actual_path, "has_grades": has_grades}
            except Exception as e:
                errors.append({"file": idx_file[1], "error": _safe_error_detail(e)})
                per_file_data[idx] = None  # Mark as failed

        with ThreadPoolExecutor(max_workers=min(len(s3_files), 10)) as pool:
            list(pool.map(_get_meta, s3_files))

        total_s3_size = sum(
            meta.get("size", 0)
            for meta in s3_meta.values()
            if meta and not meta.get("cached") and not meta.get("local_path")
        )
        if total_s3_size > _BATCH_MAX_AGGREGATE_BYTES:
            raise ValueError(f"Batch S3 files too large (max {_BATCH_MAX_AGGREGATE_BYTES // (1024 * 1024)}MB)")

        # Phase 2: build all Range download tasks across all files (flat list)
        chunk_tasks = []  # (idx, bucket, key, range_start, range_end, chunk_idx)
        cached_results = {}  # idx -> raw_samples

        for idx, file_path in s3_files:
            meta = s3_meta.get(idx)
            if meta is None:
                continue  # Failed in phase 1
            if meta.get("cached"):
                cached_results[idx] = meta["data"]
                continue
            if meta.get("local_path"):
                # Shouldn't happen, but handle gracefully
                local_files.append((idx, meta["local_path"]))
                continue

            bucket, key, size = meta["bucket"], meta["key"], meta["size"]
            if size > _S3_MULTIPART_THRESHOLD:
                chunk_size = size // n_chunks
                for c in range(n_chunks):
                    start = c * chunk_size
                    end = size - 1 if c == n_chunks - 1 else (c + 1) * chunk_size - 1
                    chunk_tasks.append((idx, bucket, key, start, end, c))
            else:
                # Small file — single chunk
                chunk_tasks.append((idx, bucket, key, 0, size - 1, 0))

        # Phase 3: download all chunks in a single flat pool
        chunk_data: Dict[int, Dict[int, bytes]] = {}  # idx -> {chunk_idx: bytes}

        def _download_chunk(task):
            idx, bucket, key, start, end, chunk_idx = task
            resp = s3_client.get_object(Bucket=bucket, Key=key, Range=f"bytes={start}-{end}")
            return (idx, chunk_idx, resp['Body'].read())

        if chunk_tasks:
            max_workers = min(len(chunk_tasks), 24)
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                for idx, chunk_idx, data in pool.map(_download_chunk, chunk_tasks):
                    chunk_data.setdefault(idx, {})[chunk_idx] = data

        # Phase 4: reassemble and parse
        for idx, file_path in s3_files:
            meta = s3_meta.get(idx)
            if meta is None:
                per_file_data[idx] = None
                continue

            try:
                if idx in cached_results:
                    raw_samples = cached_results[idx]
                elif idx in chunk_data:
                    chunks = chunk_data[idx]
                    n_file_chunks = max(chunks.keys()) + 1
                    content = b''.join(chunks[c] for c in range(n_file_chunks))
                    raw_samples = []
                    for line in content.split(b'\n'):
                        line = line.strip()
                        if line:
                            raw_samples.append(orjson.loads(line))

                    # Cache with ETag
                    etag = meta.get("etag", "")
                    cache_key = f"s3://{meta['bucket']}/{meta['key']}"
                    _cache_put(cache_key, etag, raw_samples, meta.get("size", 0))
                else:
                    per_file_data[idx] = None
                    continue

                # Build sample dicts (same as _load_samples_sync)
                has_grades = meta.get("has_grades", False)
                samples = []
                experiment_name = "unknown"
                for i, raw in enumerate(raw_samples):
                    attrs = dict(raw.get('attributes', {}))
                    if experiment_name == "unknown":
                        experiment_name = attrs.get('experiment_name', 'unknown')
                    if 'validate' in attrs:
                        attrs['is_validate'] = attrs.pop('validate')
                    grades = raw.get('grades', None)
                    if grades:
                        has_grades = True
                    filled_attrs = {k: attrs.get(k, v) for k, v in _ATTR_DEFAULTS.items()}
                    # Coerce numeric types — raw JSONL may have strings
                    for int_key in ('step', 'sample_index', 'rollout_n'):
                        try:
                            filled_attrs[int_key] = int(filled_attrs[int_key])
                        except (ValueError, TypeError):
                            pass
                    try:
                        filled_attrs['reward'] = float(filled_attrs['reward'])
                    except (ValueError, TypeError):
                        pass
                    for k, v in attrs.items():
                        if k not in filled_attrs:
                            filled_attrs[k] = v
                    messages = raw.get('messages', [])
                    samples.append({
                        "id": i,
                        "messages": [] if metadata_only else messages,
                        "message_count": len(messages),
                        "attributes": filled_attrs, "timestamp": raw.get('timestamp', ''),
                        "grades": grades,
                        "diagnostics": raw.get('diagnostics'),
                        "raw_messages": [] if metadata_only else raw.get('raw_messages'),
                        "raw_jsonl_entry": None if metadata_only else raw,
                    })

                per_file_data[idx] = {
                    "samples": samples, "total": len(samples),
                    "experiment_name": experiment_name,
                    "file_path": file_path, "has_grades": has_grades,
                }
            except Exception as e:
                errors.append({"file": file_path, "error": _safe_error_detail(e)})
                per_file_data[idx] = None

    # --- Handle local files with _load_samples_sync ---
    if local_files:
        def _load_local(idx_file):
            idx, file_path = idx_file
            try:
                per_file_data[idx] = _load_samples_sync(file_path, metadata_only=metadata_only)
            except Exception as e:
                errors.append({"file": file_path, "error": _safe_error_detail(e)})
                per_file_data[idx] = None

        with ThreadPoolExecutor(max_workers=min(len(local_files), 10)) as pool:
            list(pool.map(_load_local, local_files))

    # --- Combine results in original file order ---
    combined_samples = []
    file_results = []
    experiment_names_set: set = set()
    next_id = 0
    total_raw_bytes = 0

    def _cached_raw_bytes(fp: str) -> int:
        """Raw byte size of a just-loaded file, read from the cache entry the
        load created (viz/ overlay path preferred — that's what was read).
        Lets the frontend size-gate bulk hydration: 767 long agentic rollouts
        can weigh 400MB+, which a sample-count threshold alone misses."""
        for candidate in (get_viz_path(fp), fp):
            if candidate.startswith("s3://"):
                cache_key = candidate
            else:
                try:
                    cache_key = str(_safe_resolve_path(candidate))
                except ValueError:
                    continue
            entry = _file_cache.get(cache_key)
            if entry is not None:
                return entry[2]
        return 0

    for idx, file_path in enumerate(files):
        data = per_file_data[idx]
        if data is None:
            file_results.append({"file": file_path, "count": 0, "error": True})
            continue
        total_raw_bytes += _cached_raw_bytes(file_path)

        exp_name = data.get("experiment_name", "unknown")
        if exp_name and exp_name != "unknown":
            experiment_names_set.add(exp_name)

        file_sample_count = 0
        for sample in data["samples"]:
            if next_id >= _BATCH_MAX_SAMPLES:
                raise ValueError(f"Too many samples in batch (max {_BATCH_MAX_SAMPLES})")
            s = {**sample, "id": next_id, "attributes": {**sample.get("attributes", {}), "source_file": file_path}}
            combined_samples.append(s)
            next_id += 1
            file_sample_count += 1

        file_results.append({"file": file_path, "count": file_sample_count})

    return {
        "samples": combined_samples,
        "total": len(combined_samples),
        "file_results": file_results,
        "experiment_names": sorted(experiment_names_set),
        "errors": errors,
        "total_raw_bytes": total_raw_bytes,
    }


@app.post("/api/samples/batch")
async def get_samples_batch(request: BatchSamplesRequest):
    """Load samples from multiple files in a single request.

    Downloads files concurrently via thread pool, combines samples with
    sequential IDs and source_file attributes. Max 50 files per request.
    For metadata_only requests, uses ORJSONResponse (allows gzip — small payload benefits from compression).
    For full requests, skips GZipMiddleware by setting Content-Encoding: identity
    — for 155 MB payloads, gzip at level 1 adds ~1.4s of CPU that's wasted
    on localhost/proxy traffic.
    """
    try:
        files = _prepare_batch_files(request.files)
        data = await asyncio.to_thread(_load_samples_batch_sync, files, request.metadata_only)
        if request.metadata_only:
            return ORJSONResponse(content=data)
        body = orjson.dumps(data)
        if len(body) > _BATCH_MAX_RESPONSE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Batch response too large (max {_BATCH_MAX_RESPONSE_BYTES // (1024 * 1024)}MB)",
            )
        return Response(
            content=body,
            media_type="application/json",
            headers={"Content-Encoding": "identity"},
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_detail(e, expose=True))
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


def _load_single_sample_sync(file: str, sample_id: int) -> dict:
    """Synchronous helper for loading a single sample — runs in a thread."""
    # Check if viz/ version exists and use it if so
    viz_path = get_viz_path(file)
    actual_path = file

    if viz_file_exists(viz_path):
        actual_path = viz_path

    if actual_path.startswith("s3://"):
        s3_path = actual_path[5:]
        bucket, key = s3_path.split("/", 1)
        raw_samples = load_jsonl_from_s3(bucket, key)
    else:
        raw_samples = load_jsonl_from_file(actual_path)

    if sample_id < 0 or sample_id >= len(raw_samples):
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")

    raw = raw_samples[sample_id]
    attrs = dict(raw.get('attributes', {}))
    if 'validate' in attrs:
        attrs['is_validate'] = attrs.pop('validate')

    filled_attrs = {k: attrs.get(k, v) for k, v in _ATTR_DEFAULTS.items()}
    # Coerce numeric types — raw JSONL may have strings
    for int_key in ('step', 'sample_index', 'rollout_n'):
        try:
            filled_attrs[int_key] = int(filled_attrs[int_key])
        except (ValueError, TypeError):
            pass
    try:
        filled_attrs['reward'] = float(filled_attrs['reward'])
    except (ValueError, TypeError):
        pass
    for k, v in attrs.items():
        if k not in filled_attrs:
            filled_attrs[k] = v

    messages = raw.get('messages', [])
    return {
        "id": sample_id,
        "messages": messages,
        "message_count": len(messages),
        "attributes": filled_attrs,
        "timestamp": raw.get('timestamp', ''),
        "grades": raw.get('grades', None),
        "diagnostics": raw.get('diagnostics'),
        "raw_messages": raw.get('raw_messages'),
        "raw_jsonl_entry": raw,
    }


@app.get("/api/sample/{sample_id}")
async def get_sample(
    request: Request,
    sample_id: int,
    file: str = Query(..., description="Path to JSONL file")
):
    """Get a single sample by ID.

    In share mode, validates the sample matches the token's constraints.
    """
    try:
        data = await asyncio.to_thread(_load_single_sample_sync, file, sample_id)

        # Share mode: verify this sample is within the authorized scope
        if getattr(request.state, 'access_level', None) == 'share':
            payload = getattr(request.state, 'share_payload', {})
            i = payload.get("i")
            if i is not None:
                # Authoritative: only the sample at file-relative index `i`
                # is authorized. `sample_id` is the caller's requested file
                # index (see _load_single_sample_sync).
                if sample_id != i:
                    raise HTTPException(status_code=403, detail="Sample not authorized for this share link")
            else:
                # Legacy tokens: fall back to rollout/step attribute check.
                attrs = data.get("attributes", {})
                r = payload.get("r")
                s = payload.get("s")
                if r is not None and attrs.get("rollout_n") != r:
                    raise HTTPException(status_code=403, detail="Sample not authorized for this share link")
                if s is not None and attrs.get("step") != s:
                    raise HTTPException(status_code=403, detail="Sample not authorized for this share link")

        return JSONResponse(content=data)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# Helper functions for viz/ path handling

def get_viz_path(original_path: str) -> str:
    """Get the viz/ subdirectory path for a file.
    
    For /path/to/file.jsonl -> /path/to/viz/file.jsonl
    For s3://bucket/path/file.jsonl -> s3://bucket/path/viz/file.jsonl
    """
    if original_path.startswith("s3://"):
        # S3 path
        s3_path = original_path[5:]  # Remove 's3://'
        parts = s3_path.rsplit("/", 1)
        if len(parts) == 2:
            prefix, filename = parts
            return f"s3://{prefix}/viz/{filename}"
        else:
            return f"s3://viz/{s3_path}"
    else:
        # Local path
        path = Path(original_path)
        return str(path.parent / "viz" / path.name)


def viz_file_exists(viz_path: str) -> bool:
    """Check if the viz/ version of a file exists. Uses a TTL cache."""
    now = time.time()

    # Check cache
    if viz_path in _viz_exists_cache:
        cached_time, cached_result = _viz_exists_cache[viz_path]
        if now - cached_time < _VIZ_EXISTS_TTL:
            return cached_result

    # Perform actual check
    if viz_path.startswith("s3://"):
        try:
            s3_path = viz_path[5:]
            bucket, key = s3_path.split("/", 1)
            _validate_s3_bucket(bucket)
            s3_client = _get_s3_client()
            s3_client.head_object(Bucket=bucket, Key=key)
            result = True
        except Exception:
            result = False
    else:
        try:
            path = _safe_resolve_path(viz_path)
            result = path.exists()
        except ValueError:
            result = False

    if len(_viz_exists_cache) >= _VIZ_EXISTS_MAX:
        oldest = min(_viz_exists_cache, key=lambda k: _viz_exists_cache[k][0])
        del _viz_exists_cache[oldest]
    _viz_exists_cache[viz_path] = (now, result)
    return result


def save_jsonl_to_file(file_path: str, samples: List[Dict[str, Any]]) -> None:
    """Save samples to a local JSONL file. Uses atomic write-to-temp + rename."""
    path = _safe_resolve_path(file_path)

    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as f:
            for sample in samples:
                f.write(orjson.dumps(sample) + b'\n')
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, str(path))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    path_str = str(path)
    _file_cache.pop(path_str, None)
    now = time.time()
    _viz_exists_cache[path_str] = (now, True)
    if file_path != path_str:
        _viz_exists_cache[file_path] = (now, True)


def save_jsonl_to_s3(bucket: str, key: str, samples: List[Dict[str, Any]]) -> None:
    """Save samples to S3 as JSONL."""
    _validate_s3_bucket(bucket)
    s3_client = _get_s3_client()

    content = b'\n'.join(orjson.dumps(sample) for sample in samples)
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=content,
        ContentType='application/jsonl'
    )

    # Invalidate file cache so next load fetches from S3
    cache_key = f"s3://{bucket}/{key}"
    _file_cache.pop(cache_key, None)
    # Update viz_exists cache
    _viz_exists_cache[cache_key] = (time.time(), True)


# Path to store custom metrics
CUSTOM_METRICS_FILE = PROJECT_ROOT / "custom_metrics.json"
_custom_metrics_lock = asyncio.Lock()


def load_custom_metrics() -> Dict[str, dict]:
    """Load custom metrics from file."""
    if CUSTOM_METRICS_FILE.exists():
        try:
            with open(CUSTOM_METRICS_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def save_custom_metrics(metrics: Dict[str, dict]) -> None:
    """Save custom metrics to file. Uses atomic write."""
    fd, tmp_path = tempfile.mkstemp(dir=str(CUSTOM_METRICS_FILE.parent), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(metrics, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, str(CUSTOM_METRICS_FILE))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@app.get("/api/preset-metrics", response_model=Dict[str, PresetMetricInfo])
async def get_preset_metrics():
    """Get available preset metrics for grading (includes saved custom metrics)."""
    # Start with built-in presets
    all_metrics = {
        key: PresetMetricInfo(**value)
        for key, value in PRESET_METRICS.items()
    }
    
    # Add custom metrics (marked as custom)
    custom_metrics = load_custom_metrics()
    for key, value in custom_metrics.items():
        # Don't override built-in presets
        if key not in all_metrics:
            all_metrics[key] = PresetMetricInfo(**value)
    
    return all_metrics


_MAX_SAVE_LOCKS = 1000

class SaveCustomMetricRequest(BaseModel):
    """Request to save a custom metric."""
    key: str  # Unique identifier (lowercase, no spaces, max 100 chars)
    name: str  # Display name (max 200 chars)
    description: str  # max 1000 chars
    grade_type: str  # 'float', 'int', 'bool', or 'freeform'
    prompt: str  # max 50000 chars


@app.post("/api/save-custom-metric")
async def save_custom_metric(request: SaveCustomMetricRequest):
    """Save a custom metric for future use."""
    if len(request.key) > 100 or len(request.name) > 200 or len(request.description) > 1000 or len(request.prompt) > 50000:
        raise HTTPException(status_code=400, detail="Field too long")
    if request.grade_type not in ("float", "int", "bool", "freeform"):
        raise HTTPException(status_code=400, detail="grade_type must be 'float', 'int', 'bool', or 'freeform'")
    key = request.key.lower().replace(" ", "_")
    
    if key in PRESET_METRICS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot override built-in preset '{key}'"
        )
    
    async with _custom_metrics_lock:
        custom_metrics = load_custom_metrics()
        custom_metrics[key] = {
            "name": request.name,
            "description": request.description,
            "grade_type": request.grade_type,
            "prompt": request.prompt,
            "is_custom": True,
        }
        save_custom_metrics(custom_metrics)
    
    return {"status": "saved", "key": key}


@app.delete("/api/custom-metric/{key}")
async def delete_custom_metric(key: str):
    """Delete a custom metric."""
    async with _custom_metrics_lock:
        custom_metrics = load_custom_metrics()
        if key not in custom_metrics:
            raise HTTPException(status_code=404, detail=f"Custom metric '{key}' not found")
        del custom_metrics[key]
        save_custom_metrics(custom_metrics)
    
    return {"status": "deleted", "key": key}


@app.get("/api/available-api-keys")
async def get_available_api_keys(request: Request):
    """Check which API keys are available from server environment (.env file)."""
    available = {}
    reveal_server_keys = _can_use_server_api_keys(request)
    for provider, env_vars in API_KEY_ENV_VARS.items():
        available[provider] = reveal_server_keys and any(bool(_env_config.get(env_var)) for env_var in env_vars)
    return available


class TestProviderRequest(BaseModel):
    """Request to test an LLM provider connection."""
    provider: str
    model: str
    router_provider: Optional[str] = None
    api_key: Optional[str] = None


# Cache for test-provider results: (provider, model, key_hash) -> (timestamp, ok)
_test_provider_cache: Dict[tuple, tuple] = {}
_TEST_PROVIDER_TTL = 300  # 5 minutes
_TEST_PROVIDER_MAX = 1000
_TEST_PROVIDER_RATE_LIMIT_MAX = _config_int("VIZ_TEST_PROVIDER_RATE_LIMIT_MAX", 10)
_TEST_PROVIDER_RATE_LIMIT_WINDOW = _config_int("VIZ_TEST_PROVIDER_RATE_LIMIT_WINDOW_SECONDS", 60)

def _clear_test_provider_cache():
    """Clear the test-provider cache (for tests)."""
    _test_provider_cache.clear()

@app.post("/api/test-provider")
async def test_provider(request: TestProviderRequest, http_request: Request):
    """Test that an LLM provider + model + API key combination works.

    Makes a minimal API call to validate the configuration before
    starting a full grading job. Results are cached for 5 minutes.
    """
    try:
        _enforce_window_rate_limit(
            "test-provider",
            http_request,
            max_requests=_TEST_PROVIDER_RATE_LIMIT_MAX,
            window_seconds=_TEST_PROVIDER_RATE_LIMIT_WINDOW,
        )
        provider_name, router_provider = _prepare_grading_route(
            request.provider, request.model, request.router_provider
        )
        api_key = _resolve_llm_api_key(provider_name, request.api_key, http_request)

        # Check cache
        import hashlib
        key_hash = hashlib.sha256(api_key.encode()).hexdigest()[:16]
        cache_key = (provider_name, request.model, router_provider, key_hash)
        now = time.time()
        if cache_key in _test_provider_cache:
            cached_time, cached_ok = _test_provider_cache[cache_key]
            if now - cached_time < _TEST_PROVIDER_TTL:
                return {"ok": cached_ok}

        provider = get_provider(
            provider_name,
            api_key,
            request.model,
            max_tokens=200,
            router_url=MODEL_ROUTER_URL,
            router_provider=router_provider,
            max_attempts=2,
        )

        # Make a minimal call to validate the key + model.
        try:
            await provider.grade_sample(
                messages=[{"role": "user", "content": "Say OK."}],
                metric_prompt="Is this message polite? Grade as true or false.",
                grade_type="bool",
                require_quotes=False,
            )
        except (ValueError, InvalidGradeResponse):
            # ValueError = legacy JSON parse error; InvalidGradeResponse = router-path
            # formatting/validation miss. Either way the API responded and the
            # connection works, so the pre-flight passes.
            pass
        if len(_test_provider_cache) >= _TEST_PROVIDER_MAX:
            oldest = min(_test_provider_cache, key=lambda k: _test_provider_cache[k][0])
            del _test_provider_cache[oldest]
        _test_provider_cache[cache_key] = (now, True)
        return {"ok": True}
    except HTTPException as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"ok": False, "error": _safe_error_detail(e, expose=True)}
        )
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": _safe_error_detail(e, expose=True)}
        )


@app.post("/api/grade", response_model=GradeResponse)
async def grade_samples(request: GradeRequest, http_request: Request):
    """Grade samples using an LLM provider."""
    _prepare_grade_request(request)
    _enforce_window_rate_limit(
        "grade",
        http_request,
        max_requests=_GRADE_RATE_LIMIT_MAX,
        window_seconds=_GRADE_RATE_LIMIT_WINDOW,
    )
    try:
        api_key = _resolve_llm_api_key(request.provider, request.api_key, http_request)

        # Load the samples (check viz/ version first, same as GET /api/samples)
        actual_path = request.file_path
        viz_path = get_viz_path(request.file_path)
        if viz_file_exists(viz_path):
            actual_path = viz_path

        if actual_path.startswith("s3://"):
            s3_path = actual_path[5:]
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(actual_path)

        prefix = _grade_log_prefix("HTTP")
        _log_grading_start(prefix, request, actual_path=actual_path)

        # Get the LLM provider with advanced settings
        provider = get_provider(
            request.provider,
            api_key,
            request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            top_p=request.top_p,
            router_url=MODEL_ROUTER_URL,
            router_provider=request.router_provider,
            max_attempts=request.max_attempts,
            reasoning_effort=request.reasoning_effort,
        )

        # Grade each requested sample
        grades: Dict[int, GradeEntry] = {}
        errors: List[Dict[str, Any]] = []

        async def grade_one(sample_id: int) -> tuple:
            if sample_id < 0 or sample_id >= len(raw_samples):
                return sample_id, None, f"Sample {sample_id} not found"
            
            raw = raw_samples[sample_id]
            messages = raw.get('messages', [])
            
            try:
                context_token = set_grading_log_context({"prefix": prefix, "sample_id": sample_id})
                try:
                    result = await provider.grade_sample(
                        messages=messages,
                        metric_prompt=request.metric_prompt,
                        grade_type=request.grade_type,
                        require_quotes=request.require_quotes,
                        is_quote_retry=False,
                    )
                finally:
                    reset_grading_log_context(context_token)

                # The provider (grade_sample) is the single source of truth for quote
                # handling. A returned grade with empty quotes is intentional (the
                # provider exhausted its quote-retry budget) and must be saved.
                grade_entry = GradeEntry(
                    grade=result.grade,
                    grade_type=result.grade_type,
                    quotes=[Quote(**q.model_dump()) for q in result.quotes],
                    explanation=result.explanation,
                    model=result.model,
                    prompt_version=result.prompt_version,
                    timestamp=result.timestamp,
                )
                return sample_id, grade_entry, None
            except Exception as e:
                return sample_id, None, _safe_error_detail(e, expose=True)
        
        batch_size = min(request.parallel_size, _GRADE_MAX_PARALLEL)

        async def _grade_with_global_limit(sid: int):
            async with _GLOBAL_GRADING_SEM:
                return await grade_one(sid)

        total_start = time.time()
        print(f"{prefix} batching batch_size={batch_size}")
        
        for i in range(0, len(request.sample_ids), batch_size):
            batch = request.sample_ids[i:i + batch_size]
            batch_start = time.time()
            results = await asyncio.gather(*[_grade_with_global_limit(sid) for sid in batch])
            batch_time = time.time() - batch_start
            
            for sample_id, grade_entry, error in results:
                if error:
                    errors.append({"sample_id": sample_id, "error": error})
                elif grade_entry:
                    grades[sample_id] = grade_entry
            
            print(f"{prefix} batch {i//batch_size + 1}: {len(batch)} samples in {batch_time:.2f}s ({batch_time/len(batch):.2f}s per sample)")
        
        total_time = time.time() - total_start
        print(f"{prefix} complete: {len(grades)} graded, {len(errors)} errors in {total_time:.2f}s")
        
        return GradeResponse(
            graded_count=len(grades),
            errors=errors,
            grades=grades,
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e, expose=True))


@app.post("/api/grade-stream")
async def grade_samples_stream(request: GradeRequest, http_request: Request):
    """Start a persistent grading job and stream its progress (SSE).

    The grading work runs as a detached background task owned by the job
    registry, so a client disconnect (e.g. a page reload) does NOT stop it.
    Grades flush to viz/ incrementally, and a reloaded page can reattach via
    GET /api/grade-jobs/{job_id}/stream. An in-flight job does not survive a
    backend restart, but grades already written to viz/ do.
    """
    _prepare_grade_request(request)
    _enforce_window_rate_limit(
        "grade-stream",
        http_request,
        max_requests=_GRADE_RATE_LIMIT_MAX,
        window_seconds=_GRADE_RATE_LIMIT_WINDOW,
    )
    prefix = _grade_log_prefix("SSE")

    async def generate():
        # Key resolution, sample loading, provider build and job creation happen
        # here so any failure is surfaced as an SSE 'error' event (the contract
        # clients rely on), not an HTTP error mid-handshake.
        try:
            _log_grading_start(prefix, request)
            api_key = _resolve_llm_api_key(request.provider, request.api_key, http_request)

            # One active job per file: if one is already running, tell the client
            # the existing job_id so it can reattach instead of double-grading.
            lock_key = _grade_lock_key(request.file_path)
            async with _GRADE_JOBS_LOCK:
                existing_id = _GRADE_JOBS_BY_FILE.get(lock_key)
                if existing_id and existing_id in _GRADE_JOBS and _GRADE_JOBS[existing_id].status == "running":
                    yield f"data: {json.dumps({'type': 'error', 'message': 'A grading job is already running for this file.', 'job_id': existing_id})}\n\n"
                    return

            actual_path = request.file_path
            viz_path = get_viz_path(request.file_path)
            if await asyncio.to_thread(viz_file_exists, viz_path):
                actual_path = viz_path
            if actual_path.startswith("s3://"):
                s3_path = actual_path[5:]
                bucket, key = s3_path.split("/", 1)
                raw_samples = await asyncio.to_thread(load_jsonl_from_s3, bucket, key)
            else:
                raw_samples = await asyncio.to_thread(load_jsonl_from_file, actual_path)
            print(f"{prefix} loaded {len(raw_samples)} samples from {actual_path}, grading IDs: {request.sample_ids[:5]}{'...' if len(request.sample_ids) > 5 else ''}")

            provider = get_provider(
                request.provider,
                api_key,
                request.model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                top_p=request.top_p,
                router_url=MODEL_ROUTER_URL,
                router_provider=request.router_provider,
                max_attempts=request.max_attempts,
                reasoning_effort=request.reasoning_effort,
            )

            job_id = secrets.token_hex(8)
            job = GradeJob(job_id, request, raw_samples, provider, prefix)
            async with _GRADE_JOBS_LOCK:
                _GRADE_JOBS[job_id] = job
                _GRADE_JOBS_BY_FILE[lock_key] = job_id
                _evict_finished_jobs()
            # Subscribe BEFORE starting the task so this stream cannot miss events.
            listener = _subscribe(job)
            job.task = asyncio.create_task(_run_grade_job(job))

            yield f"data: {json.dumps({'type': 'started', 'job_id': job_id, 'total': job.total})}\n\n"
            try:
                while True:
                    try:
                        ev = await asyncio.wait_for(listener.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if ev.get("type") == "__end__":
                        return
                    yield f"data: {json.dumps(ev)}\n\n"
            finally:
                _unsubscribe(job, listener)
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': _safe_error_detail(e, expose=True)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
_save_locks: Dict[str, asyncio.Lock] = {}


def _grade_lock_key(file_path: str) -> str:
    """Stable per-file key shared by the save lock and the job registry."""
    if file_path.startswith("s3://"):
        return file_path
    return str(_safe_resolve_path(file_path))


def _merge_grades_into_samples(
    raw_samples: List[Dict[str, Any]],
    grades: Dict[Any, Dict[str, Any]],
) -> int:
    """Append each {sample_id -> {metric -> grade_entry}} into sample['grades'].

    Copy-on-write per touched sample; append semantics (never overwrites prior
    grades). Returns the number of samples updated.
    """
    samples_updated = 0
    for sample_id_str, metric_grades in grades.items():
        sample_id = int(sample_id_str)
        if sample_id < 0 or sample_id >= len(raw_samples):
            continue
        sample = copy.deepcopy(raw_samples[sample_id])
        raw_samples[sample_id] = sample
        if 'grades' not in sample:
            sample['grades'] = {}
        for metric_name, grade_entry in metric_grades.items():
            if metric_name not in sample['grades']:
                sample['grades'][metric_name] = []
            if isinstance(grade_entry, dict):
                sample['grades'][metric_name].append(grade_entry)
            else:
                sample['grades'][metric_name].append(grade_entry.model_dump())
        samples_updated += 1
    return samples_updated


async def _save_grades_for_file(file_path: str, grades: Dict[Any, Dict[str, Any]]) -> int:
    """Merge grades into viz/<file>.jsonl under the per-file lock (atomic write).

    Shared by POST /api/save-graded and the background grading writer so the two
    can never interleave writes to the same file.
    """
    lock_key = _grade_lock_key(file_path)
    if len(_save_locks) >= _MAX_SAVE_LOCKS:
        oldest_key = next(iter(_save_locks))
        del _save_locks[oldest_key]
    lock = _save_locks.setdefault(lock_key, asyncio.Lock())

    async with lock:
        viz_path = get_viz_path(file_path)
        if await asyncio.to_thread(viz_file_exists, viz_path):
            source_path = viz_path
        else:
            source_path = file_path

        if source_path.startswith("s3://"):
            s3_path = source_path[5:]
            bucket, key = s3_path.split("/", 1)
            raw_samples = await asyncio.to_thread(load_jsonl_from_s3, bucket, key)
        else:
            raw_samples = await asyncio.to_thread(load_jsonl_from_file, source_path)

        raw_samples = list(raw_samples)
        samples_updated = _merge_grades_into_samples(raw_samples, grades)

        if viz_path.startswith("s3://"):
            s3_path = viz_path[5:]
            bucket, key = s3_path.split("/", 1)
            await asyncio.to_thread(save_jsonl_to_s3, bucket, key, raw_samples)
        else:
            await asyncio.to_thread(save_jsonl_to_file, viz_path, raw_samples)
        return samples_updated


@app.post("/api/save-graded")
async def save_graded_samples(request: SaveGradedRequest):
    """Merge new grades into viz/<file>.jsonl (per-file locked, append semantics)."""
    try:
        _grade_lock_key(request.file_path)  # validate/resolve path early
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error_detail(e, expose=True))
    try:
        samples_updated = await _save_grades_for_file(request.file_path, request.grades)
        return {"success": True, "samples_updated": samples_updated}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error_detail(e, expose=True))


# --- Persistent grading jobs ------------------------------------------------
# A grading job runs as a detached background task so it survives client
# disconnects (page reloads). Grades flush to viz/ incrementally; the SSE
# request and any reattach stream are thin readers over the job's event fan-out.
# A page reload is fully supported; an in-flight job does NOT survive a backend
# restart (grades already flushed to viz/ do).

_FLUSH_EVERY_N = _config_int("VIZ_GRADE_FLUSH_EVERY_N", 25)
_FLUSH_EVERY_S = _config_int("VIZ_GRADE_FLUSH_EVERY_SECONDS", 10)
_MAX_FINISHED_JOBS = _config_int("VIZ_GRADE_MAX_FINISHED_JOBS", 50)


class GradeJob:
    def __init__(self, job_id, request, raw_samples, provider, prefix):
        self.job_id = job_id
        self.request = request
        self.file_path = request.file_path
        self.metric_name = request.metric_name
        self.grade_type = request.grade_type
        self.sample_ids = list(request.sample_ids)
        self.total = len(self.sample_ids)
        self.raw_samples = raw_samples
        self.provider = provider
        self.prefix = prefix
        self.completed = 0
        self.grades: Dict[int, dict] = {}
        self.saved_ids: set = set()
        self.errors: List[Dict[str, Any]] = []
        self.status = "running"
        self.error_message: Optional[str] = None
        self.created_at = time.time()
        self.finished_at: Optional[float] = None
        self.last_flush = 0.0
        self.flush_error: Optional[str] = None
        self.task: Optional[asyncio.Task] = None
        self.cancel_requested = False
        self.event_seq = 0
        self._listeners: List[asyncio.Queue] = []


_GRADE_JOBS: Dict[str, "GradeJob"] = {}
_GRADE_JOBS_BY_FILE: Dict[str, str] = {}
_GRADE_JOBS_LOCK = asyncio.Lock()


def _evict_finished_jobs() -> None:
    finished = [jid for jid, j in _GRADE_JOBS.items() if j.finished_at is not None]
    while len(finished) > _MAX_FINISHED_JOBS:
        _GRADE_JOBS.pop(finished.pop(0), None)


def _emit(job: "GradeJob", event: dict) -> None:
    job.event_seq += 1
    event = {**event, "seq": job.event_seq}
    for q in list(job._listeners):
        try:
            q.put_nowait(event)
        except Exception:
            pass


def _subscribe(job: "GradeJob") -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    job._listeners.append(q)
    return q


def _unsubscribe(job: "GradeJob", q: asyncio.Queue) -> None:
    try:
        job._listeners.remove(q)
    except ValueError:
        pass


def _job_info(job: "GradeJob") -> dict:
    return {
        "job_id": job.job_id,
        "file_path": job.file_path,
        "metric_name": job.metric_name,
        "status": job.status,
        "completed": job.completed,
        "total": job.total,
        "errors_count": len(job.errors),
        "created_at": job.created_at,
    }


def _terminal_event(job: "GradeJob") -> dict:
    if job.status == "error":
        return {"type": "error", "message": job.error_message or "Grading failed", "job_id": job.job_id}
    failure_ratio = (len(job.errors) / job.total) if job.total else 0.0
    return {
        "type": "complete",
        "job_id": job.job_id,
        "status": job.status,
        "graded_count": len(job.grades),
        "completed": job.completed,
        "total": job.total,
        "errors": job.errors,
        "failure_ratio": failure_ratio,
        "severity": "warning" if failure_ratio > 0.5 else "ok",
    }


async def _flush_job_grades(job: "GradeJob", *, force: bool = False) -> None:
    """Flush newly-completed grades to viz/ in batches (count- or time-triggered)."""
    pending_ids = [sid for sid in job.grades if sid not in job.saved_ids]
    if not pending_ids:
        return
    if (not force and len(pending_ids) < _FLUSH_EVERY_N
            and (time.monotonic() - job.last_flush) < _FLUSH_EVERY_S):
        return
    payload = {str(sid): {job.metric_name: job.grades[sid]} for sid in pending_ids}
    try:
        await _save_grades_for_file(job.file_path, payload)
        job.saved_ids.update(pending_ids)
        job.last_flush = time.monotonic()
        job.flush_error = None
    except Exception as e:
        # Keep the job alive; unsaved ids retry on the next flush tick.
        job.flush_error = _safe_error_detail(e, expose=True)
        print(f"{job.prefix} flush error: {job.flush_error}")


async def _run_grade_job(job: "GradeJob") -> None:
    request = job.request
    raw_samples = job.raw_samples
    provider = job.provider
    prefix = job.prefix
    start_time = time.time()
    job.last_flush = time.monotonic()

    async def grade_one(sample_id: int) -> tuple:
        if sample_id < 0 or sample_id >= len(raw_samples):
            return sample_id, None, f"Sample {sample_id} not found"
        raw = raw_samples[sample_id]
        messages = raw.get('messages', [])
        try:
            context_token = set_grading_log_context({"prefix": prefix, "sample_id": sample_id})
            try:
                result = await provider.grade_sample(
                    messages=messages,
                    metric_prompt=request.metric_prompt,
                    grade_type=request.grade_type,
                    require_quotes=request.require_quotes,
                    is_quote_retry=False,
                )
            finally:
                reset_grading_log_context(context_token)
            grade_entry = {
                "grade": result.grade,
                "grade_type": result.grade_type,
                "quotes": [q.model_dump() for q in result.quotes],
                "explanation": result.explanation,
                "model": result.model,
                "prompt_version": result.prompt_version,
                "timestamp": result.timestamp,
            }
            return sample_id, grade_entry, None
        except Exception as e:
            return sample_id, None, _safe_error_detail(e, expose=True)

    batch_size = min(request.parallel_size, _GRADE_MAX_PARALLEL)
    sem = asyncio.Semaphore(batch_size)

    async def grade_with_limit(sample_id: int) -> tuple:
        async with _GLOBAL_GRADING_SEM:
            async with sem:
                return await grade_one(sample_id)

    result_queue: asyncio.Queue = asyncio.Queue()
    sample_iter = iter(job.sample_ids)
    sample_iter_lock = asyncio.Lock()
    worker_count = max(1, min(batch_size, job.total))

    async def next_sample_id() -> Optional[int]:
        async with sample_iter_lock:
            return next(sample_iter, None)

    async def worker() -> None:
        while True:
            if job.cancel_requested:
                return
            sample_id = await next_sample_id()
            if sample_id is None:
                return
            await result_queue.put(await grade_with_limit(sample_id))

    workers = [asyncio.create_task(worker()) for _ in range(worker_count)]
    try:
        while job.completed < job.total and not job.cancel_requested:
            try:
                sample_id, grade_entry, error = await asyncio.wait_for(result_queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                await _flush_job_grades(job)  # time-based flush during slow stretches
                continue
            job.completed += 1
            if error:
                job.errors.append({"sample_id": sample_id, "error": error})
                print(f"{prefix} sample={sample_id} error: {error}")
            elif grade_entry:
                job.grades[sample_id] = grade_entry
            _emit(job, {
                "type": "progress",
                "completed": job.completed,
                "total": job.total,
                "errors": len(job.errors),
                "flush_error": job.flush_error,
            })
            await _flush_job_grades(job)

        await _flush_job_grades(job, force=True)
        job.status = "cancelled" if (job.cancel_requested and job.completed < job.total) else "complete"
    except Exception as e:
        job.status = "error"
        job.error_message = _safe_error_detail(e, expose=True)
        try:
            await _flush_job_grades(job, force=True)
        except Exception:
            pass
        print(f"{prefix} job error: {job.error_message}")
    finally:
        for w in workers:
            if not w.done():
                w.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        job.finished_at = time.time()
        total_time = job.finished_at - start_time
        print(f"{prefix} job {job.status}: {len(job.grades)} graded, {len(job.errors)} errors in {total_time:.2f}s")
        _emit(job, _terminal_event(job))
        _emit(job, {"type": "__end__"})
        async with _GRADE_JOBS_LOCK:
            file_key = _grade_lock_key(job.file_path)
            if _GRADE_JOBS_BY_FILE.get(file_key) == job.job_id:
                _GRADE_JOBS_BY_FILE.pop(file_key, None)
            _evict_finished_jobs()


async def _tail_job_sse(job: "GradeJob", snapshot: bool):
    """Yield SSE chunks for a job: optional state snapshot, then live events.

    A disconnecting reader just unsubscribes; the job is untouched. A 15s
    heartbeat comment keeps the connection alive through proxies/tunnels.
    """
    q = _subscribe(job)
    try:
        if snapshot:
            snap = {
                "type": "snapshot",
                "job_id": job.job_id,
                "completed": job.completed,
                "total": job.total,
                "errors": len(job.errors),
                "status": job.status,
                "flush_error": job.flush_error,
            }
            yield f"data: {json.dumps(snap)}\n\n"
            if job.status != "running":
                yield f"data: {json.dumps(_terminal_event(job))}\n\n"
                return
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if ev.get("type") == "__end__":
                return
            yield f"data: {json.dumps(ev)}\n\n"
    finally:
        _unsubscribe(job, q)


@app.get("/api/grade-jobs")
async def list_grade_jobs():
    """List active and recently-finished grading jobs (for reattach on reload)."""
    return [_job_info(j) for j in _GRADE_JOBS.values()]


@app.get("/api/grade-jobs/{job_id}/stream")
async def grade_job_stream(job_id: str):
    """Reattach to a job: a snapshot of current state, then live progress (SSE)."""
    job = _GRADE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return StreamingResponse(
        _tail_job_sse(job, snapshot=True),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/grade-jobs/{job_id}/cancel")
async def cancel_grade_job(job_id: str):
    """Cooperatively cancel a running job; already-flushed grades are kept."""
    job = _GRADE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.cancel_requested = True
    return {"cancelled": True, "job_id": job_id}

def _frontend_response(full_path: str) -> FileResponse:
    """Serve the production frontend build without exposing dev source files."""
    decoded = unquote(full_path).replace("\\", "/")
    normalized = posixpath.normpath("/" + decoded).lstrip("/")
    if normalized == ".":
        normalized = ""
    first_part = normalized.split("/", 1)[0] if normalized else ""
    parts = [part for part in normalized.split("/") if part]

    if (
        any(part.lower() == "api" for part in parts)
        or normalized in _DENIED_FRONTEND_FILES
        or first_part in _DENIED_FRONTEND_PREFIXES
        or any(part.startswith(".") for part in parts)
    ):
        raise HTTPException(status_code=404, detail="Not Found")

    if not FRONTEND_INDEX.is_file():
        raise HTTPException(status_code=404, detail="Frontend build not found")

    if normalized:
        requested = (FRONTEND_DIST / normalized).resolve()
        try:
            requested.relative_to(FRONTEND_DIST.resolve())
        except ValueError:
            raise HTTPException(status_code=404, detail="Not Found")
        if requested.is_file():
            return FileResponse(requested)

    return FileResponse(FRONTEND_INDEX)


# --- Rollout discussion chat -------------------------------------------------
# A normal-mode feature: the user chats with a frontier model about one
# rollout. The frontend builds the full message list (a system message holding
# the rollout transcript + grades, then the chat turns) and this endpoint
# streams a reply by proxying model_router's litellm provider. Stateless —
# the whole history is re-sent each turn. Auth-protected like every /api route.

_ROLLOUT_CHAT_ALLOWED_MODELS = {
    "anthropic/claude-opus-4-8",
    "gpt-5.5",
    "openrouter/google/gemini-3.5-flash",
}
_ROLLOUT_CHAT_ALLOWED_ROLES = {"system", "user", "assistant"}
_ROLLOUT_CHAT_MAX_TOKENS = _config_int("VIZ_ROLLOUT_CHAT_MAX_TOKENS", 8_192)
_ROLLOUT_CHAT_MAX_MESSAGES = _config_int("VIZ_ROLLOUT_CHAT_MAX_MESSAGES", 64)
_ROLLOUT_CHAT_MAX_CHARS = _config_int("VIZ_ROLLOUT_CHAT_MAX_CHARS", 250_000)
_ROLLOUT_CHAT_RATE_LIMIT_MAX = _config_int("VIZ_ROLLOUT_CHAT_RATE_LIMIT_MAX", 30)
_ROLLOUT_CHAT_RATE_LIMIT_WINDOW = _config_int("VIZ_ROLLOUT_CHAT_RATE_LIMIT_WINDOW_SECONDS", 60)


class RolloutChatMessage(BaseModel):
    role: str
    content: str


class RolloutChatRequest(BaseModel):
    model: str
    messages: List[RolloutChatMessage]
    max_tokens: Optional[int] = None


def _prepare_rollout_chat_request(request: RolloutChatRequest) -> tuple[str, int, List[dict]]:
    model = request.model.strip()
    if model not in _ROLLOUT_CHAT_ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail="Unsupported rollout chat model")
    if not request.messages:
        raise HTTPException(status_code=400, detail="At least one message is required")
    if len(request.messages) > _ROLLOUT_CHAT_MAX_MESSAGES:
        raise HTTPException(status_code=400, detail=f"Too many messages (max {_ROLLOUT_CHAT_MAX_MESSAGES})")

    total_chars = 0
    messages: List[dict] = []
    for message in request.messages:
        role = message.role.strip().lower()
        if role not in _ROLLOUT_CHAT_ALLOWED_ROLES:
            raise HTTPException(status_code=400, detail="Unsupported rollout chat message role")
        total_chars += len(message.content)
        if total_chars > _ROLLOUT_CHAT_MAX_CHARS:
            raise HTTPException(status_code=400, detail=f"Rollout chat prompt too long (max {_ROLLOUT_CHAT_MAX_CHARS} chars)")
        messages.append({"role": role, "content": message.content})

    max_tokens = _ROLLOUT_CHAT_MAX_TOKENS if request.max_tokens is None else request.max_tokens
    if max_tokens < 1 or max_tokens > _ROLLOUT_CHAT_MAX_TOKENS:
        raise HTTPException(status_code=400, detail=f"max_tokens must be between 1 and {_ROLLOUT_CHAT_MAX_TOKENS}")
    return model, max_tokens, messages


def _sse_frame(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


@app.post("/api/rollout-chat-stream")
async def rollout_chat_stream(request: RolloutChatRequest, http_request: Request):
    """Stream one assistant turn from a frontier model discussing a rollout.

    Thin SSE proxy to model_router `/step` (provider: litellm). The tinker
    event names (`response.output_text.delta`, `response.reasoning.delta`,
    `response.done`, `response.error`) pass straight through to the browser.
    """
    if not _can_use_server_api_keys(http_request):
        raise HTTPException(
            status_code=403,
            detail="Rollout chat requires an authenticated password session",
        )
    _enforce_window_rate_limit(
        "rollout-chat",
        http_request,
        max_requests=_ROLLOUT_CHAT_RATE_LIMIT_MAX,
        window_seconds=_ROLLOUT_CHAT_RATE_LIMIT_WINDOW,
    )
    model, max_tokens, messages = _prepare_rollout_chat_request(request)
    payload = {
        "provider": "litellm",
        "model_name": model,
        "messages": messages,
        # `reasoning_effort: low` keeps the reasoning models (GPT-5.5, etc.)
        # snappy and stops them from burning the whole token budget on hidden
        # reasoning and emitting no visible answer.
        "sampling": {
            "stream": True,
            "max_tokens": max_tokens,
            "reasoning_effort": "low",
        },
    }

    async def generate_events():
        try:
            timeout = httpx.Timeout(600.0, connect=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", f"{MODEL_ROUTER_URL}/step", json=payload
                ) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        detail = body.decode("utf-8", errors="replace")[:500]
                        yield _sse_frame(
                            "response.error",
                            {"message": f"model_router HTTP {resp.status_code}: {detail}"},
                        )
                        return
                    async for chunk in resp.aiter_raw():
                        if chunk:
                            yield chunk
        except httpx.ConnectError:
            yield _sse_frame(
                "response.error",
                {
                    "message": (
                        f"Could not reach model_router at {MODEL_ROUTER_URL}. "
                        "Start it: reward_seeker/model_router/start.sh"
                    )
                },
            )
        except Exception as e:
            yield _sse_frame(
                "response.error",
                {"message": f"chat proxy failed: {_safe_error_detail(e)}"},
            )

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Canonical single-rollout fetch API (GET /api/rollout). Lives in its own
# module; imported here (bottom of the module, before the static-file
# catch-all) so backend.main is fully initialized when fetch_api binds to it.
from backend.fetch_api import router as _fetch_router  # noqa: E402
app.include_router(_fetch_router)

# Library landing-page API (GET /api/library, GET /api/library/preview).
from backend.library_api import router as _library_router  # noqa: E402
app.include_router(_library_router)

# Companion files (plan.md / summary.json / execution.jsonl next to a loaded
# rollout file) + the raw-file reader behind the "Run files" drawer.
from backend.companion_api import router as _companion_router  # noqa: E402
app.include_router(_companion_router)


@app.on_event("startup")
async def _warm_library_cache():
    """Kick off the first Library scan in the background at boot so the
    landing view never eats the ~90s cold listing (stale-while-revalidate
    keeps it warm afterward). Tests are unaffected — httpx's ASGITransport
    doesn't run lifespan events; set VIZ_LIBRARY_WARMUP=0 to disable."""
    if _config_bool("VIZ_LIBRARY_WARMUP", True):
        from backend import library_api
        library_api._ensure_scan_task()


@app.get("/", include_in_schema=False)
async def serve_frontend_root():
    return _frontend_response("")


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_frontend(full_path: str):
    decoded = unquote(full_path).replace("\\", "/")
    normalized = posixpath.normpath("/" + decoded).lstrip("/")
    parts = [part for part in normalized.split("/") if part and part != "."]
    if any(part.lower() == "api" for part in parts):
        raise HTTPException(status_code=404, detail="Not Found")
    return _frontend_response(full_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
