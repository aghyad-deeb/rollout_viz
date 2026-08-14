"""Tests for the Library backend (GET /api/library, GET /api/library/preview).

The Library is the landing page's corpus index: kinds -> groups -> files,
derived from ONE S3 listing pass (no crawler, no per-file HEAD/GET), cached
with a TTL. Previews are a separate lazy endpoint doing a 32KB ranged GET.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def library_s3(mock_env_config):
    """Moto bucket seeded with the canonical library layout."""
    from moto import mock_aws
    import boto3
    import backend.main as main_module

    main_module._reset_s3_client()
    original_allowed = main_module.VIZ_ALLOWED_S3_BUCKETS

    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        bucket = "library-bucket"
        s3.create_bucket(Bucket=bucket)
        main_module.VIZ_ALLOWED_S3_BUCKETS = {bucket}
        mock_env_config(VIZ_LIBRARY_BUCKET=bucket)

        def put(key, body=b'{"messages": [{"role": "user", "content": "hi"}]}\n'):
            s3.put_object(Bucket=bucket, Key=key, Body=body)

        # Evals: one experiment with a graded run (viz/ sidecar) + one ungraded
        put("logs_jsonl/auto_eval/ae_20260701_demo/runs/run_01/target.jsonl")
        put("logs_jsonl/auto_eval/ae_20260701_demo/runs/run_01/viz/target.jsonl")
        put("logs_jsonl/auto_eval/ae_20260701_demo/notes.txt", b"not a jsonl")
        put("logs_jsonl/auto_eval/ae_20260702_other/runs/run_01/target.jsonl")
        # Training runs: project/experiment with two step files
        put("logs_jsonl/rollout_traces_tinker/projA/exp1/step_0.jsonl")
        put("logs_jsonl/rollout_traces_tinker/projA/exp1/step_1.jsonl")
        # Chats: both source prefixes, grouped by date
        put("logs_jsonl/chats/2026-07-01/chat_a.jsonl")
        put("logs_jsonl/online_chats/2026-07-02/chat_b.jsonl")
        # Agent sessions
        put("cli_sessions/2026-07-03/sess_1.jsonl")
        # Probes: a FILE directly under the prefix -> group named after itself
        put("target_probes/loose_probe.jsonl")
        # Debug traces: empty on purpose

        yield {"s3": s3, "bucket": bucket, "put": put}

        main_module._reset_s3_client()
        main_module.VIZ_ALLOWED_S3_BUCKETS = original_allowed


def _kind(body, kind):
    return next(k for k in body["kinds"] if k["kind"] == kind)


def _group(kind_entry, name):
    return next(g for g in kind_entry["groups"] if g["name"] == name)


def _obj(key, last_modified, size=10):
    return {"key": key, "size": size, "last_modified": last_modified}


_BASE_TS = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# GET /api/library — shape
# ---------------------------------------------------------------------------

class TestLibraryShape:
    async def test_all_kinds_present_in_order(self, app_no_auth, library_s3):
        client = await app_no_auth()
        resp = await client.get("/api/library")
        assert resp.status_code == 200
        body = resp.json()
        assert [k["kind"] for k in body["kinds"]] == [
            "evals", "training_runs", "chats",
            "agent_sessions", "probes", "debug_traces",
        ]
        assert [k["title"] for k in body["kinds"]] == [
            "Evals", "Training runs", "Chats",
            "Agent sessions", "Probes", "Debug traces",
        ]
        assert body["from_cache"] is False
        assert isinstance(body["generated_at"], str)
        assert "error" not in body
        await client.aclose()

    async def test_evals_grouped_by_experiment_dir(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        evals = _kind(body, "evals")
        assert evals["total_group_count"] == 2
        assert {g["name"] for g in evals["groups"]} == {
            "ae_20260701_demo", "ae_20260702_other",
        }
        demo = _group(evals, "ae_20260701_demo")
        assert demo["prefix"] == f"s3://{bucket}/logs_jsonl/auto_eval/ae_20260701_demo/"
        # viz sidecar and notes.txt are NOT files
        assert demo["file_count"] == 1
        assert len(demo["files"]) == 1
        f = demo["files"][0]
        assert f["path"] == (
            f"s3://{bucket}/logs_jsonl/auto_eval/ae_20260701_demo/runs/run_01/target.jsonl"
        )
        assert f["name"] == "runs/run_01/target.jsonl"
        assert isinstance(f["size"], int)
        assert isinstance(f["last_modified"], str)
        await client.aclose()

    async def test_training_runs_grouped_by_project_experiment(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        training = _kind(body, "training_runs")
        assert training["total_group_count"] == 1
        g = training["groups"][0]
        assert g["name"] == "projA/exp1"
        assert g["prefix"] == f"s3://{bucket}/logs_jsonl/rollout_traces_tinker/projA/exp1/"
        assert g["file_count"] == 2
        assert {f["name"] for f in g["files"]} == {"step_0.jsonl", "step_1.jsonl"}
        await client.aclose()

    async def test_chats_grouped_by_date_across_both_prefixes(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        chats = _kind(body, "chats")
        assert chats["total_group_count"] == 2
        assert {g["name"] for g in chats["groups"]} == {"2026-07-01", "2026-07-02"}
        online = _group(chats, "2026-07-02")
        assert "online_chats" in online["prefix"]
        assert online["files"][0]["name"] == "chat_b.jsonl"
        await client.aclose()

    async def test_agent_sessions_and_loose_probe_file(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        sessions = _kind(body, "agent_sessions")
        assert {g["name"] for g in sessions["groups"]} == {"2026-07-03"}
        probes = _kind(body, "probes")
        # A file directly under the prefix becomes its own group
        assert probes["total_group_count"] == 1
        g = probes["groups"][0]
        assert g["name"] == "loose_probe.jsonl"
        assert g["file_count"] == 1
        assert g["files"][0]["name"] == "loose_probe.jsonl"
        assert g["files"][0]["path"] == f"s3://{bucket}/target_probes/loose_probe.jsonl"
        await client.aclose()

    async def test_empty_kind_has_zero_groups(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        debug = _kind(body, "debug_traces")
        assert debug["total_group_count"] == 0
        assert debug["groups"] == []
        await client.aclose()

    async def test_viz_sidecars_never_listed_as_files(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        for kind in body["kinds"]:
            for group in kind["groups"]:
                for f in group["files"]:
                    assert "/viz/" not in f["path"], f"sidecar leaked: {f['path']}"
        await client.aclose()

    async def test_total_bytes_sums_loadable_files_only(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        demo = _group(_kind(body, "evals"), "ae_20260701_demo")
        # Exactly the single target.jsonl (not the sidecar, not notes.txt)
        assert demo["total_bytes"] == demo["files"][0]["size"]
        await client.aclose()


# ---------------------------------------------------------------------------
# Graded flags
# ---------------------------------------------------------------------------

class TestGradedFlags:
    async def test_graded_flags_exact(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        evals = _kind(body, "evals")
        demo = _group(evals, "ae_20260701_demo")
        other = _group(evals, "ae_20260702_other")
        assert demo["graded"] is True
        assert demo["files"][0]["graded"] is True
        assert other["graded"] is False
        assert other["files"][0]["graded"] is False
        training = _kind(body, "training_runs")
        assert training["groups"][0]["graded"] is False
        assert all(f["graded"] is False for f in training["groups"][0]["files"])
        await client.aclose()

    def test_sidecar_must_match_exact_dirname_and_basename(self):
        """viz/other.jsonl does not grade target.jsonl; a sibling dir's viz does not leak."""
        from backend.library_api import _build_kinds
        objects = [
            _obj("logs_jsonl/auto_eval/ae_x/a.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_x/viz/other.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_y/b.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_y/sub/viz/b.jsonl", _BASE_TS),
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        ax = next(g for g in evals["groups"] if g["name"] == "ae_x")
        ay = next(g for g in evals["groups"] if g["name"] == "ae_y")
        assert ax["files"][0]["graded"] is False
        assert ax["graded"] is False
        assert ay["files"][0]["graded"] is False


# ---------------------------------------------------------------------------
# Sorting and caps (pure grouping function, synthetic timestamps)
# ---------------------------------------------------------------------------

class TestSortingAndCaps:
    def test_groups_sorted_by_last_modified_desc(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj("logs_jsonl/auto_eval/ae_old/r.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_new/r.jsonl", _BASE_TS + timedelta(hours=2)),
            _obj("logs_jsonl/auto_eval/ae_mid/r.jsonl", _BASE_TS + timedelta(hours=1)),
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        assert [g["name"] for g in evals["groups"]] == ["ae_new", "ae_mid", "ae_old"]
        assert evals["groups"][0]["last_modified"] == (
            (_BASE_TS + timedelta(hours=2)).isoformat()
        )

    def test_files_sorted_by_last_modified_desc_within_group(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj("logs_jsonl/auto_eval/ae_x/old.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_x/new.jsonl", _BASE_TS + timedelta(minutes=5)),
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        assert [f["name"] for f in evals["groups"][0]["files"]] == [
            "new.jsonl", "old.jsonl",
        ]

    def test_group_last_modified_is_newest_file(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj("logs_jsonl/auto_eval/ae_x/old.jsonl", _BASE_TS),
            _obj("logs_jsonl/auto_eval/ae_x/new.jsonl", _BASE_TS + timedelta(days=1)),
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        assert evals["groups"][0]["last_modified"] == (
            (_BASE_TS + timedelta(days=1)).isoformat()
        )

    def test_group_cap_keeps_newest_50_and_reports_real_total(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj(f"logs_jsonl/auto_eval/ae_{i:03d}/r.jsonl", _BASE_TS + timedelta(minutes=i))
            for i in range(55)
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        assert evals["total_group_count"] == 55
        assert len(evals["groups"]) == 50
        # Newest kept, oldest 5 dropped
        assert evals["groups"][0]["name"] == "ae_054"
        assert evals["groups"][-1]["name"] == "ae_005"

    def test_file_cap_keeps_newest_60_and_reports_real_counts(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj(f"logs_jsonl/auto_eval/ae_x/f_{i:03d}.jsonl",
                 _BASE_TS + timedelta(minutes=i), size=7)
            for i in range(65)
        ]
        kinds = _build_kinds("b", objects)
        evals = next(k for k in kinds if k["kind"] == "evals")
        g = evals["groups"][0]
        assert g["file_count"] == 65          # real, pre-cap
        assert len(g["files"]) == 60          # capped
        assert g["total_bytes"] == 65 * 7     # pre-cap
        assert g["files"][0]["name"] == "f_064.jsonl"
        assert g["files"][-1]["name"] == "f_005.jsonl"

    def test_merged_chat_group_prefix_follows_newest_file(self):
        from backend.library_api import _build_kinds
        objects = [
            _obj("logs_jsonl/chats/2026-07-01/a.jsonl", _BASE_TS),
            _obj("logs_jsonl/online_chats/2026-07-01/b.jsonl", _BASE_TS + timedelta(hours=1)),
        ]
        kinds = _build_kinds("b", objects)
        chats = next(k for k in kinds if k["kind"] == "chats")
        assert chats["total_group_count"] == 1
        g = chats["groups"][0]
        assert g["name"] == "2026-07-01"
        assert g["file_count"] == 2
        assert g["prefix"] == "s3://b/logs_jsonl/online_chats/2026-07-01/"


# ---------------------------------------------------------------------------
# TTL cache
# ---------------------------------------------------------------------------

class TestLibraryCache:
    async def test_second_call_served_from_cache(self, app_no_auth, library_s3):
        client = await app_no_auth()
        first = (await client.get("/api/library")).json()
        assert first["from_cache"] is False
        second = (await client.get("/api/library")).json()
        assert second["from_cache"] is True
        assert second["generated_at"] == first["generated_at"]
        assert second["kinds"] == first["kinds"]
        await client.aclose()

    async def test_cached_call_does_no_listing(self, app_no_auth, library_s3):
        import backend.main as main_module
        client = await app_no_auth()
        await client.get("/api/library")
        s3_client = main_module._get_s3_client()
        calls = [0]
        original = s3_client.list_objects_v2

        def counting(*args, **kwargs):
            calls[0] += 1
            return original(*args, **kwargs)

        s3_client.list_objects_v2 = counting
        try:
            body = (await client.get("/api/library")).json()
        finally:
            s3_client.list_objects_v2 = original
        assert body["from_cache"] is True
        assert calls[0] == 0
        await client.aclose()

    async def test_clear_library_cache_forces_rescan(self, app_no_auth, library_s3):
        from backend.library_api import _clear_library_cache
        client = await app_no_auth()
        await client.get("/api/library")
        # New object appears; cached response won't see it until cleared
        library_s3["put"]("debug_traces/dt_run/trace.jsonl")
        stale = (await client.get("/api/library")).json()
        assert stale["from_cache"] is True
        assert _kind(stale, "debug_traces")["total_group_count"] == 0
        _clear_library_cache()
        fresh = (await client.get("/api/library")).json()
        assert fresh["from_cache"] is False
        assert _kind(fresh, "debug_traces")["total_group_count"] == 1
        await client.aclose()

    async def test_concurrent_cold_requests_share_one_scan(self, app_no_auth, library_s3):
        """Two simultaneous cold requests must not each run a full listing.

        A cold scan of the real bucket is expensive; without single-flight, a
        page refresh during that window doubles the S3 load. The exact call
        count depends on the scanner's fan-out shape, so measure ONE scan
        first, then assert two concurrent scans cost the same, not double.
        """
        import asyncio
        import threading
        import backend.main as main_module
        from backend.library_api import _clear_library_cache
        client = await app_no_auth()
        s3_client = main_module._get_s3_client()
        calls = [0]
        lock = threading.Lock()
        original = s3_client.list_objects_v2

        def counting(*args, **kwargs):
            with lock:  # the parallel scanner calls this from worker threads
                calls[0] += 1
            return original(*args, **kwargs)

        s3_client.list_objects_v2 = counting
        try:
            await client.get("/api/library")
            single_scan_calls = calls[0]
            assert single_scan_calls > 0

            _clear_library_cache()
            calls[0] = 0
            r1, r2 = await asyncio.gather(
                client.get("/api/library"), client.get("/api/library")
            )
        finally:
            s3_client.list_objects_v2 = original
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["generated_at"] == r2.json()["generated_at"]
        assert calls[0] == single_scan_calls, (
            f"two concurrent cold requests cost {calls[0]} list calls; "
            f"one shared scan costs {single_scan_calls}"
        )
        await client.aclose()

    async def test_parallel_scan_matches_flat_listing(self, app_no_auth, library_s3):
        """The fan-out scanner must return exactly the objects a flat
        recursive listing returns — parallelization must never change WHAT
        gets listed."""
        import backend.library_api as library_module
        import backend.main as main_module

        objects = library_module._scan_bucket("library-bucket")
        got = {(o["key"], o["size"]) for o in objects}

        s3_client = main_module._get_s3_client()
        expected = set()
        paginator = s3_client.get_paginator("list_objects_v2")
        for _, _, prefixes, _ in library_module._KIND_SPECS:
            for prefix in dict.fromkeys(prefixes):
                for page in paginator.paginate(Bucket="library-bucket", Prefix=prefix):
                    for obj in page.get("Contents", []):
                        expected.add((obj["Key"], obj["Size"]))
        assert got == expected

    async def test_ttl_expiry_serves_stale_and_revalidates_in_background(self, app_no_auth, library_s3, monkeypatch):
        """Past the TTL the endpoint must NOT block on a rescan (cold scans of
        the real bucket take ~90s): it serves the stale copy immediately,
        marked stale, while one background scan refreshes the cache."""
        import backend.library_api as library_module
        client = await app_no_auth()
        t = [1000.0]
        monkeypatch.setattr(library_module, "_now", lambda: t[0])
        first = (await client.get("/api/library")).json()
        assert first["from_cache"] is False
        t[0] += library_module._LIBRARY_TTL - 1.0
        fresh = (await client.get("/api/library")).json()
        assert fresh["from_cache"] is True and fresh["stale"] is False
        t[0] += 2.0  # now past the TTL
        stale = (await client.get("/api/library")).json()
        assert stale["from_cache"] is True and stale["stale"] is True
        # The background refresh (single-flight) lands; the next call is fresh.
        inflight = library_module._inflight_scan
        assert inflight is not None
        await inflight[1]
        after = (await client.get("/api/library")).json()
        assert after["from_cache"] is True and after["stale"] is False
        await client.aclose()


# ---------------------------------------------------------------------------
# Unavailable S3 -> 200 with error, never 5xx
# ---------------------------------------------------------------------------

class TestLibraryErrors:
    async def test_no_allowlist_returns_200_with_error(self, app_no_auth, monkeypatch):
        import backend.main as main_module
        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", None)
        client = await app_no_auth()
        resp = await client.get("/api/library")
        assert resp.status_code == 200
        body = resp.json()
        assert body["kinds"] == []
        assert body["from_cache"] is False
        assert body["error"]
        await client.aclose()

    async def test_bucket_not_allowed_returns_200_with_error(self, app_no_auth, monkeypatch, mock_env_config):
        import backend.main as main_module
        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", {"some-other-bucket"})
        mock_env_config(VIZ_LIBRARY_BUCKET="not-allowed-bucket")
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        assert body["kinds"] == []
        assert "not-allowed-bucket" in body["error"]
        await client.aclose()

    async def test_default_bucket_is_rewardseeker(self, app_no_auth, monkeypatch):
        import backend.main as main_module
        monkeypatch.delitem(main_module._env_config, "VIZ_LIBRARY_BUCKET", raising=False)
        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", {"unrelated"})
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        # Error message names the default bucket -> proves the default applied
        assert "rewardseeker" in body["error"]
        await client.aclose()

    async def test_error_responses_are_not_cached(self, app_no_auth, monkeypatch):
        import backend.main as main_module
        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", None)
        client = await app_no_auth()
        assert (await client.get("/api/library")).json()["from_cache"] is False
        assert (await client.get("/api/library")).json()["from_cache"] is False
        await client.aclose()


# ---------------------------------------------------------------------------
# GET /api/library/preview
# ---------------------------------------------------------------------------

def _preview_line(**overrides):
    entry = {
        "messages": [
            {"role": "system", "content": "sys prompt"},
            {"role": "user", "content": "  What   is\n\n up?  "},
            {"role": "assistant", "content": "hi there"},
        ],
        "attributes": {"experiment_name": "exp_lib", "model_id": "model-7b"},
        "timestamp": "2026-07-01T10:00:00",
    }
    entry.update(overrides)
    return json.dumps(entry)


class TestPreview:
    async def test_happy_path(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/preview_me.jsonl"
        line = _preview_line()
        library_s3["put"](key, (line + "\n" + line + "\n").encode())
        client = await app_no_auth()
        resp = await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/{key}"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["available"] is True
        assert body["experiment_name"] == "exp_lib"
        assert body["model_id"] == "model-7b"
        assert body["first_user_message"] == "What is up?"  # whitespace collapsed
        assert body["message_count"] == 3
        assert body["timestamp"] == "2026-07-01T10:00:00"
        await client.aclose()

    async def test_first_user_message_truncated_to_240(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/long_user.jsonl"
        long_msg = "word  " * 300  # collapses to ~1500 chars
        line = _preview_line(messages=[{"role": "user", "content": long_msg}])
        library_s3["put"](key, (line + "\n").encode())
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/{key}"}
        )).json()
        assert body["available"] is True
        assert len(body["first_user_message"]) <= 240
        assert "  " not in body["first_user_message"]
        await client.aclose()

    async def test_missing_fields_are_null(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/bare.jsonl"
        line = json.dumps({"messages": [{"role": "assistant", "content": "no user"}]})
        library_s3["put"](key, (line + "\n").encode())
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/{key}"}
        )).json()
        assert body["available"] is True
        assert body["experiment_name"] is None
        assert body["model_id"] is None
        assert body["first_user_message"] is None
        assert body["timestamp"] is None
        assert body["message_count"] == 1
        await client.aclose()

    async def test_junk_first_line_unavailable(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/junk.jsonl"
        library_s3["put"](key, b"{this is not json at all\nmore junk\n")
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/{key}"}
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_truncated_first_line_unavailable(self, app_no_auth, library_s3):
        """First line longer than the 32KB ranged read -> cannot parse -> unavailable."""
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/huge_line.jsonl"
        library_s3["put"](key, b"x" * 40000)  # no newline within first 32KB
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/{key}"}
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_non_jsonl_file_unavailable(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview",
            params={"file": f"s3://{bucket}/logs_jsonl/auto_eval/ae_20260701_demo/notes.txt"},
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_absent_file_unavailable(self, app_no_auth, library_s3):
        bucket = library_s3["bucket"]
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": f"s3://{bucket}/nope/missing.jsonl"}
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_non_s3_path_unavailable(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": "/etc/passwd"}
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_disallowed_bucket_unavailable(self, app_no_auth, library_s3):
        client = await app_no_auth()
        body = (await client.get(
            "/api/library/preview", params={"file": "s3://not-allowed/x.jsonl"}
        )).json()
        assert body == {"available": False}
        await client.aclose()

    async def test_preview_cached_second_call_no_get(self, app_no_auth, library_s3):
        import backend.main as main_module
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/cached.jsonl"
        library_s3["put"](key, (_preview_line() + "\n").encode())
        client = await app_no_auth()
        params = {"file": f"s3://{bucket}/{key}"}
        first = (await client.get("/api/library/preview", params=params)).json()
        assert first["available"] is True

        s3_client = main_module._get_s3_client()
        calls = [0]
        original = s3_client.get_object

        def counting(*args, **kwargs):
            calls[0] += 1
            return original(*args, **kwargs)

        s3_client.get_object = counting
        try:
            second = (await client.get("/api/library/preview", params=params)).json()
        finally:
            s3_client.get_object = original
        assert second == first
        assert calls[0] == 0
        await client.aclose()

    async def test_clear_library_cache_clears_preview_cache(self, app_no_auth, library_s3):
        from backend.library_api import _clear_library_cache, _preview_cache
        bucket = library_s3["bucket"]
        key = "logs_jsonl/chats/2026-07-01/clearable.jsonl"
        library_s3["put"](key, (_preview_line() + "\n").encode())
        client = await app_no_auth()
        await client.get("/api/library/preview", params={"file": f"s3://{bucket}/{key}"})
        assert len(_preview_cache) == 1
        _clear_library_cache()
        assert len(_preview_cache) == 0
        await client.aclose()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestLibraryAuth:
    def test_not_in_auth_exempt_paths(self):
        from backend.main import AUTH_EXEMPT_PATHS
        assert "/api/library" not in AUTH_EXEMPT_PATHS
        assert "/api/library/preview" not in AUTH_EXEMPT_PATHS

    async def test_library_requires_auth(self, app_with_auth):
        client = await app_with_auth()
        resp = await client.get("/api/library")
        assert resp.status_code == 401
        await client.aclose()

    async def test_preview_requires_auth(self, app_with_auth):
        client = await app_with_auth()
        resp = await client.get(
            "/api/library/preview", params={"file": "s3://b/x.jsonl"}
        )
        assert resp.status_code == 401
        await client.aclose()


class TestCanonicalPrefixMerge:
    """New writes land under logs_jsonl/ (viz_writer.dest_for); legacy files
    stay at the root prefixes. The Library must merge both into one kind."""

    async def test_sessions_merge_across_legacy_and_canonical_prefixes(self, app_no_auth, library_s3):
        library_s3["put"]("logs_jsonl/cli_sessions/2026-07-05/new_style.jsonl")
        client = await app_no_auth()
        body = (await client.get("/api/library")).json()
        sessions = next(k for k in body["kinds"] if k["kind"] == "agent_sessions")
        names = {g["name"] for g in sessions["groups"]}
        assert names == {"2026-07-03", "2026-07-05"}  # legacy root + new canonical
        new_group = next(g for g in sessions["groups"] if g["name"] == "2026-07-05")
        assert new_group["files"][0]["name"] == "new_style.jsonl"
        assert "logs_jsonl/cli_sessions" in new_group["files"][0]["path"]
        await client.aclose()
