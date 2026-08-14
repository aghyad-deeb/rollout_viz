"""Tests for the companion-file endpoints.

GET /api/companion — list context files (plan.md, meta.json, execution.jsonl,
summary.json, ...) that live next to a loaded rollout file, in its own
directory and up to two parent directories.

GET /api/raw — serve one such file's raw content as text/plain (capped 2MB).
"""

import json

import pytest

RAW_CAP = 2 * 1024 * 1024  # keep in sync with companion_api._RAW_MAX_BYTES


@pytest.fixture
def register_router():
    """Register the companion router on the app.

    main.py does not include this router yet (it is wired by the orchestrator
    later); register it here. Guarded by a route-path scan rather than a bare
    module flag so it stays correct even after main.py starts including the
    router itself.

    The routes must sit BEFORE main.py's SPA catch-all route
    ("/{full_path:path}", which 404s unknown /api paths) — that is where
    main.py wires its own routers (fetch_api, library_api), so this mirrors
    production ordering.
    """
    import backend.main as main_module
    from backend.companion_api import router

    app = main_module.app
    existing = {getattr(r, "path", None) for r in app.routes}
    if "/api/companion" not in existing:
        n_before = len(app.router.routes)
        app.include_router(router)
        new_routes = app.router.routes[n_before:]
        del app.router.routes[n_before:]
        catch_all = next(
            (i for i, r in enumerate(app.router.routes)
             if getattr(r, "path", None) == "/{full_path:path}"),
            len(app.router.routes),
        )
        app.router.routes[catch_all:catch_all] = new_routes
    yield


