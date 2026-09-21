"""Which refusals stop an evidence stream, and restarting stopped streams."""

import httpx
import pytest

from madhusudan_voice.api import VoiceApiClient
from madhusudan_voice.spool import EventSpool, ReplayCredential

from fake_voice_api import BASE, KEY

CREDENTIAL = ReplayCredential("call-1", 1, "lease-token", "2030-01-01T00:00:00Z")


def spool_at(path) -> EventSpool:
    return EventSpool(path, max_events=20_000, max_bytes=50_000_000, replay_key=KEY)


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


def test_a_stopped_stream_is_delivered_again_once_cleared(tmp_path):
    spool = spool_at(tmp_path / "spool.sqlite3")
    queue(spool, "ready", 1)
    # As an earlier version stopped streams on a misrouted URL's HTML 404.
    spool.fault_stream("call-1", 1, "HTTP_404:UNKNOWN")
    assert spool.ready(now=10) == []
    assert spool.clear_faults("call-1", now=10) == 1
    assert [event.event_id for event in spool.ready(now=10)] == ["ready"]
