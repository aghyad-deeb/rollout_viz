"""
FastAPI backend for Rollout Trace Visualizer.

Provides REST API endpoints for loading JSONL data from local files or S3.
"""

import asyncio
import json
import os
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from pydantic import BaseModel

from backend.llm_providers import (
    get_provider,
    GradeResult,
    Quote as LLMQuote,
    PRESET_METRICS,
)


# Project root directory (parent of backend/)
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

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

# API key environment variable names for each provider
API_KEY_ENV_VARS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def get_env_api_key(provider: str) -> Optional[str]:
    """Get API key from ~/.env for a provider (ignores shell environment)."""
    env_var = API_KEY_ENV_VARS.get(provider)
    if env_var:
        key = _env_config.get(env_var)
        if key:
            print(f"[DEBUG] {provider} key loaded: {key[:15]}...{key[-5:]} (len={len(key)})")
        return key
    return None

app = FastAPI(title="Rollout Visualizer API")

# CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Password authentication ---
VIZ_PASSWORD = _env_config.get("VIZ_PASSWORD")
SECRET_KEY = _env_config.get("VIZ_SECRET_KEY", secrets.token_hex(32))
cookie_serializer = URLSafeTimedSerializer(SECRET_KEY)
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days
AUTH_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/check", "/api/health"}

# Simple in-memory rate limiter for login attempts
_login_attempts: Dict[str, List[float]] = {}
RATE_LIMIT_WINDOW = 300  # 5 minutes
RATE_LIMIT_MAX = 5


def _check_rate_limit(client_ip: str) -> bool:
    """Return True if the request should be rate-limited."""
    now = time.time()
    attempts = _login_attempts.get(client_ip, [])
    # Prune old attempts
    attempts = [t for t in attempts if now - t < RATE_LIMIT_WINDOW]
    _login_attempts[client_ip] = attempts
    return len(attempts) >= RATE_LIMIT_MAX


def _record_failed_attempt(client_ip: str):
    _login_attempts.setdefault(client_ip, []).append(time.time())


