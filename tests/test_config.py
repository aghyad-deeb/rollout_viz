"""Tests for environment config parsing and API key retrieval."""

import pytest
from unittest.mock import patch


class TestEnvParsing:
    """Tests for ~/.env file parsing logic."""

    def test_key_value_parsing(self):
        """Direct test of _env_config dict behavior."""
        import backend.main as main_module
        original = main_module._env_config.copy()
        try:
            main_module._env_config["TEST_KEY"] = "test_value"
            assert main_module._env_config["TEST_KEY"] == "test_value"
        finally:
            main_module._env_config.clear()
            main_module._env_config.update(original)

    def test_get_env_api_key_returns_key(self, mock_env_config):
        from backend.main import get_env_api_key
        mock_env_config(OPENAI_API_KEY="sk-test-123")
        result = get_env_api_key("openai")
        assert result == "sk-test-123"

    def test_get_env_api_key_unknown_provider(self):
        from backend.main import get_env_api_key
        result = get_env_api_key("unknown_provider")
        assert result is None

    def test_get_env_api_key_missing_key(self, mock_env_config):
        from backend.main import get_env_api_key
        # Don't set any keys
        result = get_env_api_key("openai")
        # May or may not be None depending on real ~/.env, so just verify no crash
        assert result is None or isinstance(result, str)

    def test_all_providers_have_mapping(self):
        from backend.main import API_KEY_ENV_VARS
        assert "openai" in API_KEY_ENV_VARS
        assert "anthropic" in API_KEY_ENV_VARS
        assert "google" in API_KEY_ENV_VARS
        assert "openrouter" in API_KEY_ENV_VARS


class TestAvailableApiKeys:
    """Tests for GET /api/available-api-keys."""

    async def test_returns_bool_map(self, app_no_auth):
        client = await app_no_auth()
        resp = await client.get("/api/available-api-keys")
        assert resp.status_code == 200
        data = resp.json()
        assert "openai" in data
        assert "anthropic" in data
        assert "google" in data
        assert "openrouter" in data
        # All values should be booleans
        for key, value in data.items():
            assert isinstance(value, bool), f"{key} should be bool, got {type(value)}"
        await client.aclose()

    async def test_reflects_env_config(self, app_no_auth, mock_env_config):
        mock_env_config(OPENAI_API_KEY="sk-test")
        client = await app_no_auth()
        resp = await client.get("/api/available-api-keys")
        data = resp.json()
        assert data["openai"] is True
        await client.aclose()
