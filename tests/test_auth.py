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

    async def test_sensitive_api_routes_require_auth(self, app_with_auth):
        """S3, local file, config, grading, and write routes stay behind auth."""
        client = await app_with_auth()
        probes = [
            ("GET", "/api/files/local?directory=."),
            ("GET", "/api/contents/local?directory=."),
            ("GET", "/api/files/s3?bucket=rewardseeker&prefix="),
            ("GET", "/api/contents/s3?bucket=rewardseeker&prefix="),
            ("GET", "/api/samples?file=sample_rollout_traces.jsonl"),
            ("GET", "/api/sample/0?file=sample_rollout_traces.jsonl"),
            ("POST", "/api/samples/batch"),
            ("GET", "/api/preset-metrics"),
            ("POST", "/api/save-custom-metric"),
            ("DELETE", "/api/custom-metric/test"),
            ("GET", "/api/available-api-keys"),
            ("POST", "/api/test-provider"),
            ("POST", "/api/grade"),
            ("POST", "/api/grade-stream"),
            ("POST", "/api/rollout-chat-stream"),
            ("POST", "/api/save-graded"),
            ("POST", "/api/share/create"),
            ("POST", "/api/debug/clear-cache"),
        ]
        for method, path in probes:
            if method == "GET":
                resp = await client.get(path)
            elif method == "DELETE":
                resp = await client.delete(path)
            else:
                resp = await client.post(path, json={})
            assert resp.status_code == 401, f"{method} {path} returned {resp.status_code}"
        await client.aclose()


