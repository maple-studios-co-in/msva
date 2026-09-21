import pytest

from madhusudan_voice.spool import EventSpool, SpoolCapacityError


def event(event_id: str = "event-1") -> dict:
    return {"schemaVersion": 1, "eventId": event_id, "callId": "call-1", "type": "agent.ready"}


def test_spool_survives_restart_and_deletes_only_after_ack(tmp_path):
    path = tmp_path / "spool.sqlite3"
    spool = EventSpool(path, max_events=2, max_bytes=4096)
    assert spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), now=10) is True
    spool.close()

    reopened = EventSpool(path, max_events=2, max_bytes=4096)
    queued = reopened.ready(now=10)
    assert [item.event_id for item in queued] == ["event-1"]
    reopened.acknowledge("event-1")
    assert reopened.pending_count() == 0


def test_spool_rejects_different_body_for_duplicate_event_id(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event())

    with pytest.raises(ValueError, match="different payload"):
        spool.enqueue(event_id="event-1", call_id="call-1", payload={**event(), "type": "agent.failed"})


def test_spool_capacity_stops_new_evidence(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=1, max_bytes=4096)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event())

    with pytest.raises(SpoolCapacityError):
        spool.enqueue(event_id="event-2", call_id="call-1", payload=event("event-2"))


def test_retry_uses_bounded_backoff(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096)
    spool.enqueue(event_id="event-1", call_id="call-1", payload=event(), now=10)
    spool.retry("event-1", now=10)

    assert spool.ready(now=11) == []
    assert [item.event_id for item in spool.ready(now=12)] == ["event-1"]
