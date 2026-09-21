import json

import httpx
import pytest

from madhusudan_voice.api import DispatchPending, Lease, VoiceApiClient, VoiceApiError
from madhusudan_voice.events import EventWriter
from madhusudan_voice.spool import EventSpool, ReplayCredential

KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="


@pytest.mark.asyncio
async def test_claim_context_and_event_use_separate_scoped_credentials(tmp_path):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/leases/claim"):
            return httpx.Response(200, json={"callId": "call-1", "agentEpoch": 4, "expiresAt": "2030-01-01T00:00:00Z", "token": "lease-token"})
        if request.url.path.endswith("/context"):
            return httpx.Response(200, json={"callId": "call-1", "roomName": "room-1", "agentEpoch": 4, "callerParticipantId": "caller-1", "agentParticipantId": "agent-1", "language": "hi", "permittedTools": ["create_business_request"], "prompt": "brief"})
        if request.url.path.endswith("/events"):
            return httpx.Response(200, json={"eventId": "event-1", "status": "committed"})
        return httpx.Response(404)

    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker-token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    lease = await client.claim_lease(call_id="call-1", room_name="room-1", dispatch_id="madhusudan-support-v1", participant_id="agent-1")
    context = await client.context(lease)
    receipt = await client.publish({"eventId": "event-1"}, lease)

    assert context.permitted_tools == ("create_business_request",)
    assert receipt == "committed"
    assert requests[0].headers["authorization"] == "Bearer worker-token"
    assert requests[1].headers["authorization"] == "Bearer lease-token"
    assert requests[2].headers["authorization"] == "Bearer lease-token"


@pytest.mark.asyncio
async def test_flush_retains_event_when_api_is_unavailable(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096, replay_key=KEY)
    spool.enqueue(event_id="event-1", call_id="call-1", payload={"eventId": "event-1", "type": "transcript.final"}, credential=ReplayCredential("call-1", 1, "lease", "2030-01-01T00:00:00Z"), now=0)
    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(503))))
    lease = Lease("call-1", 1, "2030-01-01T00:00:00Z", "lease")

    assert await client.flush_spool(spool) == 0
    assert spool.pending_count() == 1


@pytest.mark.asyncio
async def test_receipt_mismatch_is_rejected():
    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"eventId": "other", "status": "committed"}))))
    lease = Lease("call-1", 1, "2030-01-01T00:00:00Z", "lease")

    with pytest.raises(VoiceApiError, match="receipt"):
        await client.publish({"eventId": "event-1"}, lease)


@pytest.mark.asyncio
async def test_final_caller_transcript_is_spooled_before_acknowledgement(tmp_path):
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"eventId": sent[-1]["eventId"], "status": "committed"})

    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=2, max_bytes=4096, replay_key=KEY)
    writer = EventWriter(spool, client, Lease("call-1", 2, "2030-01-01T00:00:00Z", "lease"))

    await writer.emit_final_transcript(segment_id="segment-1", revision=1, participant_id="caller-1", sequence=1, text="Mujhe madad chahiye", language="hinglish")

    assert spool.pending_count() == 1
    assert await client.flush_spool(spool) == 1
    assert sent[0]["type"] == "transcript.final"
    assert sent[0]["sourceSequence"] == 1
    assert sent[0]["payload"]["speaker"] == "CALLER"


@pytest.mark.asyncio
async def test_replay_after_restart_uses_its_historical_lease_and_only_transcript(tmp_path):
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=3, max_bytes=4096, replay_key=KEY)
    credential = ReplayCredential("call-1", 9, "old-lease", "2030-01-01T00:00:00Z")
    spool.enqueue(event_id="final", call_id="call-1", payload={"eventId": "final", "type": "transcript.final"}, credential=credential)
    spool.enqueue(event_id="ready", call_id="call-1", payload={"eventId": "ready", "type": "agent.ready"}, credential=credential)
    seen: list[str] = []
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        body = json.loads(request.content)
        return httpx.Response(200, json={"eventId": body["eventId"], "status": "committed"})
    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await client.flush_spool(spool) == 1
    assert seen == ["Bearer old-lease"]
    assert spool.pending_count() == 1


@pytest.mark.asyncio
async def test_only_explicit_dispatch_pending_is_classified_for_retry():
    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(503, json={"error": "DISPATCH_PENDING"}))))
    with pytest.raises(DispatchPending):
        await client.claim_lease(call_id="call-1", room_name="room", dispatch_id="provider-dispatch", participant_id="agent")


@pytest.mark.asyncio
async def test_lost_tool_response_reads_receipt_without_reissuing_effect():
    requests: list[httpx.Request] = []
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            raise httpx.ReadTimeout("lost response")
        return httpx.Response(200, json={"invocationId": "intent-1", "status": "committed"})
    client = VoiceApiClient("https://api.example/api/internal/voice/v1", worker_credential="worker", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    result = await client.invoke_tool(Lease("call-1", 1, "2030-01-01T00:00:00Z", "lease"), invocation_id="intent-1", name="create_business_request", arguments={})
    assert result["status"] == "committed"
    assert [request.method for request in requests] == ["POST", "GET"]
