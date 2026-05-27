"""Tests for production frontend serving and dev-source denial."""


class TestFrontendServingSecurity:
    async def test_dev_source_paths_are_not_served(self, app_no_auth):
        client = await app_no_auth()
        for path in (
            "/src/App.tsx",
            "/@vite/client",
            "/@fs/data2/Users/aghyad/reward_seeker/rollout_viz/backend/main.py",
            "/node_modules/.vite/deps/react.js",
            "/package.json",
            "/.env",
            "/assets/../src/App.tsx",
            "/assets/%2e%2e/src/App.tsx",
        ):
            resp = await client.get(path)
            assert resp.status_code == 404, f"{path} returned {resp.status_code}"
        await client.aclose()

    async def test_api_like_paths_do_not_fall_through_to_spa(self, app_with_auth):
        client = await app_with_auth()
        for path in (
            "http://test//rollout-viz.com/api/files/local?directory=.",
            "http://test//api/files/local?directory=.",
            "/\\api\\files\\local?directory=.",
            "/API/files/local?directory=.",
            "/%2fapi%2ffiles%2flocal?directory=.",
            "/api%2ffiles%2flocal?directory=.",
        ):
            resp = await client.get(path)
            assert resp.status_code in (401, 404), f"{path} returned {resp.status_code}"
            assert resp.headers.get("content-type", "").startswith("application/json")
        await client.aclose()

    async def test_unknown_authenticated_api_route_stays_404(self, authenticated_client):
        client = await authenticated_client()
        resp = await client.get("/api/does-not-exist")
        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")
        await client.aclose()

    async def test_cors_is_not_open_to_localhost_by_default(self, app_with_auth):
        client = await app_with_auth()
        resp = await client.options(
            "/api/available-api-keys",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert resp.status_code in (400, 401)
        assert "access-control-allow-origin" not in resp.headers
        await client.aclose()