class TestShareTokens:
    """Tests for share token create, verify, and middleware enforcement."""

    async def test_create_requires_auth(self, app_with_auth):
        """POST /api/share/create requires authentication."""
        client = await app_with_auth()
        resp = await client.post("/api/share/create", json={"file": "sample_rollout_traces.jsonl"})
        assert resp.status_code == 401
        await client.aclose()

    async def test_create_and_verify(self, authenticated_client):
        """Authenticated user can create a share token and verify it."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={
            "file": "sample_rollout_traces.jsonl", "rollout": 703, "step": 1
        })
        assert resp.status_code == 200
        token = resp.json()["token"]
        assert token

        # Verify the token (public endpoint)
        resp = await client.get(f"/api/share/verify?token={token}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["valid"] is True
        assert data["file"] == "sample_rollout_traces.jsonl"
        assert data["rollout"] == 703
        assert data["step"] == 1
        await client.aclose()

    async def test_verify_invalid_token(self, app_with_auth):
        """Invalid share tokens return valid=False."""
        client = await app_with_auth()
        resp = await client.get("/api/share/verify?token=garbage-token")
        assert resp.status_code == 200
        data = resp.json()
        assert data["valid"] is False
        await client.aclose()

    async def test_share_token_grants_read_access(self, authenticated_client):
        """A valid share token allows GET /api/samples for the authorized file."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={"file": "sample_rollout_traces.jsonl"})
        token = resp.json()["token"]

        # Use the token without session cookie
        await client.aclose()
        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        transport = ASGITransport(app=main_module.app)
        anon = httpx.AsyncClient(transport=transport, base_url="http://test")
        resp = await anon.get(
            "/api/samples?file=sample_rollout_traces.jsonl",
            headers={"x-share-token": token},
        )
        assert resp.status_code == 200
        assert len(resp.json()["samples"]) > 0
        await anon.aclose()

    async def test_share_token_index_disambiguates_collisions(
        self, authenticated_client, temp_jsonl, patch_project_root
    ):
        """Two samples with identical (rollout_n, step) — the token's `index`
        field must pin the recipient to the exact row the creator clicked."""
        data = [
            {
                "messages": [{"role": "user", "content": "FIRST sample"}],
                "attributes": {"step": 7, "sample_index": 0, "rollout_n": 42,
                               "reward": 0.1, "data_source": "x",
                               "experiment_name": "e", "validate": False},
                "timestamp": "2026-01-01T00:00:00",
            },
            {
                "messages": [{"role": "user", "content": "SECOND sample"}],
                "attributes": {"step": 7, "sample_index": 1, "rollout_n": 42,
                               "reward": 0.2, "data_source": "x",
                               "experiment_name": "e", "validate": False},
                "timestamp": "2026-01-01T00:00:01",
            },
        ]
        temp_jsonl(data=data, filename="collide.jsonl")

        client = await authenticated_client()
        # Creator clicks "Share" on the second sample (index=1 within the file)
        resp = await client.post("/api/share/create", json={
            "file": "collide.jsonl", "rollout": 42, "step": 7, "index": 1,
        })
        assert resp.status_code == 200
        token = resp.json()["token"]

        # verify endpoint exposes the index for debugging/display
        resp = await client.get(f"/api/share/verify?token={token}")
        assert resp.json()["index"] == 1
        await client.aclose()

        # Anonymous recipient uses the token
        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        anon = httpx.AsyncClient(
            transport=ASGITransport(app=main_module.app),
            base_url="http://test",
        )
        resp = await anon.get(
            "/api/samples?file=collide.jsonl",
            headers={"x-share-token": token},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["samples"]) == 1, (
            f"Expected 1 sample after index disambiguation, got {len(body['samples'])}"
        )
        assert body["samples"][0]["messages"][0]["content"] == "SECOND sample"
        await anon.aclose()

    async def test_legacy_share_token_without_index_still_works(
        self, authenticated_client, temp_jsonl, patch_project_root
    ):
        """Tokens minted before `index` was added still filter by rollout/step."""
        data = [
            {
                "messages": [{"role": "user", "content": "A"}],
                "attributes": {"step": 1, "sample_index": 0, "rollout_n": 100,
                               "reward": 0.0, "data_source": "x",
                               "experiment_name": "e", "validate": False},
                "timestamp": "2026-01-01T00:00:00",
            },
            {
                "messages": [{"role": "user", "content": "B"}],
                "attributes": {"step": 2, "sample_index": 1, "rollout_n": 200,
                               "reward": 0.0, "data_source": "x",
                               "experiment_name": "e", "validate": False},
                "timestamp": "2026-01-01T00:00:01",
            },
        ]
        temp_jsonl(data=data, filename="legacy.jsonl")

        client = await authenticated_client()
        # No `index` in the payload — legacy creator.
        resp = await client.post("/api/share/create", json={
            "file": "legacy.jsonl", "rollout": 200, "step": 2,
        })
        token = resp.json()["token"]
        await client.aclose()

        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        anon = httpx.AsyncClient(
            transport=ASGITransport(app=main_module.app),
            base_url="http://test",
        )
        resp = await anon.get(
            "/api/samples?file=legacy.jsonl",
            headers={"x-share-token": token},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["samples"]) == 1
        assert body["samples"][0]["messages"][0]["content"] == "B"
        await anon.aclose()

    async def test_share_token_blocks_wrong_file(self, authenticated_client):
        """Share token rejects requests for a different file."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={"file": "sample_rollout_traces.jsonl"})
        token = resp.json()["token"]
        await client.aclose()

        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        transport = ASGITransport(app=main_module.app)
        anon = httpx.AsyncClient(transport=transport, base_url="http://test")
        resp = await anon.get(
            "/api/samples?file=other_file.jsonl",
            headers={"x-share-token": token},
        )
        assert resp.status_code == 403
        await anon.aclose()

    async def test_share_token_blocks_write_endpoints(self, authenticated_client):
        """Share token cannot access write endpoints (grading, saving, etc.)."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={"file": "sample_rollout_traces.jsonl"})
        token = resp.json()["token"]
        await client.aclose()

        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        transport = ASGITransport(app=main_module.app)
        anon = httpx.AsyncClient(transport=transport, base_url="http://test")

        blocked_endpoints = [
            ("POST", "/api/samples/batch"),
            ("POST", "/api/save-graded"),
            ("POST", "/api/grade"),
            ("POST", "/api/grade-stream"),
            ("POST", "/api/rollout-chat-stream"),
            ("GET", "/api/files/local"),
            ("GET", "/api/preset-metrics"),
            ("GET", "/api/available-api-keys"),
            ("POST", "/api/debug/clear-cache"),
        ]
        for method, path in blocked_endpoints:
            if method == "GET":
                resp = await anon.get(path, headers={"x-share-token": token})
            else:
                resp = await anon.post(path, headers={"x-share-token": token}, json={})
            assert resp.status_code in (403, 422), f"{method} {path} returned {resp.status_code}"
        await anon.aclose()

    async def test_share_token_blocks_missing_file_param(self, authenticated_client):
        """Share token rejects if file param is missing."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={"file": "sample_rollout_traces.jsonl"})
        token = resp.json()["token"]
        await client.aclose()

        import httpx
        from httpx._transports.asgi import ASGITransport
        import backend.main as main_module
        transport = ASGITransport(app=main_module.app)
        anon = httpx.AsyncClient(transport=transport, base_url="http://test")
        resp = await anon.get("/api/samples", headers={"x-share-token": token})
        assert resp.status_code in (403, 422)
        await anon.aclose()

    async def test_create_rejects_path_traversal(self, authenticated_client):
        """Cannot create share tokens for paths outside PROJECT_ROOT."""
        client = await authenticated_client()
        resp = await client.post("/api/share/create", json={"file": "../../etc/passwd"})
        assert resp.status_code == 400
        await client.aclose()
