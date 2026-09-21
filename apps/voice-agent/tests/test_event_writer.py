"""The event writer's checkpoints."""

import pytest

from madhusudan_voice.api import Lease, VoiceApiClient
from madhusudan_voice.events import EventWriter
from madhusudan_voice.spool import EventSpool, SpoolCapacityError

from fake_voice_api import BASE, KEY


def test_no_checkpoint_follows_evidence_that_was_lost(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=50_000, replay_key=KEY)
    client = VoiceApiClient(BASE, worker_credential="worker")
    writer = EventWriter(spool, client, Lease("call-1", 1, "2030-01-01T00:00:00Z", "lease-token"))
    writer.append("agent.ready", {"participantId": "agent"})
    writer.append("agent.failed", {"code": "TRANSIENT"})
    with pytest.raises(SpoolCapacityError):
        writer.append("transcript.final", {"text": "the caller's words"})
    # The API would take a checkpoint over this prefix for a complete transcript.
    assert writer.record_flush() is None
