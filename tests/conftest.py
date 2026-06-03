import json
import os
import sys
import asyncio
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
import httpx
from httpx import ASGITransport

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture
def sample_data():
    """List of 5 raw JSONL dicts with known attributes."""
    return [
        {
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello, how are you?"},
                {"role": "assistant", "content": "I'm doing great, thanks for asking!"},
            ],
            "attributes": {
                "step": 1,
                "sample_index": 0,
                "rollout_n": 100,
                "reward": 0.8,
                "data_source": "test/source1",
                "experiment_name": "test_experiment",
                "validate": False,
            },
            "timestamp": "2026-01-15T10:00:00",
        },
        {
            "messages": [
                {"role": "user", "content": "What is 2+2?"},
                {"role": "assistant", "content": "The answer is 4."},
            ],
            "attributes": {
                "step": 2,
                "sample_index": 1,
                "rollout_n": 101,
                "reward": 1.0,
                "data_source": "test/source2",
                "experiment_name": "test_experiment",
                "validate": True,
            },
            "timestamp": "2026-01-15T10:01:00",
        },
        {
            "messages": [
                {"role": "user", "content": "Tell me a joke"},
                {"role": "assistant", "content": "Why did the chicken cross the road?"},
            ],
            "attributes": {
                "step": 1,
                "sample_index": 2,
                "rollout_n": 102,
                "reward": -0.5,
                "data_source": "test/source1",
                "experiment_name": "test_experiment",
                "validate": False,
            },
            "timestamp": "2026-01-15T10:02:00",
        },
        {
            "messages": [
                {"role": "system", "content": "Be concise."},
                {"role": "user", "content": "Summarize quantum computing"},
                {"role": "assistant", "content": "Quantum computing uses qubits."},
            ],
            "attributes": {
                "step": 3,
                "sample_index": 3,
                "rollout_n": 103,
                "reward": 0.5,
                "data_source": "test/source3",
                "experiment_name": "other_experiment",
                "validate": False,
            },
            "timestamp": "2026-01-15T10:03:00",
        },
        {
            "messages": [
                {"role": "user", "content": "Write a haiku"},
                {"role": "assistant", "content": "Cherry blossoms fall\nSilent whispers in the wind\nSpring begins anew"},
            ],
            "attributes": {
                "step": 4,
                "sample_index": 4,
                "rollout_n": 104,
                "reward": 0.9,
                "data_source": "test/source2",
                "experiment_name": "test_experiment",
            },
            "timestamp": "2026-01-15T10:04:00",
        },
    ]


@pytest.fixture
def temp_jsonl(tmp_path, sample_data):
    """Factory that creates temp JSONL files and patches PROJECT_ROOT."""
    created_files = []

    def _create(data=None, filename="test_data.jsonl"):
        if data is None:
            data = sample_data
        file_path = tmp_path / filename
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w") as f:
            for item in data:
                f.write(json.dumps(item) + "\n")
        created_files.append(file_path)
        return file_path

    return _create


@pytest.fixture
def patch_project_root(tmp_path):
    """Patch PROJECT_ROOT to tmp_path so _safe_resolve_path works."""
    import backend.main as main_module
    original = main_module.PROJECT_ROOT
    main_module.PROJECT_ROOT = tmp_path
    yield tmp_path
    main_module.PROJECT_ROOT = original


@pytest.fixture
def app_no_auth():
    """httpx AsyncClient with auth disabled (VIZ_PASSWORD=None)."""
    import backend.main as main_module
    original_password = main_module.VIZ_PASSWORD
    main_module.VIZ_PASSWORD = None

    async def _get_client():
        transport = ASGITransport(app=main_module.app)
        client = httpx.AsyncClient(transport=transport, base_url="http://test")
        return client

    yield _get_client
    main_module.VIZ_PASSWORD = original_password


