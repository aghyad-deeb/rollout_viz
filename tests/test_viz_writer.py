"""Tests for viz_writer — the blessed JSONL writer for all producers."""

import json

import pytest

from viz_writer import (
    ValidationError,
    canonicalize_sample,
    rollout_url,
    validate_sample,
    write_rollouts,
)


def _sample(content="hello", **attrs):
    s = {"messages": [{"role": "user", "content": content}]}
    if attrs:
        s["attributes"] = attrs
    return s


def _read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class TestValidation:
    def test_minimal_sample_is_valid(self):
        assert validate_sample(_sample()) == []

    def test_messages_required(self):
        assert validate_sample({"attributes": {}}) != []
        assert validate_sample({"messages": []}) != []

    def test_role_required(self):
        bad = {"messages": [{"content": "hi"}]}
        assert any("role" in p for p in validate_sample(bad))

    def test_message_needs_some_content_key(self):
        bad = {"messages": [{"role": "assistant"}]}
        assert any("content" in p for p in validate_sample(bad))

    def test_tool_calls_only_message_is_valid(self):
        ok = {"messages": [{"role": "assistant", "tool_calls": [{"function": {"name": "bash"}}]}]}
        assert validate_sample(ok) == []

    def test_content_parts_only_message_is_valid(self):
        ok = {"messages": [{"role": "assistant", "content_parts": [{"type": "text", "text": "x"}]}]}
        assert validate_sample(ok) == []

    def test_write_rejects_invalid(self, tmp_path):
        with pytest.raises(ValidationError, match="sample 0"):
            write_rollouts([{"messages": []}], str(tmp_path / "x.jsonl"))

    def test_write_rejects_empty_batch(self, tmp_path):
        with pytest.raises(ValidationError, match="no samples"):
            write_rollouts([], str(tmp_path / "x.jsonl"))


class TestCanonicalize:
    def test_stamps_viz_id_and_timestamp(self):
        out = canonicalize_sample(_sample())
        assert len(out["attributes"]["viz_id"]) == 32
        assert out["timestamp"]

    def test_preserves_existing_viz_id_and_timestamp(self):
        s = _sample(viz_id="abc123")
        s["timestamp"] = "2026-01-01T00:00:00"
        out = canonicalize_sample(s)
        assert out["attributes"]["viz_id"] == "abc123"
        assert out["timestamp"] == "2026-01-01T00:00:00"

    def test_never_fabricates_training_fields(self):
        out = canonicalize_sample(_sample())
        for key in ("reward", "step", "sample_index", "rollout_n"):
            assert key not in out["attributes"], f"{key} must not be fabricated"

    def test_lossless_passthrough_of_unknown_fields(self):
        s = _sample()
        s["diagnostics"] = [{"kind": "truncation", "detail": "x"}]
        s["messages"][0]["custom_field"] = {"nested": True}
        s["grades"] = {"m": []}
        out = canonicalize_sample(s)
        assert out["diagnostics"] == [{"kind": "truncation", "detail": "x"}]
        assert out["messages"][0]["custom_field"] == {"nested": True}
        assert out["grades"] == {"m": []}

    def test_does_not_mutate_caller_dict(self):
        s = _sample()
        canonicalize_sample(s)
        assert "attributes" not in s or "viz_id" not in s.get("attributes", {})
        assert "timestamp" not in s


