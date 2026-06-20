import os
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _run_script_security_check(home: Path, script: str):
    env = {
        "HOME": str(home),
        "LOG_DIR": str(home / "logs"),
        "PATH": os.environ.get("PATH", ""),
        "USE_SYSTEM_CLOUDFLARED": "false",
    }
    return subprocess.run(
        ["bash", script, "__check_security_config"],
        cwd=PROJECT_ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def _run_security_check(home: Path):
    return _run_script_security_check(home, "supervisor.sh")


def _run_legacy_security_check(home: Path):
    return _run_script_security_check(home, "launch.legacy.sh")


def test_supervisor_refuses_public_start_without_password(tmp_path):
    result = _run_security_check(tmp_path)
    assert result.returncode == 1
    assert "requires VIZ_PASSWORD" in result.stdout


def test_supervisor_accepts_password_with_secret(tmp_path):
    (tmp_path / ".env").write_text("VIZ_PASSWORD=testpass\nVIZ_SECRET_KEY=testsecret\n")
    result = _run_security_check(tmp_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_supervisor_refuses_aws_credentials_without_s3_allowlist(tmp_path):
    (tmp_path / ".env").write_text(
        "VIZ_PASSWORD=testpass\n"
        "VIZ_SECRET_KEY=testsecret\n"
        "AWS_ACCESS_KEY_ID=akid\n"
        "AWS_SECRET_ACCESS_KEY=secret\n"
    )
    result = _run_security_check(tmp_path)
    assert result.returncode == 1
    assert "VIZ_ALLOWED_S3_BUCKETS" in result.stdout


def test_legacy_refuses_public_start_without_password(tmp_path):
    result = _run_legacy_security_check(tmp_path)
    assert result.returncode == 1
    assert "requires VIZ_PASSWORD" in result.stdout


def test_legacy_accepts_password_with_secret(tmp_path):
    (tmp_path / ".env").write_text("VIZ_PASSWORD=testpass\nVIZ_SECRET_KEY=testsecret\n")
    result = _run_legacy_security_check(tmp_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_legacy_refuses_aws_credentials_without_s3_allowlist(tmp_path):
    (tmp_path / ".env").write_text(
        "VIZ_PASSWORD=testpass\n"
        "VIZ_SECRET_KEY=testsecret\n"
        "AWS_ACCESS_KEY_ID=akid\n"
        "AWS_SECRET_ACCESS_KEY=secret\n"
    )
    result = _run_legacy_security_check(tmp_path)
    assert result.returncode == 1
    assert "VIZ_ALLOWED_S3_BUCKETS" in result.stdout
