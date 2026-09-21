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


def test_retries_follow_how_long_a_credential_has_been_expired(tmp_path):
    from datetime import UTC, datetime

    from madhusudan_voice.spool import LIVE_RETRY_SECONDS

    now = time.time()
    stamp = lambda seconds: datetime.fromtimestamp(now + seconds, UTC).isoformat()
    spool = spool_at(tmp_path)
    for call_id, expires_at in (("call-live", stamp(60)), ("call-recent", stamp(-10)), ("call-old", "2020-01-01T00:00:00Z")):
        spool.enqueue(event_id=f"{call_id}-1", call_id=call_id, payload={"eventId": f"{call_id}-1", "sourceSequence": 1, "type": "agent.ready"},
            credential=ReplayCredential(call_id, 1, f"token-{call_id}", expires_at))
        for _ in range(6):
            spool.retry(f"{call_id}-1", now=now)
    due = dict(spool._connection.execute("SELECT event_id, next_attempt_at FROM event_spool").fetchall())
    # A live call is retried every couple of seconds; evidence caught in an outage waits
    # about as long as its credential has been expired, however many attempts it had.
    assert due["call-live-1"] == now + LIVE_RETRY_SECONDS
    assert due["call-recent-1"] == now + 10
    assert due["call-old-1"] == now + 300


@pytest.mark.asyncio
async def test_a_new_stream_goes_out_in_the_first_round_whatever_the_backlog(tmp_path):
    spool = spool_at(tmp_path, max_events=1_000)
    for index in range(150):
        queue(spool, f"call-old{index}", 1, now=float(index))
        queue(spool, f"call-old{index}", 2, now=float(1_000 + index))
    queue(spool, "call-new", 1, now=5_000.0)
    sent: list[str] = []
    assert await api_answering({}, sent).flush_spool(spool) == 301
    assert sent.index("call-new-1") < 151, "every stream's head goes out in the first round"


@pytest.mark.asyncio
async def test_streams_are_delivered_several_at_a_time(tmp_path):
    spool = spool_at(tmp_path)
    for index in range(8):
        queue(spool, f"call-{index}", 1)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.2)
        return httpx.Response(200, json={"eventId": json.loads(request.content)["eventId"], "status": "committed"})

    client = VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(slow)))
    started = time.monotonic()
    assert await client.flush_spool(spool) == 8
    # One at a time this would take 1.6 s.
    assert time.monotonic() - started < 1.0
    await client.aclose()


@pytest.mark.asyncio
async def test_every_delivery_round_is_reported(tmp_path):
    spool = spool_at(tmp_path)
    for sequence in range(1, 4):
        queue(spool, "call-a", sequence)
    rounds: list[int] = []
    assert await api_answering({}, []).flush_spool(spool, on_round=lambda: rounds.append(1)) == 3
    assert len(rounds) == 3


@pytest.mark.asyncio
async def test_the_companion_beats_during_a_long_delivery_pass(tmp_path):
    spool = spool_at(tmp_path)
    for sequence in range(1, 6):
        queue(spool, "call-a", sequence)
    sent: list[str] = []

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.15)
        event_id = json.loads(request.content)["eventId"]
        sent.append(event_id)
        return httpx.Response(200, json={"eventId": event_id, "status": "committed"})

    heartbeat = tmp_path / "replay.heartbeat"
    drainer = ReplayDrainer(VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(slow))), spool, interval_seconds=0.01, heartbeat=heartbeat)
    drainer.start()
    await wait_until(lambda: len(sent) >= 2)
    assert heartbeat.exists() and len(sent) < 5, "each round, not only the whole pass, refreshes the heartbeat"
    await drainer.stop()


def test_an_unreadable_credential_stops_its_whole_stream_and_stays_stopped(tmp_path):
    from cryptography.fernet import Fernet

    path = tmp_path / "spool.sqlite3"
    spool = spool_at(tmp_path)
    for sequence in range(1, 4):
        queue(spool, "call-a", sequence)
    with spool._write() as db:
        db.execute("UPDATE event_spool SET encrypted_token=?", (Fernet(Fernet.generate_key()).encrypt(b"token"),))
    assert spool.ready() == []
    assert spool._connection.execute("SELECT COUNT(*) FROM event_spool WHERE fault='CREDENTIAL_UNREADABLE'").fetchone() == (3,)
    spool.close()
    # The spool still opens with that stream set aside, and clearing faults cannot bring
    # back a stream no configured key can read.
    reopened = EventSpool(path, max_events=100, max_bytes=1_000_000, replay_key=KEY)
    assert reopened.clear_faults() == 0
    reopened.close()
    EventSpool(path, max_events=100, max_bytes=1_000_000, replay_key=KEY).close()