def _write(path, content="x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    return path


@pytest.fixture
def run_layout(patch_project_root):
    """auto_eval-style run directory under the (patched) project root:

    session/
      plan.md, meta.json, results_summary.json     <- two levels up
      runs/
        notes.md                                   <- one level up
        stray.jsonl                                <- jsonl at parent level: excluded
        run_01/
          target.jsonl                             <- the loaded file
          execution.jsonl, summary.json            <- own-dir companions
          other.txt                                <- .txt: not listed
          .hidden.json                             <- dotfile: excluded
          viz/target.jsonl                         <- viz overlay: excluded
    root_decoy.md                                  <- three levels up: excluded
    """
    root = patch_project_root
    _write(root / "session" / "plan.md", "# plan")
    _write(root / "session" / "meta.json", json.dumps({"id": "ae_1"}))
    _write(root / "session" / "results_summary.json", json.dumps({"ok": True}))
    _write(root / "session" / "runs" / "notes.md", "notes")
    _write(root / "session" / "runs" / "stray.jsonl", "{}\n")
    _write(root / "session" / "runs" / "run_01" / "target.jsonl", "{}\n")
    _write(root / "session" / "runs" / "run_01" / "execution.jsonl", "{}\n{}\n")
    _write(root / "session" / "runs" / "run_01" / "summary.json", json.dumps({"n": 1}))
    _write(root / "session" / "runs" / "run_01" / "other.txt", "txt")
    _write(root / "session" / "runs" / "run_01" / ".hidden.json", "{}")
    _write(root / "session" / "runs" / "run_01" / "viz" / "target.jsonl", "{}\n")
    _write(root / "root_decoy.md", "decoy")
    return root


class TestCompanionLocal:
    async def test_run_dir_layout(self, app_no_auth, register_router, run_layout):
        client = await app_no_auth()
        resp = await client.get(
            "/api/companion", params={"file": "session/runs/run_01/target.jsonl"}
        )
        assert resp.status_code == 200
        companions = resp.json()["companions"]

        # Nearest-first (own dir, then parent, then grandparent), alphabetical
        # within a level. Names are relative to the deepest dir common to the
        # loaded file and every companion (here: session/).
        assert [c["name"] for c in companions] == [
            "runs/run_01/execution.jsonl",
            "runs/run_01/summary.json",
            "runs/notes.md",
            "meta.json",
            "plan.md",
            "results_summary.json",
        ]
        assert [c["kind"] for c in companions] == [
            "jsonl", "json", "markdown", "json", "markdown", "json",
        ]
        by_name = {c["name"]: c for c in companions}
        exec_entry = by_name["runs/run_01/execution.jsonl"]
        assert exec_entry["path"].endswith("session/runs/run_01/execution.jsonl")
        assert exec_entry["size"] == (run_layout / "session/runs/run_01/execution.jsonl").stat().st_size
        assert isinstance(by_name["plan.md"]["size"], int)

        # Self, dotfiles, .txt, parent-level jsonl, viz/, 3-levels-up all excluded
        paths = [c["path"] for c in companions]
        assert not any(p.endswith("run_01/target.jsonl") for p in paths)
        assert not any(".hidden" in p for p in paths)
        assert not any(p.endswith("other.txt") for p in paths)
        assert not any(p.endswith("stray.jsonl") for p in paths)
        assert not any("/viz/" in p for p in paths)
        assert not any(p.endswith("root_decoy.md") for p in paths)
        await client.aclose()

    async def test_own_dir_only_names_are_basenames(self, app_no_auth, register_router, patch_project_root):
        root = patch_project_root
        _write(root / "solo" / "run" / "target.jsonl", "{}\n")
        _write(root / "solo" / "run" / "execution.jsonl", "{}\n")
        client = await app_no_auth()
        resp = await client.get("/api/companion", params={"file": "solo/run/target.jsonl"})
        assert resp.status_code == 200
        companions = resp.json()["companions"]
        assert [c["name"] for c in companions] == ["execution.jsonl"]
        await client.aclose()

    async def test_viz_overlay_load_never_lists_viz_files(self, app_no_auth, register_router, patch_project_root):
        """Loading the viz/ overlay itself: sibling viz files are excluded,
        parent context (.json/.md) still surfaces."""
        root = patch_project_root
        _write(root / "run_01" / "summary.json", "{}")
        _write(root / "run_01" / "viz" / "target.jsonl", "{}\n")
        _write(root / "run_01" / "viz" / "other.jsonl", "{}\n")
        client = await app_no_auth()
        resp = await client.get("/api/companion", params={"file": "run_01/viz/target.jsonl"})
        assert resp.status_code == 200
        companions = resp.json()["companions"]
        assert not any("viz" in c["path"].split("/") for c in companions)
        assert any(c["path"].endswith("run_01/summary.json") for c in companions)
        await client.aclose()

    async def test_missing_file_returns_empty(self, app_no_auth, register_router, patch_project_root):
        client = await app_no_auth()
        resp = await client.get("/api/companion", params={"file": "nope/missing.jsonl"})
        assert resp.status_code == 200
        assert resp.json() == {"companions": []}
        await client.aclose()

    async def test_traversal_returns_empty(self, app_no_auth, register_router, patch_project_root):
        client = await app_no_auth()
        resp = await client.get(
            "/api/companion", params={"file": "../../../../etc/passwd"}
        )
        assert resp.status_code == 200
        assert resp.json() == {"companions": []}
        await client.aclose()

    async def test_cap_30_nearest_first(self, app_no_auth, register_router, patch_project_root):
        root = patch_project_root
        _write(root / "cap" / "run" / "target.jsonl", "{}\n")
        for i in range(35):
            _write(root / "cap" / "run" / f"c{i:02d}.json", "{}")
        _write(root / "cap" / "parent.md", "p")  # crowded out by own-dir files
        client = await app_no_auth()
        resp = await client.get("/api/companion", params={"file": "cap/run/target.jsonl"})
        assert resp.status_code == 200
        companions = resp.json()["companions"]
        assert len(companions) == 30
        assert all(c["path"].endswith(f"c{i:02d}.json") for i, c in enumerate(companions))
        await client.aclose()


class TestCompanionS3:
    @pytest.fixture
    def s3_run_layout(self, mock_s3):
        s3 = mock_s3["s3"]
        bucket = mock_s3["bucket"]
        objects = {
            "session/plan.md": b"# plan",
            "session/meta.json": b'{"id": "ae_1"}',
            "session/results_summary.json": b'{"ok": true}',
            "session/runs/notes.md": b"notes",
            "session/runs/stray.jsonl": b"{}\n",
            "session/runs/run_01/target.jsonl": b"{}\n",
            "session/runs/run_01/execution.jsonl": b"{}\n{}\n",
            "session/runs/run_01/summary.json": b'{"n": 1}',
            "session/runs/run_01/.hidden.json": b"{}",
            "session/runs/run_01/viz/target.jsonl": b"{}\n",
        }
        for key, body in objects.items():
            s3.put_object(Bucket=bucket, Key=key, Body=body)
        return {"bucket": bucket, "objects": objects}

    async def test_s3_run_dir_layout(self, app_no_auth, register_router, s3_run_layout):
        bucket = s3_run_layout["bucket"]
        client = await app_no_auth()
        resp = await client.get(
            "/api/companion",
            params={"file": f"s3://{bucket}/session/runs/run_01/target.jsonl"},
        )
        assert resp.status_code == 200
        companions = resp.json()["companions"]
        assert [c["name"] for c in companions] == [
            "runs/run_01/execution.jsonl",
            "runs/run_01/summary.json",
            "runs/notes.md",
            "meta.json",
            "plan.md",
            "results_summary.json",
        ]
        assert [c["kind"] for c in companions] == [
            "jsonl", "json", "markdown", "json", "markdown", "json",
        ]
        by_name = {c["name"]: c for c in companions}
        assert by_name["runs/run_01/execution.jsonl"]["path"] == (
            f"s3://{bucket}/session/runs/run_01/execution.jsonl"
        )
        assert by_name["runs/run_01/execution.jsonl"]["size"] == len(
            s3_run_layout["objects"]["session/runs/run_01/execution.jsonl"]
        )
        paths = [c["path"] for c in companions]
        assert not any(p.endswith("run_01/target.jsonl") for p in paths)
        assert not any("/viz/" in p for p in paths)
        assert not any(".hidden" in p for p in paths)
        assert not any(p.endswith("stray.jsonl") for p in paths)
        await client.aclose()

    async def test_s3_disallowed_bucket_returns_empty(self, app_no_auth, register_router, mock_s3):
        client = await app_no_auth()
        resp = await client.get(
            "/api/companion", params={"file": "s3://not-allowed/some/target.jsonl"}
        )
        assert resp.status_code == 200
        assert resp.json() == {"companions": []}
        await client.aclose()

    async def test_s3_missing_prefix_returns_empty(self, app_no_auth, register_router, mock_s3):
        client = await app_no_auth()
        resp = await client.get(
            "/api/companion",
            params={"file": f"s3://{mock_s3['bucket']}/no/such/prefix/target.jsonl"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"companions": []}
        await client.aclose()


class TestRawLocal:
    async def test_markdown_roundtrip(self, app_no_auth, register_router, patch_project_root):
        content = "# Plan\n\nStep one.\n"
        _write(patch_project_root / "sess" / "plan.md", content)
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "sess/plan.md"})
        assert resp.status_code == 200
        assert resp.text == content
        assert resp.headers["content-type"].startswith("text/plain")
        assert "x-truncated" not in resp.headers
        await client.aclose()

    async def test_json_roundtrip(self, app_no_auth, register_router, patch_project_root):
        content = json.dumps({"scenario": "s1", "runs": 4})
        _write(patch_project_root / "sess" / "meta.json", content)
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "sess/meta.json"})
        assert resp.status_code == 200
        assert resp.text == content
        await client.aclose()

    async def test_truncation_at_2mb_with_header(self, app_no_auth, register_router, patch_project_root):
        big = b"a" * (RAW_CAP + 1000)
        _write(patch_project_root / "big.txt", big)
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "big.txt"})
        assert resp.status_code == 200
        assert len(resp.content) == RAW_CAP
        assert resp.content == big[:RAW_CAP]
        assert resp.headers.get("x-truncated") == "true"
        await client.aclose()

    async def test_exactly_2mb_not_truncated(self, app_no_auth, register_router, patch_project_root):
        big = b"b" * RAW_CAP
        _write(patch_project_root / "exact.txt", big)
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "exact.txt"})
        assert resp.status_code == 200
        assert len(resp.content) == RAW_CAP
        assert "x-truncated" not in resp.headers
        await client.aclose()

    async def test_disallowed_extension_400(self, app_no_auth, register_router, patch_project_root):
        _write(patch_project_root / "script.py", "print('hi')")
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "script.py"})
        assert resp.status_code == 400
        await client.aclose()

    async def test_dotfile_400(self, app_no_auth, register_router, patch_project_root):
        _write(patch_project_root / ".secrets.yaml", "key: val")
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": ".secrets.yaml"})
        assert resp.status_code == 400
        await client.aclose()

    async def test_relative_traversal_rejected(self, app_no_auth, register_router, patch_project_root):
        # A real file OUTSIDE the (patched) project root, with an allowed
        # extension — reachable only via traversal. Must 4xx, never serve.
        outside = _write(patch_project_root.parent / "outside_secret.md", "secret")
        client = await app_no_auth()
        for attempt in (
            "../outside_secret.md",
            "sess/../../outside_secret.md",
            "../../../../etc/passwd",
        ):
            resp = await client.get("/api/raw", params={"file": attempt})
            assert 400 <= resp.status_code < 500, attempt
            assert b"secret" not in resp.content
        outside.unlink()
        await client.aclose()

    async def test_absolute_path_outside_root_rejected(self, app_no_auth, register_router, patch_project_root):
        outside = _write(patch_project_root.parent / "abs_secret.md", "secret")
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": str(outside)})
        assert 400 <= resp.status_code < 500
        assert b"secret" not in resp.content
        outside.unlink()
        await client.aclose()

    async def test_missing_file_404(self, app_no_auth, register_router, patch_project_root):
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "sess/nope.md"})
        assert resp.status_code == 404
        await client.aclose()


