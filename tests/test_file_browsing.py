"""Tests for local and S3 file browsing."""

import json
import pytest
from pathlib import Path


class TestListLocalFiles:
    """Tests for list_local_files() — recursive JSONL listing."""

    def test_finds_jsonl_recursively(self, patch_project_root):
        from backend.main import list_local_files
        # Create nested JSONL files
        (patch_project_root / "a.jsonl").write_text('{"x":1}\n')
        sub = patch_project_root / "sub"
        sub.mkdir()
        (sub / "b.jsonl").write_text('{"x":2}\n')

        files = list_local_files(str(patch_project_root))
        keys = [f["key"] for f in files]
        assert len(files) == 2
        assert any("a.jsonl" in k for k in keys)
        assert any("b.jsonl" in k for k in keys)

    def test_empty_dir_returns_empty(self, patch_project_root):
        from backend.main import list_local_files
        empty = patch_project_root / "empty_dir"
        empty.mkdir()
        files = list_local_files(str(empty))
        assert files == []

    def test_nonexistent_dir_returns_empty(self, patch_project_root):
        from backend.main import list_local_files
        files = list_local_files(str(patch_project_root / "nope"))
        assert files == []

    def test_ignores_non_jsonl(self, patch_project_root):
        from backend.main import list_local_files
        (patch_project_root / "readme.txt").write_text("hello")
        (patch_project_root / "data.jsonl").write_text('{"x":1}\n')
        (patch_project_root / "data.json").write_text('{}')

        files = list_local_files(str(patch_project_root))
        assert len(files) == 1
        assert "data.jsonl" in files[0]["key"]

    def test_file_info_has_size_and_date(self, patch_project_root):
        from backend.main import list_local_files
        (patch_project_root / "test.jsonl").write_text('{"x":1}\n')
        files = list_local_files(str(patch_project_root))
        assert "size" in files[0]
        assert "last_modified" in files[0]
        assert files[0]["size"] > 0


class TestListLocalContents:
    """Tests for list_local_contents() — non-recursive."""

    def test_separates_folders_and_files(self, patch_project_root):
        from backend.main import list_local_contents
        (patch_project_root / "data.jsonl").write_text('{"x":1}\n')
        sub = patch_project_root / "subfolder"
        sub.mkdir()

        contents = list_local_contents(str(patch_project_root))
        assert len(contents["folders"]) >= 1
        assert len(contents["files"]) == 1
        assert contents["files"][0]["name"] == "data.jsonl"

    def test_alphabetical_sort(self, patch_project_root):
        from backend.main import list_local_contents
        (patch_project_root / "zebra.jsonl").write_text('{"x":1}\n')
        (patch_project_root / "alpha.jsonl").write_text('{"x":2}\n')

        contents = list_local_contents(str(patch_project_root))
        names = [f["name"] for f in contents["files"]]
        assert names == ["alpha.jsonl", "zebra.jsonl"]

    def test_non_recursive(self, patch_project_root):
        from backend.main import list_local_contents
        sub = patch_project_root / "sub"
        sub.mkdir()
        (sub / "nested.jsonl").write_text('{"x":1}\n')
        (patch_project_root / "top.jsonl").write_text('{"x":2}\n')

        contents = list_local_contents(str(patch_project_root))
        file_names = [f["name"] for f in contents["files"]]
        assert "top.jsonl" in file_names
        assert "nested.jsonl" not in file_names


class TestListS3Files:
    """Tests for list_s3_files() — recursive S3 listing."""

    def test_finds_jsonl(self, mock_s3):
        from backend.main import list_s3_files
        files = list_s3_files(mock_s3["bucket"], "data/")
        keys = [f["key"] for f in files]
        assert any("traces.jsonl" in k for k in keys)
        assert any("other.jsonl" in k for k in keys)
        assert any("nested.jsonl" in k for k in keys)

    def test_ignores_non_jsonl(self, mock_s3):
        from backend.main import list_s3_files
        files = list_s3_files(mock_s3["bucket"], "data/")
        keys = [f["key"] for f in files]
        assert not any("readme.txt" in k for k in keys)

    def test_prefix_filter(self, mock_s3):
        from backend.main import list_s3_files
        files = list_s3_files(mock_s3["bucket"], "data/subfolder/")
        assert len(files) == 1
        assert "nested.jsonl" in files[0]["key"]

    def test_empty_prefix(self, mock_s3):
        from backend.main import list_s3_files
        files = list_s3_files(mock_s3["bucket"], "nonexistent/")
        assert files == []


class TestListS3Contents:
    """Tests for list_s3_contents() — non-recursive S3 listing."""

    def test_folders_and_files(self, mock_s3):
        from backend.main import list_s3_contents
        contents = list_s3_contents(mock_s3["bucket"], "data/")
        # Should see subfolder/ as a folder
        folder_names = [f["name"] for f in contents["folders"]]
        assert "subfolder" in folder_names
        # Should see .jsonl files at this level
        file_keys = [f["key"] for f in contents["files"]]
        assert any("traces.jsonl" in k for k in file_keys)

    def test_trailing_slash_normalization(self, mock_s3):
        from backend.main import list_s3_contents
        # Both with and without trailing slash should work
        c1 = list_s3_contents(mock_s3["bucket"], "data")
        c2 = list_s3_contents(mock_s3["bucket"], "data/")
        assert len(c1["files"]) == len(c2["files"])


class TestFileEndpoints:
    """Tests for file browsing API endpoints."""

    async def test_get_local_files(self, app_no_auth, patch_project_root):
        (patch_project_root / "test.jsonl").write_text('{"x":1}\n')
        client = await app_no_auth()
        resp = await client.get(f"/api/files/local?directory={patch_project_root}")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        await client.aclose()

    async def test_get_local_contents(self, app_no_auth, patch_project_root):
        (patch_project_root / "test.jsonl").write_text('{"x":1}\n')
        sub = patch_project_root / "sub"
        sub.mkdir()
        client = await app_no_auth()
        resp = await client.get(f"/api/contents/local?directory={patch_project_root}")
        assert resp.status_code == 200
        data = resp.json()
        assert "folders" in data
        assert "files" in data
        await client.aclose()

    async def test_get_s3_files(self, app_no_auth, mock_s3):
        client = await app_no_auth()
        resp = await client.get(f"/api/files/s3?bucket={mock_s3['bucket']}&prefix=data/")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2
        await client.aclose()

    async def test_get_s3_contents(self, app_no_auth, mock_s3):
        client = await app_no_auth()
        resp = await client.get(f"/api/contents/s3?bucket={mock_s3['bucket']}&prefix=data/")
        assert resp.status_code == 200
        data = resp.json()
        assert "folders" in data
        assert "files" in data
        await client.aclose()