@pytest.fixture
def app_with_auth():
    """httpx AsyncClient with VIZ_PASSWORD set."""
    import backend.main as main_module
    original_password = main_module.VIZ_PASSWORD
    original_secret = main_module.SECRET_KEY
    main_module.VIZ_PASSWORD = "testpass123"
    main_module.SECRET_KEY = "test-secret-key-for-testing"
    main_module.cookie_serializer = __import__('itsdangerous').URLSafeTimedSerializer("test-secret-key-for-testing")

    async def _get_client():
        transport = ASGITransport(app=main_module.app)
        client = httpx.AsyncClient(transport=transport, base_url="http://test")
        return client

    yield _get_client
    main_module.VIZ_PASSWORD = original_password
    main_module.SECRET_KEY = original_secret
    main_module.cookie_serializer = __import__('itsdangerous').URLSafeTimedSerializer(original_secret)


@pytest.fixture
def authenticated_client():
    """Pre-logged-in client with valid session cookie."""
    import backend.main as main_module
    original_password = main_module.VIZ_PASSWORD
    original_secret = main_module.SECRET_KEY

    test_secret = "test-secret-key-for-testing"
    main_module.VIZ_PASSWORD = "testpass123"
    main_module.SECRET_KEY = test_secret
    serializer = __import__('itsdangerous').URLSafeTimedSerializer(test_secret)
    main_module.cookie_serializer = serializer

    async def _get_client():
        transport = ASGITransport(app=main_module.app)
        token = serializer.dumps({"auth": True, "pv": main_module._password_version()})
        client = httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"viz_session": token},
        )
        return client

    yield _get_client
    main_module.VIZ_PASSWORD = original_password
    main_module.SECRET_KEY = original_secret
    main_module.cookie_serializer = __import__('itsdangerous').URLSafeTimedSerializer(original_secret)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Clear _login_attempts and caches between tests."""
    import backend.main as main_module
    main_module._login_attempts.clear()
    main_module._clear_file_cache()
    main_module._clear_viz_exists_cache()
    main_module._clear_test_provider_cache()
    yield
    main_module._login_attempts.clear()
    main_module._clear_file_cache()
    main_module._clear_viz_exists_cache()
    main_module._clear_test_provider_cache()


@pytest.fixture
def mock_env_config():
    """Patch _env_config dict directly."""
    import backend.main as main_module
    original = main_module._env_config.copy()

    def _set(**kwargs):
        main_module._env_config.update(kwargs)

    yield _set
    main_module._env_config.clear()
    main_module._env_config.update(original)


@pytest.fixture
def mock_s3():
    """Moto mock_aws() with test bucket and JSONL files."""
    from moto import mock_aws
    import boto3
    import backend.main as main_module

    # Reset singleton so it gets recreated inside mock_aws context.
    # The developer machine may have a real S3 allowlist in ~/.env; mock S3
    # tests should not inherit that production restriction.
    main_module._reset_s3_client()
    original_allowed_buckets = main_module.VIZ_ALLOWED_S3_BUCKETS
    main_module.VIZ_ALLOWED_S3_BUCKETS = None

    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        bucket_name = "test-bucket"
        s3.create_bucket(Bucket=bucket_name)

        # Add test JSONL files
        sample1 = json.dumps({
            "messages": [{"role": "user", "content": "Hello"}],
            "attributes": {"step": 1, "rollout_n": 0, "reward": 0.5},
            "timestamp": "2026-01-15T10:00:00",
        })
        sample2 = json.dumps({
            "messages": [{"role": "user", "content": "World"}],
            "attributes": {"step": 2, "rollout_n": 1, "reward": 0.8},
            "timestamp": "2026-01-15T10:01:00",
        })

        s3.put_object(
            Bucket=bucket_name,
            Key="data/traces.jsonl",
            Body=f"{sample1}\n{sample2}\n",
        )
        s3.put_object(
            Bucket=bucket_name,
            Key="data/other.jsonl",
            Body=f"{sample1}\n",
        )
        s3.put_object(
            Bucket=bucket_name,
            Key="data/subfolder/nested.jsonl",
            Body=f"{sample2}\n",
        )
        s3.put_object(
            Bucket=bucket_name,
            Key="data/readme.txt",
            Body=b"not a jsonl file",
        )

        yield {
            "s3": s3,
            "bucket": bucket_name,
        }

        # Reset singleton after mock_aws context exits
        main_module._reset_s3_client()
        main_module.VIZ_ALLOWED_S3_BUCKETS = original_allowed_buckets
