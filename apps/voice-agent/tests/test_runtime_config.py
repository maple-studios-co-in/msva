from pathlib import Path

import pytest

from madhusudan_voice.config import RuntimeConfig, RuntimeDisabled


def test_runtime_is_disabled_by_default_without_provider_configuration():
    config = RuntimeConfig.from_env({})

    assert config.enabled is False
    with pytest.raises(RuntimeDisabled, match="VOICE_RUNTIME_ENABLED"):
        config.require_enabled()


def test_enabled_runtime_requires_all_scoped_dependencies(tmp_path: Path):
    with pytest.raises(RuntimeDisabled, match="LIVEKIT_URL"):
        RuntimeConfig.from_env(
            {
                "VOICE_RUNTIME_ENABLED": "true",
                "VOICE_STT_MODE": "realtime",
                "VOICE_SPOOL_PATH": str(tmp_path / "spool.db"),
            }
        )


def test_enabled_runtime_rejects_insecure_internal_endpoint(tmp_path: Path):
    env = enabled_env(tmp_path)
    env["VOICE_INTERNAL_API_URL"] = "http://internal.example/api/internal/voice/v1"

    with pytest.raises(RuntimeDisabled, match="https"):
        RuntimeConfig.from_env(env)


def test_enabled_runtime_uses_bounded_lease_and_spool(tmp_path: Path):
    config = RuntimeConfig.from_env(enabled_env(tmp_path))

    assert config.enabled is True
    assert config.lease_seconds == 30
    # Inside the API's 5 s evidence tolerance, so an end the API decides is noticed in time.
    assert config.lease_renew_seconds == 3
    assert config.spool_max_events == 10_000


@pytest.mark.parametrize("seconds", ["30", "5"])
def test_lease_renewal_stays_inside_the_lease_and_the_evidence_tolerance(tmp_path: Path, seconds: str):
    env = enabled_env(tmp_path)
    env["VOICE_LEASE_RENEW_SECONDS"] = seconds

    with pytest.raises(RuntimeDisabled, match="must be below"):
        RuntimeConfig.from_env(env)


def test_the_lease_cannot_outlast_the_apis(tmp_path: Path):
    env = enabled_env(tmp_path)
    env["VOICE_LEASE_SECONDS"] = "60"

    with pytest.raises(RuntimeDisabled, match="cannot exceed"):
        RuntimeConfig.from_env(env)


def enabled_env(tmp_path: Path) -> dict[str, str]:
    return {
        "VOICE_RUNTIME_ENABLED": "true",
        "LIVEKIT_URL": "ws://livekit.example:7880",
        "LIVEKIT_API_KEY": "key",
        "LIVEKIT_API_SECRET": "secret",
        "SARVAM_API_KEY": "sarvam",
        "ANTHROPIC_API_KEY": "anthropic",
        "VOICE_INTERNAL_API_URL": "https://api.example/api/internal/voice/v1",
        "VOICE_WORKER_CREDENTIAL": "worker-token",
        "VOICE_REPLAY_CREDENTIAL_KEY": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "VOICE_STT_MODE": "realtime",
        "VOICE_SPOOL_PATH": str(tmp_path / "spool.db"),
    }


def test_default_spool_holds_the_default_calls_at_the_api_limits():
    # The API's per-call ingestion limits (MAX_SESSION_EVENTS and MAX_SESSION_EVENT_BYTES).
    api_max_events, api_max_bytes = 5_000, 8 * 1024 * 1024
    # A Fernet-encrypted lease credential is stored with every event; 256 bytes bounds it.
    credential_bytes = 256
    config = RuntimeConfig.from_env({})

    assert config.spool_max_events >= config.call_limit * api_max_events
    assert config.spool_max_bytes >= config.call_limit * (api_max_bytes + api_max_events * credential_bytes)
