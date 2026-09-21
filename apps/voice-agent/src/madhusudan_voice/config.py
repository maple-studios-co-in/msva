"""Configuration that makes unsafe partial worker startup impossible."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class RuntimeDisabled(RuntimeError):
    """The worker cannot accept a call with its current configuration."""


def _required(env: dict[str, str], name: str, context: str = "VOICE_RUNTIME_ENABLED=true") -> str:
    value = env.get(name, "").strip()
    if not value or value.startswith("replace-with-"):
        raise RuntimeDisabled(f"{name} is required when {context}")
    return value


def _positive_int(env: dict[str, str], name: str, default: int) -> int:
    value = env.get(name, str(default))
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeDisabled(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise RuntimeDisabled(f"{name} must be greater than zero")
    return parsed


def _https_url(value: str, name: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeDisabled(f"{name} must be an https URL without embedded credentials")
    return value.rstrip("/")


def _internal_livekit_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"ws", "wss"} or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeDisabled("LIVEKIT_URL must be a ws or wss URL without embedded credentials")
    return value.rstrip("/")


DEFAULT_SPOOL_PATH = "/var/lib/msva-voice-agent/spool.sqlite3"
# The spool is this host's backlog of undelivered evidence, shared by all its calls.
# The API accepts at most 5,000 events and 8 MiB of event bodies per call, so the
# defaults hold two such calls (the default call limit) through an API outage,
# with room for each event's encrypted replay credential.
DEFAULT_SPOOL_MAX_EVENTS = 10_000
DEFAULT_SPOOL_MAX_BYTES = 52_428_800
DEFAULT_CALL_LIMIT = 2
# The API's lease lasts 30 s, and it accepts evidence stamped at most 5 s after a
# lease ends. Renewing well inside that tolerance means a worker learns that the API
# ended its call before its own evidence would be refused.
API_LEASE_SECONDS = 30
EVIDENCE_TOLERANCE_SECONDS = 5


@dataclass(frozen=True)
class ReplayConfig:
    """Only what evidence recovery needs. It needs no call or provider secrets, and it
    keeps draining retained evidence while new calls are disabled."""

    internal_api_url: str
    replay_credential_key: str
    spool_path: Path
    spool_max_events: int
    spool_max_bytes: int

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "ReplayConfig":
        context = "the evidence replay companion runs"
        return cls(
            internal_api_url=_https_url(_required(env, "VOICE_INTERNAL_API_URL", context), "VOICE_INTERNAL_API_URL"),
            replay_credential_key=_required(env, "VOICE_REPLAY_CREDENTIAL_KEY", context),
            spool_path=Path(env.get("VOICE_SPOOL_PATH", DEFAULT_SPOOL_PATH)),
            spool_max_events=_positive_int(env, "VOICE_SPOOL_MAX_EVENTS", DEFAULT_SPOOL_MAX_EVENTS),
            spool_max_bytes=_positive_int(env, "VOICE_SPOOL_MAX_BYTES", DEFAULT_SPOOL_MAX_BYTES),
        )


@dataclass(frozen=True)
class RuntimeConfig:
    enabled: bool
    livekit_url: str | None
    livekit_api_key: str | None
    livekit_api_secret: str | None
    sarvam_api_key: str | None
    anthropic_api_key: str | None
    internal_api_url: str | None
    worker_credential: str | None
    replay_credential_key: str | None
    spool_path: Path
    spool_max_events: int
    spool_max_bytes: int
    call_limit: int
    drain_timeout_seconds: int
    lease_seconds: int
    lease_renew_seconds: int
    stt_mode: str
    agent_name: str

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "RuntimeConfig":
        enabled = env.get("VOICE_RUNTIME_ENABLED", "false").lower() == "true"
        spool_path = Path(env.get("VOICE_SPOOL_PATH", DEFAULT_SPOOL_PATH))
        base = cls(
            enabled=enabled,
            livekit_url=None,
            livekit_api_key=None,
            livekit_api_secret=None,
            sarvam_api_key=None,
            anthropic_api_key=None,
            internal_api_url=None,
            worker_credential=None,
            replay_credential_key=None,
            spool_path=spool_path,
            spool_max_events=_positive_int(env, "VOICE_SPOOL_MAX_EVENTS", DEFAULT_SPOOL_MAX_EVENTS),
            spool_max_bytes=_positive_int(env, "VOICE_SPOOL_MAX_BYTES", DEFAULT_SPOOL_MAX_BYTES),
            call_limit=_positive_int(env, "VOICE_CALL_LIMIT", DEFAULT_CALL_LIMIT),
            drain_timeout_seconds=_positive_int(env, "VOICE_DRAIN_TIMEOUT_SECONDS", 120),
            lease_seconds=_positive_int(env, "VOICE_LEASE_SECONDS", API_LEASE_SECONDS),
            lease_renew_seconds=_positive_int(env, "VOICE_LEASE_RENEW_SECONDS", 3),
            stt_mode=env.get("VOICE_STT_MODE", "disabled"),
            agent_name=env.get("VOICE_AGENT_NAME", "madhusudan-support-v1"),
        )
        if not enabled:
            return base
        if base.lease_seconds > API_LEASE_SECONDS:
            raise RuntimeDisabled(f"VOICE_LEASE_SECONDS cannot exceed the API's {API_LEASE_SECONDS} s lease")
        if base.lease_renew_seconds >= min(base.lease_seconds, EVIDENCE_TOLERANCE_SECONDS):
            raise RuntimeDisabled(f"VOICE_LEASE_RENEW_SECONDS must be below {EVIDENCE_TOLERANCE_SECONDS} s and the lease")
        if base.stt_mode != "realtime":
            raise RuntimeDisabled("VOICE_STT_MODE=realtime is required for the LiveKit call path")
        if base.agent_name != "madhusudan-support-v1":
            raise RuntimeDisabled("only the explicit madhusudan-support-v1 dispatch is supported")
        return cls(
            **{
                **base.__dict__,
                "livekit_url": _internal_livekit_url(_required(env, "LIVEKIT_URL")),
                "livekit_api_key": _required(env, "LIVEKIT_API_KEY"),
                "livekit_api_secret": _required(env, "LIVEKIT_API_SECRET"),
                "sarvam_api_key": _required(env, "SARVAM_API_KEY"),
                "anthropic_api_key": _required(env, "ANTHROPIC_API_KEY"),
                "internal_api_url": _https_url(
                    _required(env, "VOICE_INTERNAL_API_URL"), "VOICE_INTERNAL_API_URL"
                ),
                "worker_credential": _required(env, "VOICE_WORKER_CREDENTIAL"),
                "replay_credential_key": _required(env, "VOICE_REPLAY_CREDENTIAL_KEY"),
            }
        )

    def require_enabled(self) -> "RuntimeConfig":
        if not self.enabled:
            raise RuntimeDisabled("VOICE_RUNTIME_ENABLED is false; no worker will accept calls")
        return self
