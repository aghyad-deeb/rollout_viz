from unittest.mock import patch


class TestRolloutChatSecurity:
    async def test_requires_authenticated_password_session(self, app_no_auth):
        client = await app_no_auth()
        resp = await client.post("/api/rollout-chat-stream", json={
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "hello"}],
        })
        assert resp.status_code == 403
        await client.aclose()

    async def test_rejects_unlisted_model_before_router(self, authenticated_client):
        client = await authenticated_client()
        with patch("backend.main.httpx.AsyncClient") as async_client:
            resp = await client.post("/api/rollout-chat-stream", json={
                "model": "openai/very-expensive-model",
                "messages": [{"role": "user", "content": "hello"}],
            })
            assert resp.status_code == 400
            async_client.assert_not_called()
        await client.aclose()

    async def test_rejects_excessive_max_tokens_before_router(self, authenticated_client):
        client = await authenticated_client()
        with patch("backend.main.httpx.AsyncClient") as async_client:
            resp = await client.post("/api/rollout-chat-stream", json={
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 999999,
            })
            assert resp.status_code == 400
            async_client.assert_not_called()
        await client.aclose()

    async def test_rejects_invalid_role_before_router(self, authenticated_client):
        client = await authenticated_client()
        with patch("backend.main.httpx.AsyncClient") as async_client:
            resp = await client.post("/api/rollout-chat-stream", json={
                "model": "gpt-5.5",
                "messages": [{"role": "tool", "content": "hello"}],
            })
            assert resp.status_code == 400
            async_client.assert_not_called()
        await client.aclose()

    async def test_valid_request_forwards_allowlisted_payload(self, authenticated_client, monkeypatch):
        import backend.main as main_module

        client = await authenticated_client()
        captured = {}

        class FakeStream:
            status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def aiter_raw(self):
                yield b'event: response.done\ndata: {}\n\n'

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            def stream(self, method, url, json):
                captured["method"] = method
                captured["url"] = url
                captured["json"] = json
                return FakeStream()

        monkeypatch.setattr(main_module.httpx, "AsyncClient", FakeClient)
        resp = await client.post("/api/rollout-chat-stream", json={
            "model": "gpt-5.5",
            "messages": [{"role": "USER", "content": "hello"}],
            "max_tokens": 123,
        })
        assert resp.status_code == 200
        assert captured["json"]["model_name"] == "gpt-5.5"
        assert captured["json"]["messages"] == [{"role": "user", "content": "hello"}]
        assert captured["json"]["sampling"]["max_tokens"] == 123
        await client.aclose()
