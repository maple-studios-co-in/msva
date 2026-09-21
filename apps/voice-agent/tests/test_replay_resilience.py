import asyncio
import gzip
import json
import time

import httpx
import pytest

from madhusudan_voice.api import ReplayDrainer, VoiceApiClient, VoiceApiError
from madhusudan_voice.config import ReplayConfig, RuntimeDisabled
from madhusudan_voice.spool import EventSpool, ReplayCredential, SpoolCapacityError

from fake_voice_api import BASE, KEY, wait_until


def spool_at(tmp_path, **caps) -> EventSpool:
    return EventSpool(tmp_path / "spool.sqlite3", max_events=caps.get("max_events", 100), max_bytes=caps.get("max_bytes", 1_000_000), replay_key=KEY)


def queue(spool: EventSpool, call_id: str, sequence: int, *, now: float | None = None) -> str:
    event_id = f"{call_id}-{sequence}"
    spool.enqueue(event_id=event_id, call_id=call_id, payload={"eventId": event_id, "sourceSequence": sequence, "type": "agent.ready"},
        credential=ReplayCredential(call_id, 1, f"token-{call_id}", "2030-01-01T00:00:00Z"), now=now)
    return event_id


def api_answering(status_for: dict[str, int], sent: list[str]) -> VoiceApiClient:
    def handler(request: httpx.Request) -> httpx.Response:
        event = json.loads(request.content)
        sent.append(event["eventId"])
        status = status_for.get(event["eventId"], 200)
        if status != 200:
            return httpx.Response(status, json={"error": "SEQUENCE_OUT_OF_ORDER"})
        return httpx.Response(200, json={"eventId": event["eventId"], "status": "committed"})
    return VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.mark.asyncio
async def test_a_refused_event_stops_only_its_own_stream(tmp_path):
    spool = spool_at(tmp_path)
    queue(spool, "call-a", 1); queue(spool, "call-a", 2)
    queue(spool, "call-b", 1); queue(spool, "call-b", 2)
    sent: list[str] = []
    client = api_answering({"call-a-1": 409}, sent)
    assert await client.flush_spool(spool) == 2
    # Call A's refused head is never retried and its later event never jumps it.
    assert await client.flush_spool(spool) == 0
    assert sent == ["call-a-1", "call-b-1", "call-b-2"]
    faults = spool._connection.execute("SELECT event_id, fault FROM event_spool ORDER BY event_id").fetchall()
    assert faults == [("call-a-1", "HTTP_409:SEQUENCE_OUT_OF_ORDER"), ("call-a-2", "HTTP_409:SEQUENCE_OUT_OF_ORDER")]


@pytest.mark.asyncio
async def test_an_unavailable_api_retries_later_without_faulting(tmp_path):
    spool = spool_at(tmp_path)
    queue(spool, "call-a", 1)
    sent: list[str] = []
    assert await api_answering({"call-a-1": 503}, sent).flush_spool(spool) == 0
    assert spool._connection.execute("SELECT attempts, fault FROM event_spool").fetchone() == (1, None)


@pytest.mark.asyncio
async def test_an_unreadable_credential_stops_only_its_own_stream(tmp_path):
    spool = spool_at(tmp_path)
    queue(spool, "call-a", 1)
    queue(spool, "call-b", 1)
    with spool._write() as db:
        db.execute("UPDATE event_spool SET encrypted_token=? WHERE call_id='call-a'", (b"not-a-fernet-token",))
    sent: list[str] = []
    assert await api_answering({}, sent).flush_spool(spool) == 1
    assert sent == ["call-b-1"]
    assert spool._connection.execute("SELECT fault FROM event_spool WHERE call_id='call-a'").fetchone() == ("CREDENTIAL_UNREADABLE",)


