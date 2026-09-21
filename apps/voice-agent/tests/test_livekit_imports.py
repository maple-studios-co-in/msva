import pytest


def test_locked_livekit_runtime_imports():
    from livekit.agents import Agent, AgentServer, AgentSession, JobContext
    from livekit.plugins import anthropic, sarvam
    from madhusudan_voice.main import build_server, call_id_from_dispatch_metadata
    from madhusudan_voice.session import MadhusudanAgent, create_session

    assert Agent is not None
    assert AgentServer is not None
    assert AgentSession is not None
    assert JobContext is not None
    assert anthropic.LLM is not None
    assert sarvam.STTRealtime is not None
    assert sarvam.TTS is not None
    assert MadhusudanAgent is not None
    assert create_session is not None
    assert build_server is not None


def test_dispatch_metadata_has_no_room_derived_call_identifier():
    from madhusudan_voice.main import call_id_from_dispatch_metadata

    assert call_id_from_dispatch_metadata('{"callId":"call-server-created"}') == "call-server-created"


@pytest.mark.asyncio
async def test_locked_runtime_constructs_the_supported_agent_server_and_session(tmp_path):
    from madhusudan_voice.config import RuntimeConfig
    from madhusudan_voice.main import build_server
    from madhusudan_voice.session import create_session

    config = RuntimeConfig.from_env(
        {
            "VOICE_RUNTIME_ENABLED": "true",
            "VOICE_STT_MODE": "realtime",
            "LIVEKIT_URL": "ws://livekit.example:7880",
            "LIVEKIT_API_KEY": "key",
            "LIVEKIT_API_SECRET": "secret",
            "SARVAM_API_KEY": "sarvam",
            "ANTHROPIC_API_KEY": "anthropic",
            "VOICE_INTERNAL_API_URL": "https://api.example/api/internal/voice/v1",
            "VOICE_WORKER_CREDENTIAL": "worker-token",
            "VOICE_SPOOL_PATH": str(tmp_path / "spool.sqlite3"),
        }
    )

    assert build_server(config) is not None
    session = create_session(config)
    assert session is not None
    await session.aclose()
