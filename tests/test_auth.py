"""Tests for authentication, rate limiting, and auth middleware."""

import time
import pytest
from unittest.mock import patch


class TestAuthCheck:
    """Tests for GET /api/auth/check."""

    async def test_no_password_returns_not_required(self, app_no_auth):
        """When no VIZ_PASSWORD set, auth_required=False, authenticated=True."""
        client = await app_no_auth()
        resp = await client.get("/api/auth/check")
        assert resp.status_code == 200
        data = resp.json()
        assert data["auth_required"] is False
        assert data["authenticated"] is True
        await client.aclose()

    async def test_with_password_no_cookie_unauthenticated(self, app_with_auth):
        """With VIZ_PASSWORD set, no cookie → authenticated=False."""
        client = await app_with_auth()
        resp = await client.get("/api/auth/check")
        assert resp.status_code == 200
        data = resp.json()
        assert data["auth_required"] is True
        assert data["authenticated"] is False
        await client.aclose()

    async def test_valid_cookie_authenticated(self, authenticated_client):
        """Valid session cookie → authenticated=True."""
        client = await authenticated_client()
        resp = await client.get("/api/auth/check")
        assert resp.status_code == 200
        data = resp.json()
        assert data["auth_required"] is True
        assert data["authenticated"] is True
        await client.aclose()

    async def test_tampered_cookie_unauthenticated(self, app_with_auth):
        """Tampered cookie → authenticated=False."""
        client = await app_with_auth()
        client.cookies.set("viz_session", "tampered-garbage-value")
        resp = await client.get("/api/auth/check")
        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is False
        await client.aclose()


class TestLogin:
    """Tests for POST /api/auth/login."""

    async def test_correct_password_returns_200(self, app_with_auth):
        """Correct password → 200 + cookie set."""
        client = await app_with_auth()
        resp = await client.post("/api/auth/login", json={"password": "testpass123"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        # Cookie should be set in response
        assert "viz_session" in resp.cookies or any("viz_session" in str(h) for h in resp.headers.get_list("set-cookie"))
        await client.aclose()

    async def test_wrong_password_returns_401(self, app_with_auth):
        """Wrong password → 401."""
        client = await app_with_auth()
        resp = await client.post("/api/auth/login", json={"password": "wrongpass"})
        assert resp.status_code == 401
        await client.aclose()

    async def test_empty_password_returns_401(self, app_with_auth):
        """Empty password → 401."""
        client = await app_with_auth()
        resp = await client.post("/api/auth/login", json={"password": ""})
        assert resp.status_code == 401
        await client.aclose()


class TestRateLimiting:
    """Tests for login rate limiting."""

    async def test_five_attempts_allowed(self, app_with_auth):
        """5 failed attempts should all return 401 (not 429)."""
        client = await app_with_auth()
        for _ in range(5):
            resp = await client.post("/api/auth/login", json={"password": "wrong"})
            assert resp.status_code == 401
        await client.aclose()

    async def test_sixth_attempt_rate_limited(self, app_with_auth):
        """6th failed attempt → 429 with Retry-After header."""
        client = await app_with_auth()
        for _ in range(5):
            await client.post("/api/auth/login", json={"password": "wrong"})
        resp = await client.post("/api/auth/login", json={"password": "wrong"})
        assert resp.status_code == 429
        assert "Retry-After" in resp.headers
        await client.aclose()

    async def test_successful_login_clears_attempts(self, app_with_auth):
        """Successful login clears the failed attempts counter."""
        client = await app_with_auth()
        # Make 4 failed attempts
        for _ in range(4):
            await client.post("/api/auth/login", json={"password": "wrong"})
        # Successful login
        resp = await client.post("/api/auth/login", json={"password": "testpass123"})
        assert resp.status_code == 200
        # Next wrong attempt should not be rate-limited (counter cleared)
        resp = await client.post("/api/auth/login", json={"password": "wrong"})
        assert resp.status_code == 401  # Not 429
        await client.aclose()

    async def test_rate_limit_resets_after_window(self, app_with_auth):
        """Rate limit resets after the time window expires."""
        import backend.main as main_module
        client = await app_with_auth()
        # Make 5 failed attempts with timestamps in the past
        old_time = time.time() - main_module.RATE_LIMIT_WINDOW - 1
        main_module._login_attempts["testclient"] = [old_time] * 5
        # Next attempt should work (old ones expired)
        resp = await client.post("/api/auth/login", json={"password": "wrong"})
        assert resp.status_code == 401  # Not 429
        await client.aclose()


class TestAuthMiddleware:
    """Tests for the auth_middleware."""

    async def test_blocks_unauthenticated_api(self, app_with_auth):
        """Unauthenticated /api/* requests blocked with 401."""
        client = await app_with_auth()
        resp = await client.get("/api/health")
        # /api/health is exempt
        assert resp.status_code == 200

        resp = await client.get("/api/preset-metrics")
        assert resp.status_code == 401
        await client.aclose()

    async def test_allows_exempt_paths(self, app_with_auth):
        """Exempt paths (/health, /auth/*) are accessible without auth."""
        client = await app_with_auth()
        resp = await client.get("/api/health")
        assert resp.status_code == 200

        resp = await client.get("/api/auth/check")
        assert resp.status_code == 200
        await client.aclose()

    async def test_authenticated_passes(self, authenticated_client):
        """Authenticated requests pass through middleware."""
        client = await authenticated_client()
        resp = await client.get("/api/preset-metrics")
        assert resp.status_code == 200
        await client.aclose()

    async def test_disabled_when_no_password(self, app_no_auth):
        """Middleware disabled when VIZ_PASSWORD is None."""
        client = await app_no_auth()
        resp = await client.get("/api/preset-metrics")
        assert resp.status_code == 200
        await client.aclose()
