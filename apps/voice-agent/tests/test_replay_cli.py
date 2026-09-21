"""The replay companion's command line: clearing stopped streams and its healthcheck."""

import os
import time

import pytest

from madhusudan_voice import replay
from madhusudan_voice.config import ReplayConfig
from madhusudan_voice.spool import EventSpool, ReplayCredential

from fake_voice_api import BASE, KEY


@pytest.fixture
def replay_env(tmp_path, monkeypatch):
    env = {"VOICE_INTERNAL_API_URL": BASE, "VOICE_REPLAY_CREDENTIAL_KEY": KEY, "VOICE_SPOOL_PATH": str(tmp_path / "spool.sqlite3")}
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return ReplayConfig.from_env(env)


def test_clear_faults_restarts_a_stopped_stream(replay_env, capsys):
    spool = replay.open_spool(replay_env)
    spool.enqueue(event_id="ready", call_id="call-1", payload={"eventId": "ready", "sourceSequence": 1},
        credential=ReplayCredential("call-1", 1, "lease-token", "2030-01-01T00:00:00Z"))
    spool.fault_stream("call-1", 1, "HTTP_401:LEASE_INVALID")
    spool.close()
    replay.main(["clear-faults", "call-1"])
    assert capsys.readouterr().out.strip() == "cleared 1 stopped events"
    reopened = EventSpool(replay_env.spool_path, max_events=10, max_bytes=100_000, replay_key=KEY)
    assert reopened.stream_fault("call-1", 1) is None


def test_the_healthcheck_passes_only_while_delivery_passes_complete(replay_env):
    assert replay.healthcheck() is False, "no pass has completed yet"
    replay.heartbeat_path(replay_env).touch()
    assert replay.healthcheck() is True
    assert replay.healthcheck(now=time.time() + replay.HEARTBEAT_MAX_AGE_SECONDS + 1) is False
    with pytest.raises(SystemExit) as exited:
        replay.main(["healthcheck"])
    assert exited.value.code == 0
    os.utime(replay.heartbeat_path(replay_env), (0, 0))
    with pytest.raises(SystemExit) as exited:
        replay.main(["healthcheck"])
    assert exited.value.code == 1


def test_an_unknown_command_prints_the_usage(replay_env):
    with pytest.raises(SystemExit, match="usage"):
        replay.main(["drain-now"])
