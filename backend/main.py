"""
FastAPI backend for Rollout Trace Visualizer.

Provides REST API endpoints for loading JSONL data from local files or S3.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# Project root directory (parent of backend/)
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

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


class FileInfo(BaseModel):
    key: str
    size: int
    last_modified: str


class SamplesResponse(BaseModel):
    samples: List[Sample]
    total: int
    experiment_name: str
    file_path: str


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


@app.get("/api/samples", response_model=SamplesResponse)
async def get_samples(
    file: str = Query(..., description="Path to JSONL file (local path or s3://bucket/key)")
):
    """Load samples from a JSONL file."""
    try:
        if file.startswith("s3://"):
            # Parse S3 path
            s3_path = file[5:]  # Remove 's3://'
            bucket, key = s3_path.split("/", 1)
            raw_samples = load_jsonl_from_s3(bucket, key)
        else:
            raw_samples = load_jsonl_from_file(file)
        
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
            
            sample = Sample(
                id=i,
                messages=[Message(**msg) for msg in raw.get('messages', [])],
                attributes=SampleAttributes(**attrs),
                timestamp=raw.get('timestamp', ''),
            )
            samples.append(sample)
        
        return SamplesResponse(
            samples=samples,
            total=len(samples),
            experiment_name=experiment_name,
            file_path=file,
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