class TestRawS3:
    async def test_s3_roundtrip(self, app_no_auth, register_router, mock_s3):
        s3, bucket = mock_s3["s3"], mock_s3["bucket"]
        s3.put_object(Bucket=bucket, Key="session/plan.md", Body=b"# s3 plan")
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": f"s3://{bucket}/session/plan.md"})
        assert resp.status_code == 200
        assert resp.text == "# s3 plan"
        assert "x-truncated" not in resp.headers
        await client.aclose()

    async def test_s3_truncation(self, app_no_auth, register_router, mock_s3):
        s3, bucket = mock_s3["s3"], mock_s3["bucket"]
        s3.put_object(Bucket=bucket, Key="big.txt", Body=b"c" * (RAW_CAP + 500))
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": f"s3://{bucket}/big.txt"})
        assert resp.status_code == 200
        assert len(resp.content) == RAW_CAP
        assert resp.headers.get("x-truncated") == "true"
        await client.aclose()

    async def test_s3_missing_404(self, app_no_auth, register_router, mock_s3):
        client = await app_no_auth()
        resp = await client.get(
            "/api/raw", params={"file": f"s3://{mock_s3['bucket']}/nope.md"}
        )
        assert resp.status_code == 404
        await client.aclose()

    async def test_s3_disallowed_bucket_400(self, app_no_auth, register_router, mock_s3):
        client = await app_no_auth()
        resp = await client.get("/api/raw", params={"file": "s3://not-allowed/plan.md"})
        assert resp.status_code == 400
        await client.aclose()

    async def test_s3_disallowed_extension_400(self, app_no_auth, register_router, mock_s3):
        client = await app_no_auth()
        resp = await client.get(
            "/api/raw", params={"file": f"s3://{mock_s3['bucket']}/model.bin"}
        )
        assert resp.status_code == 400
        await client.aclose()


class TestCompanionAuth:
    async def test_companion_requires_auth(self, app_with_auth, register_router):
        client = await app_with_auth()
        resp = await client.get("/api/companion", params={"file": "x.jsonl"})
        assert resp.status_code == 401
        await client.aclose()

    async def test_raw_requires_auth(self, app_with_auth, register_router):
        client = await app_with_auth()
        resp = await client.get("/api/raw", params={"file": "x.md"})
        assert resp.status_code == 401
        await client.aclose()
