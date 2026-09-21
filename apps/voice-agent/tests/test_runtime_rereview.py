import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from madhusudan_voice.api import Lease, VoiceApiClient
from madhusudan_voice.events import EventWriter
from madhusudan_voice.main import agent_identity_for_call
from madhusudan_voice.session import LeaseGuard, canonical_language
from madhusudan_voice.spool import EventSpool

KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="


@pytest.mark.asyncio
async def test_ready_final_and_flush_replay_in_order_with_original_token(tmp_path: Path):
    sent: list[tuple[str, int, str]] = []
    def handler(request: httpx.Request) -> httpx.Response:
        event = json.loads(request.content)
        sent.append((event["type"], event["sourceSequence"], request.headers["authorization"]))
        return httpx.Response(200, json={"eventId": event["eventId"], "status": "committed"})
    spool = EventSpool(tmp_path / "spool.db", max_events=10, max_bytes=100_000, replay_key=KEY)
    api = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    writer = EventWriter(spool, api, Lease("call", 1, "2030-01-01T00:00:00Z", "historic"), agent_participant_id="agent")
    await writer.emit("agent.ready", {"participantId": "agent"})
    await writer.emit_final_transcript(segment_id="caller-1", revision=1, participant_id="caller", sequence=1, text="hello", language="en")
    await writer.emit("transcript.flushed", {"lastSourceSequence": writer.last_source_sequence})
    assert await api.flush_spool(spool) == 3
    assert sent == [("agent.ready", 1, "Bearer historic"), ("transcript.final", 2, "Bearer historic"), ("transcript.flushed", 3, "Bearer historic")]


@pytest.mark.asyncio
async def test_expiry_fences_while_renewal_is_hung(tmp_path: Path):
    class SlowApi:
        async def renew(self, lease):
            await asyncio.sleep(1)
            return lease
    class Writer:
        lease = Lease("call", 1, (datetime.now(UTC) + timedelta(milliseconds=30)).isoformat(), "token")
    fenced = asyncio.Event()
    guard = LeaseGuard(SlowApi(), Writer(), renew_seconds=1, on_lost=lambda: _set(fenced))
    guard.start()
    await asyncio.wait_for(fenced.wait(), timeout=0.2)
    assert guard.lost and not guard.active
    await guard.stop()


async def _set(event: asyncio.Event) -> None:
    event.set()


def test_identity_and_language_are_deterministic_and_canonical():
    assert agent_identity_for_call("call-id") == "msva-agent-" + "1bcdd84406e7812328f6049db1cd8459"
    assert canonical_language("hinglish") == "hinglish"
    assert canonical_language("hi-en") == "hinglish"
    assert canonical_language("en-US") == "en"