def _clear_attempts(client_ip: str):
    _login_attempts.pop(client_ip, None)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if not VIZ_PASSWORD:
        return await call_next(request)
    if request.url.path in AUTH_EXEMPT_PATHS:
        return await call_next(request)
    # Only protect /api/* routes
    if not request.url.path.startswith("/api"):
        return await call_next(request)
    # Check session cookie
    session_cookie = request.cookies.get("viz_session")
    if session_cookie:
        try:
            cookie_serializer.loads(session_cookie, max_age=COOKIE_MAX_AGE)
            return await call_next(request)
        except (BadSignature, SignatureExpired):
            pass
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
    token = cookie_serializer.dumps("authenticated")
    response = JSONResponse(content={"ok": True})
    # Only set Secure flag when not on localhost (HTTP)
    is_localhost = request.url.hostname in ("localhost", "127.0.0.1")
    response.set_cookie(
        key="viz_session",
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=not is_localhost,
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
            cookie_serializer.loads(session_cookie, max_age=COOKIE_MAX_AGE)
            return {"auth_required": True, "authenticated": True}
        except (BadSignature, SignatureExpired):
            pass
    return {"auth_required": True, "authenticated": False}


if VIZ_PASSWORD:
    print(f"[AUTH] Password protection enabled")
else:
    print(f"[AUTH] No VIZ_PASSWORD set — authentication disabled")


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
    start: int
    end: int
    text: str


class GradeEntry(BaseModel):
    """A single grade entry for a metric."""
    grade: Union[float, int, bool]
    grade_type: str  # "float", "int", "bool"
    quotes: List[Quote]
    explanation: str
    model: str
    prompt_version: str
    timestamp: str


class GradeRequest(BaseModel):
    """Request to grade samples."""
    file_path: str
    sample_ids: List[int]  # Which samples to grade
    metric_name: str
    metric_prompt: str  # The grading prompt
    grade_type: str  # "float", "int", "bool"
    provider: str  # "openai", "anthropic", "google", "openrouter"
    model: str  # e.g., "gpt-4o", "claude-3-opus"
    api_key: Optional[str] = None  # Optional - will use .env if not provided
    parallel_size: int = 100  # Number of concurrent requests
    require_quotes: bool = True  # Whether to require quotes from the model
    max_quote_retries: int = 2  # Max retries if quotes are required but missing
    # Advanced settings
    temperature: Optional[float] = None  # 0.0 - 2.0, None = model default
    max_tokens: Optional[int] = None  # Max output tokens
    top_p: Optional[float] = None  # 0.0 - 1.0


class GradeResponse(BaseModel):
    """Response from grading operation."""
    graded_count: int
    errors: List[Dict[str, Any]]
    grades: Dict[int, GradeEntry]  # sample_id -> grade


class SaveGradedRequest(BaseModel):
    """Request to save graded samples to viz/ directory."""
    file_path: str
    grades: Dict[int, Dict[str, GradeEntry]]  # sample_id -> {metric_name: grade}


class PresetMetricInfo(BaseModel):
    """Information about a preset metric."""
    name: str
    description: str
    grade_type: str
    prompt: str
    is_custom: bool = False  # True if user-created


def load_env_credentials():
    """Set AWS credentials from ~/.env config into os.environ for boto3."""
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"):
        if key in _env_config:
            os.environ[key] = _env_config[key]


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
    """Load JSONL data from a local file."""
    path = _safe_resolve_path(file_path)
    
    samples = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    return samples


def load_jsonl_from_s3(bucket: str, key: str) -> List[Dict[str, Any]]:
    """Load JSONL data from S3."""
    import boto3
    
    load_env_credentials()
    s3_client = boto3.client('s3')
    response = s3_client.get_object(Bucket=bucket, Key=key)
    content = response['Body'].read().decode('utf-8')
    
    samples = []
    for line in content.split('\n'):
        line = line.strip()
        if line:
            samples.append(json.loads(line))
    return samples


def list_s3_files(bucket: str, prefix: str = "") -> List[Dict[str, Any]]:
    """List JSONL files in S3."""
    import boto3
    
    load_env_credentials()
    s3_client = boto3.client('s3')
    
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
    import boto3
    
    load_env_credentials()
    s3_client = boto3.client('s3')
    
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


@app.get("/api/files/local", response_model=List[FileInfo])
async def get_local_files(directory: str = Query(default=".")):
    """List JSONL files in a local directory."""
    try:
        files = list_local_files(directory)
        return files
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/files/s3", response_model=List[FileInfo])
async def get_s3_files(
    bucket: str = Query(...),
    prefix: str = Query(default="")
):
    """List JSONL files in an S3 bucket."""
    try:
        files = list_s3_files(bucket, prefix)
        return files
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contents/local")
async def get_local_contents(directory: str = Query(default=".")):
    """List folders and JSONL files in a local directory (non-recursive)."""
    try:
        contents = list_local_contents(directory)
        return contents
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/samples", response_model=SamplesResponse)
async def get_samples(
    file: str = Query(..., description="Path to JSONL file (local path or s3://bucket/key)")
):
    """Load samples from a JSONL file.
    
    Automatically checks for a viz/ version first (which includes grades).
    Falls back to the original file if viz/ doesn't exist.
    """
    try:
        # Check if viz/ version exists and use it if so
        viz_path = get_viz_path(file)
        has_grades = False
        actual_path = file
        
        if viz_file_exists(viz_path):
            actual_path = viz_path
            has_grades = True
        
        if actual_path.startswith("s3://"):
            # Parse S3 path
            s3_path = actual_path[5:]  # Remove 's3://'
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(actual_path)
        
        # Convert to Sample objects with IDs
        samples = []
        experiment_name = "unknown"
        
        for i, raw in enumerate(raw_samples):
            attrs = raw.get('attributes', {})
            if experiment_name == "unknown":
                experiment_name = attrs.get('experiment_name', 'unknown')
            
            # Rename 'validate' to 'is_validate' to avoid shadowing BaseModel.validate
            if 'validate' in attrs:
                attrs['is_validate'] = attrs.pop('validate')
            
            # Include grades if present
            grades = raw.get('grades', None)
            if grades:
                has_grades = True
            
            sample = Sample(
                id=i,
                messages=[Message(**msg) for msg in raw.get('messages', [])],
                attributes=SampleAttributes(**attrs),
                timestamp=raw.get('timestamp', ''),
                grades=grades,
            )
            samples.append(sample)
        
        return SamplesResponse(
            samples=samples,
            total=len(samples),
            experiment_name=experiment_name,
            file_path=file,  # Return original path for consistency
            has_grades=has_grades,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {file}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/sample/{sample_id}", response_model=Sample)
async def get_sample(
    sample_id: int,
    file: str = Query(..., description="Path to JSONL file")
):
    """Get a single sample by ID."""
    try:
        if file.startswith("s3://"):
            s3_path = file[5:]
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(file)
        
        if sample_id < 0 or sample_id >= len(raw_samples):
            raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")
        
        raw = raw_samples[sample_id]
        attrs = raw.get('attributes', {})
        # Rename 'validate' to 'is_validate' to avoid shadowing BaseModel.validate
        if 'validate' in attrs:
            attrs['is_validate'] = attrs.pop('validate')
        
        return Sample(
            id=sample_id,
            messages=[Message(**msg) for msg in raw.get('messages', [])],
            attributes=SampleAttributes(**attrs),
            timestamp=raw.get('timestamp', ''),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    """Check if the viz/ version of a file exists."""
    if viz_path.startswith("s3://"):
        import boto3
        try:
            load_env_credentials()
            s3_client = boto3.client('s3')
            s3_path = viz_path[5:]
            bucket, key = s3_path.split("/", 1)
            s3_client.head_object(Bucket=bucket, Key=key)
            return True
        except Exception:
            return False
    else:
        path = _safe_resolve_path(viz_path)
        return path.exists()


def save_jsonl_to_file(file_path: str, samples: List[Dict[str, Any]]) -> None:
    """Save samples to a local JSONL file."""
    path = _safe_resolve_path(file_path)

    # Create parent directories including viz/
    path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(path, 'w') as f:
        for sample in samples:
            f.write(json.dumps(sample) + '\n')


def save_jsonl_to_s3(bucket: str, key: str, samples: List[Dict[str, Any]]) -> None:
    """Save samples to S3 as JSONL."""
    import boto3
    
    load_env_credentials()
    s3_client = boto3.client('s3')
    
    content = '\n'.join(json.dumps(sample) for sample in samples)
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=content.encode('utf-8'),
        ContentType='application/jsonl'
    )


# Path to store custom metrics
CUSTOM_METRICS_FILE = PROJECT_ROOT / "custom_metrics.json"


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
    """Save custom metrics to file."""
    with open(CUSTOM_METRICS_FILE, 'w') as f:
        json.dump(metrics, f, indent=2)


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


class SaveCustomMetricRequest(BaseModel):
    """Request to save a custom metric."""
    key: str  # Unique identifier (lowercase, no spaces)
    name: str  # Display name
    description: str
    grade_type: str  # 'float', 'int', or 'bool'
    prompt: str


@app.post("/api/save-custom-metric")
async def save_custom_metric(request: SaveCustomMetricRequest):
    """Save a custom metric for future use."""
    # Validate key format
    key = request.key.lower().replace(" ", "_")
    
    # Don't allow overriding built-in presets
    if key in PRESET_METRICS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot override built-in preset '{key}'"
        )
    
    # Load existing custom metrics
    custom_metrics = load_custom_metrics()
    
    # Add/update the metric
    custom_metrics[key] = {
        "name": request.name,
        "description": request.description,
        "grade_type": request.grade_type,
        "prompt": request.prompt,
        "is_custom": True,
    }
    
    # Save
    save_custom_metrics(custom_metrics)
    
    return {"status": "saved", "key": key}


@app.delete("/api/custom-metric/{key}")
async def delete_custom_metric(key: str):
    """Delete a custom metric."""
    custom_metrics = load_custom_metrics()
    
    if key not in custom_metrics:
        raise HTTPException(status_code=404, detail=f"Custom metric '{key}' not found")
    
    del custom_metrics[key]
    save_custom_metrics(custom_metrics)
    
    return {"status": "deleted", "key": key}


@app.get("/api/available-api-keys")
async def get_available_api_keys():
    """Check which API keys are available from server environment (.env file)."""
    available = {}
    for provider, env_var in API_KEY_ENV_VARS.items():
        key = _env_config.get(env_var)
        available[provider] = bool(key and len(key) > 0)
    return available


class TestProviderRequest(BaseModel):
    """Request to test an LLM provider connection."""
    provider: str
    model: str
    api_key: Optional[str] = None


@app.post("/api/test-provider")
async def test_provider(request: TestProviderRequest):
    """Test that an LLM provider + model + API key combination works.

    Makes a minimal API call to validate the configuration before
    starting a full grading job.
    """
    try:
        api_key = request.api_key
        if not api_key:
            api_key = get_env_api_key(request.provider)

        if not api_key:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": f"No API key for {request.provider}"}
            )

        provider = get_provider(request.provider, api_key, request.model, max_tokens=200)

        # Make a minimal call to validate the key + model.
        # We only care that the API accepts the request (valid key + model).
        # JSON parsing errors are OK here — they mean the connection works.
        try:
            await provider.grade_sample(
                messages=[{"role": "user", "content": "Say OK."}],
                metric_prompt="Is this message polite? Grade as true or false.",
                grade_type="bool",
                require_quotes=False,
            )
        except ValueError:
            # ValueError = JSON parse error = API responded but format was off.
            # That's fine — the connection works.
            pass
        return {"ok": True}
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": str(e)}
        )


