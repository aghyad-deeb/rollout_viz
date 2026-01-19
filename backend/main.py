"""
FastAPI backend for Rollout Trace Visualizer.

Provides REST API endpoints for loading JSONL data from local files or S3.
"""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.llm_providers import (
    get_provider,
    GradeResult,
    Quote as LLMQuote,
    PRESET_METRICS,
)


# Project root directory (parent of backend/)
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

# Load environment variables from .env file
# Check multiple locations: project root, home directory
env_locations = [
    PROJECT_ROOT / ".env",
    Path.home() / ".env",
]
for env_path in env_locations:
    if env_path.exists():
        load_dotenv(env_path)
        break

# API key environment variable names for each provider
API_KEY_ENV_VARS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def get_env_api_key(provider: str) -> Optional[str]:
    """Get API key from environment for a provider."""
    env_var = API_KEY_ENV_VARS.get(provider)
    if env_var:
        return os.getenv(env_var)
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
    use_batch: bool = False  # Use OpenAI Batch API (50% cheaper, 24h turnaround)


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


def load_env_credentials():
    """Load AWS credentials from ~/.env file."""
    env_path = os.path.expanduser("~/.env")
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key] = value


def load_jsonl_from_file(file_path: str) -> List[Dict[str, Any]]:
    """Load JSONL data from a local file."""
    # Resolve relative paths from project root
    path = Path(file_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    
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
    dir_path = Path(directory)
    
    # Resolve relative paths from project root
    if not dir_path.is_absolute():
        dir_path = PROJECT_ROOT / dir_path
    
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
    dir_path = Path(directory)
    
    # Resolve relative paths from project root
    if not dir_path.is_absolute():
        dir_path = PROJECT_ROOT / dir_path
    
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
        path = Path(viz_path)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        return path.exists()


def save_jsonl_to_file(file_path: str, samples: List[Dict[str, Any]]) -> None:
    """Save samples to a local JSONL file."""
    path = Path(file_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    
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


@app.get("/api/preset-metrics", response_model=Dict[str, PresetMetricInfo])
async def get_preset_metrics():
    """Get available preset metrics for grading."""
    return {
        key: PresetMetricInfo(**value)
        for key, value in PRESET_METRICS.items()
    }


@app.get("/api/available-api-keys")
async def get_available_api_keys():
    """Check which API keys are available from server environment (.env file)."""
    available = {}
    for provider, env_var in API_KEY_ENV_VARS.items():
        key = os.getenv(env_var)
        available[provider] = bool(key and len(key) > 0)
    return available


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
        
        # Get the LLM provider
        provider = get_provider(request.provider, api_key, request.model)
        
        # Grade each requested sample
        grades: Dict[int, GradeEntry] = {}
        errors: List[Dict[str, Any]] = []
        
        async def grade_one(sample_id: int) -> tuple:
            if sample_id < 0 or sample_id >= len(raw_samples):
                return sample_id, None, f"Sample {sample_id} not found"
            
            raw = raw_samples[sample_id]
            messages = raw.get('messages', [])
            
            try:
                result = await provider.grade_sample(
                    messages=messages,
                    metric_prompt=request.metric_prompt,
                    grade_type=request.grade_type,
                )
                
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
        
        # Grade samples concurrently
        # Note: use_batch currently enables larger parallel batches for faster processing
        # TODO: Implement true OpenAI Batch API (file upload + async jobs) for 50% cost savings
        # The Batch API requires: 1) JSONL file upload, 2) batch job creation, 3) polling for results
        # This would need a separate job tracking system
        batch_size = 20 if request.use_batch else 5
        
        for i in range(0, len(request.sample_ids), batch_size):
            batch = request.sample_ids[i:i + batch_size]
            results = await asyncio.gather(*[grade_one(sid) for sid in batch])
            
            for sample_id, grade_entry, error in results:
                if error:
                    errors.append({"sample_id": sample_id, "error": error})
                elif grade_entry:
                    grades[sample_id] = grade_entry
        
        return GradeResponse(
            graded_count=len(grades),
            errors=errors,
            grades=grades,
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
