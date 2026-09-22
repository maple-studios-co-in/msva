import asyncio
from types import SimpleNamespace

import pytest
from livekit.agents.voice import UserInputTranscribedEvent

from madhusudan_voice.api import CallContext
from madhusudan_voice.session import TranscriptObserver


class Recorder:
    lease = SimpleNamespace(agent_epoch=7)

    def __init__(self):
        self.calls = []

    async def emit_final_transcript(self, **kwargs):
        self.calls.append(kwargs)


@pytest.mark.asyncio
async def test_observer_persists_final_caller_only_and_revisions_item_ids():
    writer = Recorder()
    context = CallContext("call-1", "room-1", 7, "caller-1", "agent-1", "hi", (), "")
    observer = TranscriptObserver(writer, context, on_failure=lambda: asyncio.sleep(0))

    observer.handle(UserInputTranscribedEvent(transcript="draft", is_final=False, item_id="segment-1"))
    # Provider speaker labels are not participant identities. The session's RoomOptions
    # pins audio to caller-1, so this observer must not make an authorization decision.
    observer.handle(UserInputTranscribedEvent(transcript="accepted", is_final=True, speaker_id="agent-1"))
    observer.handle(UserInputTranscribedEvent(transcript="first", is_final=True, item_id="segment-1", speaker_id="caller-1"))
    observer.handle(UserInputTranscribedEvent(transcript="corrected", is_final=True, item_id="segment-1", speaker_id="caller-1"))
    await asyncio.sleep(0)

    assert [(call["text"], call["revision"], call["sequence"]) for call in writer.calls] == [
        ("accepted", 1, 1),
        ("first", 1, 2),
        ("corrected", 2, 3),
    ]