@pytest.mark.asyncio
async def test_the_replay_loop_survives_a_failing_pass_and_stops_cleanly(tmp_path):
    spool = spool_at(tmp_path)
    queue(spool, "call-a", 1)
    sent: list[str] = []
    client = api_answering({}, sent)
    passes = 0
    real_ready = spool.ready

    def flaky_ready(**kwargs):
        nonlocal passes
        passes += 1
        if passes == 1:
            raise RuntimeError("database is locked")
        return real_ready(**kwargs)

    spool.ready = flaky_ready
    heartbeat = tmp_path / "replay.heartbeat"
    drainer = ReplayDrainer(client, spool, interval_seconds=0.01, heartbeat=heartbeat)
    drainer.start()
    await wait_until(lambda: sent == ["call-a-1"])
    # Only completed passes beat, and each one does.
    await wait_until(heartbeat.exists)
    beat = heartbeat.stat().st_mtime_ns
    await wait_until(lambda: heartbeat.stat().st_mtime_ns > beat)
    await drainer.stop()
    assert spool.pending_count() == 0


def test_pruning_bounds_every_table_but_keeps_live_numbering(tmp_path):
    spool = spool_at(tmp_path)
    old = time.time() - 30 * 3600
    queue(spool, "call-old", 1, now=old)
    with spool._write() as db:
        db.execute("INSERT INTO tool_intent(call_id,agent_epoch,logical_id,name,arguments,invocation_id,state,created_at) VALUES ('call-old',1,'l','n','{}','i','PENDING',?)", (old,))
        db.execute("INSERT INTO source_sequence(call_id,agent_epoch,next_value,updated_at) VALUES ('call-old',1,2,?)", (old,))
        db.execute("INSERT INTO source_sequence(call_id,agent_epoch,next_value,updated_at) VALUES ('call-live',1,5,?)", (old,))
    queue(spool, "call-live", 4)
    removed = spool.prune()
    assert removed["unrecoverable"] == 1 and removed["tool_intents"] == 1 and removed["sequences"] == 1
    remaining = spool._connection.execute("SELECT call_id FROM source_sequence").fetchall()
    assert remaining == [("call-live",)], "a stream with pending events keeps its numbering"


def test_capacity_counts_the_retained_credential(tmp_path):
    # The ~60-byte payload fits alone; with its ~120-byte encrypted credential it does not.
    spool = spool_at(tmp_path, max_bytes=150)
    with pytest.raises(SpoolCapacityError):
        queue(spool, "call-a", 1)


@pytest.mark.asyncio
async def test_an_encoded_response_is_refused_before_it_is_expanded():
    body = gzip.compress(json.dumps({"eventId": "e", "status": "committed", "pad": "x" * 1_000_000}).encode())
    client = VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=body, headers={"content-encoding": "gzip"}))))
    with pytest.raises(VoiceApiError, match="encoded"):
        await client.publish({"eventId": "e"}, type("L", (), {"call_id": "c", "token": "t"})())


def test_replay_needs_only_the_api_url_and_spool_key(tmp_path):
    config = ReplayConfig.from_env({"VOICE_INTERNAL_API_URL": BASE, "VOICE_REPLAY_CREDENTIAL_KEY": KEY, "VOICE_SPOOL_PATH": str(tmp_path / "s.db")})
    assert config.internal_api_url == BASE
    with pytest.raises(RuntimeDisabled):
        ReplayConfig.from_env({"VOICE_REPLAY_CREDENTIAL_KEY": KEY})


@pytest.mark.asyncio
async def test_one_streams_backlog_does_not_hold_up_another(tmp_path):
    spool = spool_at(tmp_path)
    for sequence in range(1, 51):
        queue(spool, "call-a", sequence, now=float(sequence))
    queue(spool, "call-b", 1, now=100.0)
    sent: list[str] = []
    assert await api_answering({}, sent).flush_spool(spool) == 51
    assert sent.index("call-b-1") == 1, "every stream's head goes out in each round"
    assert [event for event in sent if event.startswith("call-a")] == [f"call-a-{n}" for n in range(1, 51)]


@pytest.mark.asyncio
async def test_a_companion_whose_passes_fail_stops_beating(tmp_path):
    spool = spool_at(tmp_path)

    def broken_ready(**kwargs):
        raise RuntimeError("database is locked")

    spool.ready = broken_ready
    heartbeat = tmp_path / "replay.heartbeat"
    drainer = ReplayDrainer(api_answering({}, []), spool, interval_seconds=0.01, heartbeat=heartbeat)
    drainer.start()
    await asyncio.sleep(0.1)
    await drainer.stop()
    assert not heartbeat.exists()