class TestLocalWrites:
    def test_create_writes_and_links(self, tmp_path):
        dest = tmp_path / "out.jsonl"
        result = write_rollouts([_sample("a"), _sample("b")], str(dest))
        assert result.count == 2 and result.total == 2
        lines = _read_lines(dest)
        assert [m["messages"][0]["content"] for m in lines] == ["a", "b"]
        assert result.url.endswith(f"?file={str(dest).replace('/', '%2F')}")
        assert result.sample_urls[0].endswith("&index=0")
        assert result.sample_urls[1].endswith("&index=1")

    def test_create_fails_if_exists(self, tmp_path):
        dest = tmp_path / "out.jsonl"
        write_rollouts([_sample()], str(dest))
        with pytest.raises(FileExistsError):
            write_rollouts([_sample()], str(dest), mode="create")

    def test_append_extends_and_indexes_continue(self, tmp_path):
        dest = tmp_path / "out.jsonl"
        write_rollouts([_sample("a")], str(dest))
        result = write_rollouts([_sample("b")], str(dest), mode="append")
        assert result.count == 1 and result.total == 2
        assert result.sample_urls == [rollout_url(str(dest), 1)]
        assert len(_read_lines(dest)) == 2

    def test_overwrite_replaces(self, tmp_path):
        dest = tmp_path / "out.jsonl"
        write_rollouts([_sample("a"), _sample("b")], str(dest))
        result = write_rollouts([_sample("c")], str(dest), mode="overwrite")
        assert result.total == 1
        assert _read_lines(dest)[0]["messages"][0]["content"] == "c"

    def test_append_creates_missing_file(self, tmp_path):
        dest = tmp_path / "fresh.jsonl"
        result = write_rollouts([_sample()], str(dest), mode="append")
        assert result.total == 1

    def test_creates_parent_dirs(self, tmp_path):
        dest = tmp_path / "deep" / "nested" / "out.jsonl"
        write_rollouts([_sample()], str(dest))
        assert dest.exists()

    def test_every_written_sample_has_viz_id(self, tmp_path):
        dest = tmp_path / "out.jsonl"
        write_rollouts([_sample(), _sample()], str(dest))
        for line in _read_lines(dest):
            assert line["attributes"]["viz_id"]

    def test_bad_mode_rejected(self, tmp_path):
        with pytest.raises(ValueError, match="mode"):
            write_rollouts([_sample()], str(tmp_path / "x.jsonl"), mode="upsert")


class TestUrls:
    def test_rollout_url_defaults_to_localhost(self, monkeypatch):
        monkeypatch.delenv("VIZ_BASE_URL", raising=False)
        url = rollout_url("s3://b/k.jsonl", 3)
        assert url == "http://localhost:3000/?file=s3%3A%2F%2Fb%2Fk.jsonl&index=3"

    def test_rollout_url_env_override(self, monkeypatch):
        monkeypatch.setenv("VIZ_BASE_URL", "https://viz.example.com/")
        assert rollout_url("x.jsonl").startswith("https://viz.example.com/?file=")


@pytest.fixture
def writer_s3(monkeypatch):
    from moto import mock_aws
    import boto3

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="wbucket")
        yield client


class TestS3Writes:
    def test_create_and_read_back(self, writer_s3):
        result = write_rollouts([_sample("a")], "s3://wbucket/traces/x.jsonl")
        assert result.uri == "s3://wbucket/traces/x.jsonl"
        body = writer_s3.get_object(Bucket="wbucket", Key="traces/x.jsonl")["Body"].read()
        entry = json.loads(body.splitlines()[0])
        assert entry["messages"][0]["content"] == "a"
        assert entry["attributes"]["viz_id"]

    def test_create_fails_if_object_exists(self, writer_s3):
        write_rollouts([_sample()], "s3://wbucket/x.jsonl")
        with pytest.raises(FileExistsError):
            write_rollouts([_sample()], "s3://wbucket/x.jsonl", mode="create")

    def test_append_concatenates_and_continues_indexes(self, writer_s3):
        write_rollouts([_sample("a"), _sample("b")], "s3://wbucket/x.jsonl")
        result = write_rollouts([_sample("c")], "s3://wbucket/x.jsonl", mode="append")
        assert result.total == 3
        assert result.sample_urls[0].endswith("&index=2")
        body = writer_s3.get_object(Bucket="wbucket", Key="x.jsonl")["Body"].read()
        assert len([ln for ln in body.split(b"\n") if ln.strip()]) == 3

    def test_bad_destination_rejected(self, writer_s3):
        with pytest.raises(ValueError, match="s3 destination"):
            write_rollouts([_sample()], "s3://only-bucket-no-key")


