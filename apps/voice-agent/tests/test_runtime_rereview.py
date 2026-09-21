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
from madhusudan_voice.spool import EventSpool, ToolIntentConflict

from fake_voice_api import lease_expiring_in, wait_until

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
        lease = lease_expiring_in(0.03)
        failures: list[str] = []
        def record_failure(self, code):
            self.failures.append(code)
    fenced: list[str] = []
    writer = Writer()
    guard = LeaseGuard(SlowApi(), writer, renew_seconds=1, lease_seconds=30, on_lost=fenced.append)
    assert guard.start()
    await wait_until(lambda: bool(fenced), timeout=0.2)
    assert guard.lost and not guard.active
    assert fenced == ["LEASE_LOST"] and writer.failures == ["LEASE_LOST"]
    await guard.stop()


def test_identity_and_language_are_deterministic_and_canonical():
    assert agent_identity_for_call("call-id") == "msva-agent-" + "1bcdd84406e7812328f6049db1cd8459"
    assert canonical_language("hinglish") == "hinglish"
    assert canonical_language("hi-en") == "hinglish"
    assert canonical_language("en-US") == "en"


def test_logical_tool_identity_reuses_receipt_but_not_identical_new_command(tmp_path: Path):
    spool = EventSpool(tmp_path / "spool.db", max_events=10, max_bytes=100_000, replay_key=KEY)
    first, receipt = spool.tool_intent(call_id="call", agent_epoch=1, logical_id="sdk-call-1", name="create_business_request", arguments={"description": "same"})
    assert receipt is None
    spool.complete_tool_intent(first, {"status": "committed"})
    same, receipt = spool.tool_intent(call_id="call", agent_epoch=1, logical_id="sdk-call-1", name="create_business_request", arguments={"description": "same"})
    other, _ = spool.tool_intent(call_id="call", agent_epoch=1, logical_id="sdk-call-2", name="create_business_request", arguments={"description": "same"})
    assert same == first and receipt == {"status": "committed"}
    assert other != first
    with pytest.raises(ToolIntentConflict):
        spool.tool_intent(call_id="call", agent_epoch=1, logical_id="sdk-call-1", name="create_business_request", arguments={"description": "changed"})
