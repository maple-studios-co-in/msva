import pytest

from madhusudan_voice.spool import EventSpool, ReplayCredential, SpoolCapacityError

KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
LEASE = ReplayCredential("call-1", 1, "historical-token", "2030-01-01T00:00:00Z")


def event(event_id: str = "event-1") -> dict:
    return {"schemaVersion": 1, "eventId": event_id, "callId": "call-1", "type": "agent.ready"}


def test_spool_survives_restart_and_deletes_only_after_ack(tmp_path):
    path = tmp_path / "spool.sqlite3"
    spool = EventSpool(path, max_events=2, max_bytes=4096, replay_key=KEY)
    assert spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), credential=LEASE, now=10) is True
    spool.close()

    reopened = EventSpool(path, max_events=2, max_bytes=4096, replay_key=KEY)
    queued = reopened.ready(now=10)
    assert [item.event_id for item in queued] == ["event-1"]
    reopened.acknowledge("event-1")
    assert reopened.pending_count() == 0


def test_spool_rejects_different_body_for_duplicate_event_id(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096, replay_key=KEY)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), credential=LEASE)

    with pytest.raises(ValueError, match="different payload"):
        spool.enqueue(event_id="event-1", call_id="call-1", payload={**event(), "type": "agent.failed"}, credential=LEASE)


def test_spool_capacity_stops_new_evidence(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=1, max_bytes=4096, replay_key=KEY)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), credential=LEASE)

    with pytest.raises(SpoolCapacityError):
        spool.enqueue(event_id="event-2", call_id="call-1", payload=event("event-2"), credential=LEASE)


def test_retry_uses_bounded_backoff(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096, replay_key=KEY)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), credential=LEASE, now=10)
    spool.retry("event-1", now=10)

    assert spool.ready(now=11) == []
    assert [item.event_id for item in spool.ready(now=12)] == ["event-1"]


def test_sequences_and_encrypted_replay_credential_survive_restart(tmp_path):
    path = tmp_path / "spool.sqlite3"
    spool = EventSpool(path, max_events=2, max_bytes=4096, replay_key=KEY)
    assert spool.next_sequence(call_id="call-1", agent_epoch=3) == 1
    assert spool.next_sequence(call_id="call-1", agent_epoch=3) == 2
    spool.enqueue(event_id="event-1", call_id="call-1", payload={**event(), "type": "transcript.final"}, credential=ReplayCredential("call-1", 3, "historical-lease", "2030-01-01T00:00:00Z"))
    assert b"historical-lease" not in path.read_bytes()
    spool.close()
    reopened = EventSpool(path, max_events=2, max_bytes=4096, replay_key=KEY)
    queued = reopened.ready()[0]
    assert queued.credential.token == "historical-lease"
    assert queued.credential.agent_epoch == 3
    assert reopened.next_sequence(call_id="call-1", agent_epoch=3) == 3