class TestReviewHardening:
    """Regressions from the adversarial review of the writer."""

    def test_non_404_s3_errors_propagate_instead_of_masquerading_as_absence(self, monkeypatch, writer_s3):
        """A 503/403 from head_object must NOT be read as 'file absent' —
        that path let mode='append' silently replace an existing file."""
        import viz_writer
        from botocore.exceptions import ClientError as BotoClientError

        class StubExceptions:
            ClientError = BotoClientError

        class StubClient:
            exceptions = StubExceptions()

            def head_object(self, **kwargs):
                raise BotoClientError(
                    {"Error": {"Code": "SlowDown"},
                     "ResponseMetadata": {"HTTPStatusCode": 503}},
                    "HeadObject",
                )

            def put_object(self, **kwargs):
                raise AssertionError("must not write after a non-404 head failure")

        monkeypatch.setattr(viz_writer, "_s3_client", lambda: StubClient())
        with pytest.raises(BotoClientError):
            write_rollouts([_sample()], "s3://wbucket/existing.jsonl", mode="append")

    def test_404_from_head_still_means_absent(self, writer_s3):
        result = write_rollouts([_sample()], "s3://wbucket/fresh/new.jsonl", mode="append")
        assert result.total == 1

    def test_local_append_fixes_missing_trailing_newline(self, tmp_path):
        dest = tmp_path / "foreign.jsonl"
        dest.write_bytes(b'{"messages": [{"role": "user", "content": "old"}]}')  # no \n
        result = write_rollouts([_sample("new")], str(dest), mode="append")
        assert result.total == 2
        lines = [json.loads(l) for l in dest.read_text().splitlines() if l.strip()]
        assert len(lines) == 2
        assert lines[0]["messages"][0]["content"] == "old"
        assert lines[1]["messages"][0]["content"] == "new"

    def test_numpy_values_serialize_as_numbers_not_strings(self, tmp_path):
        np = pytest.importorskip("numpy")
        s = _sample()
        s["attributes"] = {
            "reward": np.float32(0.5),
            "pass_rate": np.float64(0.75),
            "count": np.int64(3),
            "flag": np.bool_(True),
            "vec": np.array([0.1, 0.2]),
        }
        dest = tmp_path / "np.jsonl"
        write_rollouts([s], str(dest))
        entry = json.loads(dest.read_text().splitlines()[0])
        attrs = entry["attributes"]
        assert attrs["reward"] == pytest.approx(0.5)
        assert isinstance(attrs["reward"], float)
        assert attrs["count"] == 3 and isinstance(attrs["count"], int)
        assert attrs["flag"] is True
        assert attrs["vec"] == [pytest.approx(0.1), pytest.approx(0.2)]


class TestDestFor:
    """dest_for: the one blessed spot per kind — producers stop inventing
    prefixes. Applies to NEW files only; historical files never move."""

    def test_kinds_map_to_canonical_prefixes(self):
        from viz_writer import dest_for
        assert dest_for("session", "probe_run", date="2026-07-05") == (
            "s3://rewardseeker/logs_jsonl/cli_sessions/2026-07-05/probe_run.jsonl"
        )
        assert dest_for("debug", "crash_1", date="2026-07-05").startswith(
            "s3://rewardseeker/logs_jsonl/debug_traces/2026-07-05/"
        )
        assert dest_for("training_run", "projA/exp1/step_0", date="2026-07-05") == (
            "s3://rewardseeker/logs_jsonl/rollout_traces_tinker/2026-07-05/projA/exp1/step_0.jsonl"
        )

    def test_unknown_kind_lists_valid_ones(self):
        from viz_writer import dest_for
        with pytest.raises(ValueError, match="session"):
            dest_for("mystery", "x")

    def test_date_defaults_to_today(self):
        from datetime import datetime
        from viz_writer import dest_for
        assert f"/{datetime.now().strftime('%Y-%m-%d')}/" in dest_for("probe", "x")

    def test_name_segments_sanitized(self):
        from viz_writer import dest_for
        dest = dest_for("session", "my exp!/run:1", date="2026-07-05")
        assert dest.endswith("/2026-07-05/my_exp_/run_1.jsonl")

    def test_traversal_segments_neutralized(self):
        from viz_writer import dest_for
        with pytest.raises(ValueError):
            dest_for("session", "../../etc/passwd", date="2026-07-05")

    def test_jsonl_extension_appended_once(self):
        from viz_writer import dest_for
        assert dest_for("session", "a.jsonl", date="2026-07-05").endswith("/a.jsonl")
        assert not dest_for("session", "a.jsonl", date="2026-07-05").endswith(".jsonl.jsonl")

    def test_custom_bucket(self):
        from viz_writer import dest_for
        assert dest_for("chat", "c", bucket="other", date="2026-07-05").startswith("s3://other/")