@app.post("/api/grade", response_model=GradeResponse)
async def grade_samples(request: GradeRequest):
    """Grade samples using an LLM provider."""
    try:
        # Get API key - use provided key or fall back to environment
        api_key = request.api_key
        if not api_key:
            api_key = get_env_api_key(request.provider)
        
        if not api_key:
            raise HTTPException(
                status_code=400,
                detail=f"No API key provided for {request.provider} and none found in .env file"
            )
        
        # Load the samples
        if request.file_path.startswith("s3://"):
            s3_path = request.file_path[5:]
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(request.file_path)
        
        # Get the LLM provider with advanced settings
        provider = get_provider(
            request.provider, 
            api_key, 
            request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            top_p=request.top_p,
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
                result = None
                max_attempts = (request.max_quote_retries + 1) if request.require_quotes else 1
                
                for attempt in range(max_attempts):
                    # On retry, use stronger language about quotes
                    is_retry = attempt > 0
                    
                    result = await provider.grade_sample(
                        messages=messages,
                        metric_prompt=request.metric_prompt,
                        grade_type=request.grade_type,
                        require_quotes=request.require_quotes,
                        is_quote_retry=is_retry,
                    )
                    
                    # Check if we got quotes when required
                    if not request.require_quotes or (result.quotes and len(result.quotes) > 0):
                        break
                    
                    # Log retry attempt
                    print(f"Sample {sample_id}: No quotes received, retrying ({attempt + 1}/{max_attempts})")
                
                grade_entry = GradeEntry(
                    grade=result.grade,
                    grade_type=result.grade_type,
                    quotes=[Quote(**q.dict()) for q in result.quotes],
                    explanation=result.explanation,
                    model=result.model,
                    prompt_version=result.prompt_version,
                    timestamp=result.timestamp,
                )
                return sample_id, grade_entry, None
            except Exception as e:
                return sample_id, None, str(e)
        
        # Grade samples concurrently with configurable parallelism
        batch_size = min(request.parallel_size, 500)  # Cap at 500 to avoid overwhelming APIs
        
        import time
        total_start = time.time()
        print(f"[Grading] Starting {len(request.sample_ids)} samples with batch_size={batch_size}")
        
        for i in range(0, len(request.sample_ids), batch_size):
            batch = request.sample_ids[i:i + batch_size]
            batch_start = time.time()
            results = await asyncio.gather(*[grade_one(sid) for sid in batch])
            batch_time = time.time() - batch_start
            
            for sample_id, grade_entry, error in results:
                if error:
                    errors.append({"sample_id": sample_id, "error": error})
                elif grade_entry:
                    grades[sample_id] = grade_entry
            
            print(f"[Grading] Batch {i//batch_size + 1}: {len(batch)} samples in {batch_time:.2f}s ({batch_time/len(batch):.2f}s per sample)")
        
        total_time = time.time() - total_start
        print(f"[Grading] Complete: {len(grades)} graded, {len(errors)} errors in {total_time:.2f}s")
        
        return GradeResponse(
            graded_count=len(grades),
            errors=errors,
            grades=grades,
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/grade-stream")
async def grade_samples_stream(request: GradeRequest):
    """Grade samples using an LLM provider with SSE streaming progress."""
    import time
    
    async def generate_events():
        start_time = time.time()
        try:
            print(f"[SSE Grading] Starting {len(request.sample_ids)} samples, require_quotes={request.require_quotes}, parallel_size={request.parallel_size}")
            
            # Get API key - use provided key or fall back to environment
            api_key = request.api_key
            if not api_key:
                api_key = get_env_api_key(request.provider)
            
            if not api_key:
                yield f"data: {json.dumps({'type': 'error', 'message': f'No API key for {request.provider}'})}\n\n"
                return
            
            # Load the samples
            if request.file_path.startswith("s3://"):
                s3_path = request.file_path[5:]
                bucket, key = s3_path.split("/", 1)
                raw_samples = load_jsonl_from_s3(bucket, key)
            else:
                raw_samples = load_jsonl_from_file(request.file_path)
            
            # Get the LLM provider with advanced settings
            provider = get_provider(
                request.provider, 
                api_key, 
                request.model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                top_p=request.top_p,
            )
            
            total_samples = len(request.sample_ids)
            completed = 0
            grades: Dict[int, dict] = {}
            errors: List[Dict[str, Any]] = []
            
            # Send initial progress
            yield f"data: {json.dumps({'type': 'progress', 'completed': 0, 'total': total_samples})}\n\n"
            
            async def grade_one(sample_id: int) -> tuple:
                if sample_id < 0 or sample_id >= len(raw_samples):
                    return sample_id, None, f"Sample {sample_id} not found"
                
                raw = raw_samples[sample_id]
                messages = raw.get('messages', [])
                
                try:
                    result = None
                    max_attempts = (request.max_quote_retries + 1) if request.require_quotes else 1
                    
                    for attempt in range(max_attempts):
                        is_retry = attempt > 0
                        
                        result = await provider.grade_sample(
                            messages=messages,
                            metric_prompt=request.metric_prompt,
                            grade_type=request.grade_type,
                            require_quotes=request.require_quotes,
                            is_quote_retry=is_retry,
                        )
                        
                        if not request.require_quotes or (result.quotes and len(result.quotes) > 0):
                            break
                    
                    grade_entry = {
                        "grade": result.grade,
                        "grade_type": result.grade_type,
                        "quotes": [q.dict() for q in result.quotes],
                        "explanation": result.explanation,
                        "model": result.model,
                        "prompt_version": result.prompt_version,
                        "timestamp": result.timestamp,
                    }
                    return sample_id, grade_entry, None
                except Exception as e:
                    return sample_id, None, str(e)
            
            # Run requests with bounded concurrency using a semaphore
            batch_size = min(request.parallel_size, 500)  # Cap at 500
            sem = asyncio.Semaphore(batch_size)

            async def grade_with_limit(sample_id: int) -> tuple:
                async with sem:
                    return await grade_one(sample_id)

            tasks = [asyncio.create_task(grade_with_limit(sid)) for sid in request.sample_ids]

            last_progress_update = 0
            progress_interval = max(1, total_samples // 20)  # Update ~20 times during grading

            for coro in asyncio.as_completed(tasks):
                sample_id, grade_entry, error = await coro
                completed += 1

                if error:
                    errors.append({"sample_id": sample_id, "error": error})
                    print(f"[SSE Grading] Sample {sample_id} error: {error}")
                elif grade_entry:
                    grades[sample_id] = grade_entry

                # Send progress update periodically (not on every single completion)
                if completed - last_progress_update >= progress_interval or completed == total_samples:
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total_samples})}\n\n"
                    last_progress_update = completed
            
            # Send final result
            total_time = time.time() - start_time
            print(f"[SSE Grading] Complete: {len(grades)} graded, {len(errors)} errors in {total_time:.2f}s ({total_time/max(1,len(request.sample_ids)):.2f}s per sample)")
            yield f"data: {json.dumps({'type': 'complete', 'graded_count': len(grades), 'errors': errors, 'grades': grades})}\n\n"
            
        except Exception as e:
            total_time = time.time() - start_time
            print(f"[SSE Grading] Error after {total_time:.2f}s: {str(e)}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    
    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@app.post("/api/save-graded")
async def save_graded_samples(request: SaveGradedRequest):
    """Save graded samples to the viz/ subdirectory.
    
    This merges new grades with any existing grades in the viz/ file.
    """
    try:
        # Determine paths
        original_path = request.file_path
        viz_path = get_viz_path(original_path)
        
        # Load existing samples (prefer viz/ if exists, else original)
        if viz_file_exists(viz_path):
            source_path = viz_path
        else:
            source_path = original_path
        
        if source_path.startswith("s3://"):
            s3_path = source_path[5:]
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(source_path)
        
        # Merge new grades into samples
        for sample_id_str, metric_grades in request.grades.items():
            sample_id = int(sample_id_str)
            if sample_id < 0 or sample_id >= len(raw_samples):
                continue
            
            sample = raw_samples[sample_id]
            
            # Initialize grades dict if not present
            if 'grades' not in sample:
                sample['grades'] = {}
            
            # Merge each metric's grades
            for metric_name, grade_entry in metric_grades.items():
                if metric_name not in sample['grades']:
                    sample['grades'][metric_name] = []
                
                # Add the new grade entry
                if isinstance(grade_entry, dict):
                    sample['grades'][metric_name].append(grade_entry)
                else:
                    sample['grades'][metric_name].append(grade_entry.dict())
        
        # Save to viz/ path
        if viz_path.startswith("s3://"):
            s3_path = viz_path[5:]
            bucket, key = s3_path.split("/", 1)
            save_jsonl_to_s3(bucket, key, raw_samples)
        else:
            save_jsonl_to_file(viz_path, raw_samples)
        
        return {
            "success": True,
            "viz_path": viz_path,
            "samples_updated": len(request.grades),
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
