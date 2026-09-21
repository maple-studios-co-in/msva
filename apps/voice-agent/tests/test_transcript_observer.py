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
    observer.handle(UserInputTranscribedEvent(transcript="ignored", is_final=True, speaker_id="agent-1"))
    observer.handle(UserInputTranscribedEvent(transcript="first", is_final=True, item_id="segment-1", speaker_id="caller-1"))
    observer.handle(UserInputTranscribedEvent(transcript="corrected", is_final=True, item_id="segment-1", speaker_id="caller-1"))
    await asyncio.sleep(0)

    assert [(call["text"], call["revision"], call["sequence"]) for call in writer.calls] == [
        ("first", 1, 1),
        ("corrected", 2, 2),
    ]
