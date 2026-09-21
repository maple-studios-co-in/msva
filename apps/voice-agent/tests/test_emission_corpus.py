"""The shared voice-v1 replay corpus is also fed through the mounted API's HTTP test, so
emitting exactly its shapes links what this worker sends to what the API accepts."""

import json
from pathlib import Path

import httpx
import pytest

from madhusudan_voice.api import VoiceApiClient
from madhusudan_voice.events import EventWriter
from madhusudan_voice.session import TranscriptObserver
from madhusudan_voice.spool import EventSpool

from fake_voice_api import BASE, KEY, lease_expiring_in

CORPUS = Path(__file__).parent / "fixtures" / "voice-v1-replay-corpus.json"


def shape(event: dict) -> tuple:
    return (event["type"], tuple(sorted(event)), tuple(sorted(event["payload"])))


@pytest.mark.asyncio
async def test_the_worker_emits_exactly_the_shared_corpus_shapes(tmp_path):
    corpus = json.loads(CORPUS.read_text())
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=10, max_bytes=100_000, replay_key=KEY)
    client = VoiceApiClient(BASE, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))))
    writer = EventWriter(spool, client, lease_expiring_in(30, call_id="call-fixture-1"), agent_participant_id="msva-agent-fixture")
    context = type("Context", (), {"caller_participant_id": "caller-fixture", "language": "en"})()
    observer = TranscriptObserver(writer, context, on_failure=lambda: None)
    # The same statements a live call runs: ready, a caller final from the SDK event, then the checkpoint.
    writer.append("agent.ready", {"participantId": "msva-agent-fixture"})
    from livekit.agents.voice import UserInputTranscribedEvent
    observer.handle(UserInputTranscribedEvent(transcript="hello", is_final=True, item_id="caller-1", speaker_id="spk", language="en-IN"))
    await observer.drain(5)
    writer.record_flush()
    emitted = [json.loads(row[0]) for row in spool._connection.execute("SELECT payload FROM event_spool ORDER BY created_at").fetchall()]
    assert [shape(event) for event in emitted] == [shape(event) for event in corpus]
    for mine, theirs in zip(emitted, corpus):
        assert mine["sourceSequence"] == theirs["sourceSequence"]
        assert mine["payload"].keys() == theirs["payload"].keys()
    final = emitted[1]["payload"]
    assert final["language"] == "en", "provider language tags are normalized"
    assert emitted[2]["payload"] == {"lastSourceSequence": 2}
