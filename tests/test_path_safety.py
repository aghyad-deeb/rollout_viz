"""Tests for path traversal prevention via _safe_resolve_path()."""

import pytest
from pathlib import Path


class TestSafeResolvePath:
    """Tests for _safe_resolve_path() security function."""

    def test_relative_path_within_project(self, patch_project_root):
        """Relative path within project resolves OK."""
        from backend.main import _safe_resolve_path
        # Create a test file so resolution works
        test_file = patch_project_root / "test.jsonl"
        test_file.touch()
        result = _safe_resolve_path("test.jsonl")
        assert result == test_file.resolve()

    def test_absolute_path_within_project(self, patch_project_root):
        """Absolute path within project resolves OK."""
        from backend.main import _safe_resolve_path
        test_file = patch_project_root / "data" / "test.jsonl"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.touch()
        result = _safe_resolve_path(str(test_file))
        assert result == test_file.resolve()

    def test_parent_traversal_rejected(self, patch_project_root):
        """../../etc/passwd style traversal rejected."""
        from backend.main import _safe_resolve_path
        with pytest.raises(ValueError, match="Access denied"):
            _safe_resolve_path("../../etc/passwd")

    def test_absolute_outside_rejected(self, patch_project_root):
        """Absolute path outside project rejected."""
        from backend.main import _safe_resolve_path
        with pytest.raises(ValueError, match="Access denied"):
            _safe_resolve_path("/etc/passwd")

    def test_double_dot_in_middle_rejected(self, patch_project_root):
        """Path with .. that escapes project rejected."""
        from backend.main import _safe_resolve_path
        with pytest.raises(ValueError, match="Access denied"):
            _safe_resolve_path("subdir/../../../../../../etc/passwd")

    def test_dot_slash_normalized(self, patch_project_root):
        """./file normalized correctly."""
        from backend.main import _safe_resolve_path
        test_file = patch_project_root / "file.jsonl"
        test_file.touch()
        result = _safe_resolve_path("./file.jsonl")
        assert result == test_file.resolve()

    def test_nested_path_within_project(self, patch_project_root):
        """Deeply nested path within project resolves OK."""
        from backend.main import _safe_resolve_path
        nested = patch_project_root / "a" / "b" / "c" / "test.jsonl"
        nested.parent.mkdir(parents=True, exist_ok=True)
        nested.touch()
        result = _safe_resolve_path("a/b/c/test.jsonl")
        assert result == nested.resolve()


class TestS3BucketAllowlist:
    """Tests for fail-closed S3 bucket validation."""

    def test_s3_bucket_allowlist_is_required(self, monkeypatch):
        import backend.main as main_module

        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", None)
        with pytest.raises(ValueError, match="allowlist"):
            main_module._validate_s3_bucket("test-bucket")

    def test_s3_bucket_allowlist_allows_configured_bucket(self, monkeypatch):
        import backend.main as main_module

        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", {"test-bucket"})
        main_module._validate_s3_bucket("test-bucket")

    def test_s3_bucket_allowlist_rejects_other_bucket(self, monkeypatch):
        import backend.main as main_module

        monkeypatch.setattr(main_module, "VIZ_ALLOWED_S3_BUCKETS", {"test-bucket"})
        with pytest.raises(ValueError, match="not allowed"):
            main_module._validate_s3_bucket("other-bucket")
