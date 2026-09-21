"""Which refusals stop an evidence stream, the replay key, and restarting stopped streams."""

import httpx
import pytest
from cryptography.fernet import Fernet

from madhusudan_voice.api import VoiceApiClient
from madhusudan_voice.spool import EventSpool, ReplayCredential, SpoolKeyMismatch

from fake_voice_api import BASE, KEY

OTHER_KEY = Fernet.generate_key().decode()
CREDENTIAL = ReplayCredential("call-1", 1, "lease-token", "2030-01-01T00:00:00Z")


def spool_at(path, key: str = KEY) -> EventSpool:
    return EventSpool(path, max_events=20_000, max_bytes=50_000_000, replay_key=key)


def queue(spool: EventSpool, event_id: str, sequence: int, event_type: str = "agent.ready") -> None:
    spool.enqueue(event_id=event_id, call_id="call-1", payload={"eventId": event_id, "sourceSequence": sequence, "type": event_type}, credential=CREDENTIAL, now=0)


def client_answering(response: httpx.Response) -> VoiceApiClient:
    return VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: response)))


@pytest.mark.asyncio
async def test_a_refusal_the_api_does_not_name_is_retried_without_stopping_the_stream(tmp_path):
    # A misrouted URL answers with an HTML 404: it says nothing about the event.
    spool = spool_at(tmp_path / "spool.sqlite3")
    queue(spool, "ready", 1)
    client = client_answering(httpx.Response(404, text="<html>Cannot POST</html>", headers={"content-type": "text/html"}))
    assert await client.flush_spool(spool) == 0
    assert spool.stream_fault("call-1", 1) is None
    assert spool.pending("call-1", 1) == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_a_refusal_the_api_names_stops_the_stream(tmp_path):
    spool = spool_at(tmp_path / "spool.sqlite3")
    queue(spool, "ready", 1)
    client = client_answering(httpx.Response(409, json={"error": "EVENT_TIME_INVALID"}))
    assert await client.flush_spool(spool) == 0
    assert spool.stream_fault("call-1", 1) == "HTTP_409:EVENT_TIME_INVALID"
    await client.aclose()


def test_a_key_that_cannot_read_the_spool_is_refused_and_its_evidence_kept(tmp_path):
    path = tmp_path / "spool.sqlite3"
    spool = spool_at(path)
    queue(spool, "ready", 1)
    spool.close()
    with pytest.raises(SpoolKeyMismatch):
        spool_at(path, OTHER_KEY)
    reopened = spool_at(path)
    assert [event.event_id for event in reopened.ready(now=10)] == ["ready"]
    assert reopened.stream_fault("call-1", 1) is None


def test_the_replay_key_rotates(tmp_path):
    path = tmp_path / "spool.sqlite3"
    old = spool_at(path)
    queue(old, "ready", 1)
    old.close()
    # New key first: it encrypts; the old one still reads what it wrote.
    rotating = spool_at(path, f"{OTHER_KEY},{KEY}")
    queue(rotating, "final", 2, "transcript.final")
    assert [event.event_id for event in rotating.ready(now=10)] == ["ready"]
    rotating.acknowledge("ready")
    rotating.close()
    # Once the old key's events are gone, the old key can go too.
    rotated = spool_at(path, OTHER_KEY)
    assert [event.event_id for event in rotated.ready(now=10)] == ["final"]


def test_a_stopped_stream_is_delivered_again_once_cleared(tmp_path):
    spool = spool_at(tmp_path / "spool.sqlite3")
    queue(spool, "ready", 1)
    # As an earlier version stopped streams on a misrouted URL's HTML 404.
    spool.fault_stream("call-1", 1, "HTTP_404:UNKNOWN")
    assert spool.ready(now=10) == []
    assert spool.clear_faults("call-1", now=10) == 1
    assert [event.event_id for event in spool.ready(now=10)] == ["ready"]
