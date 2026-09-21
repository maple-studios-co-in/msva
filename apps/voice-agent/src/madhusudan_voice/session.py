"""The one-AgentSession call path; it never uses the legacy chat streaming endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from livekit.agents import Agent, AgentSession, function_tool
from livekit.agents.voice import UserInputTranscribedEvent
from livekit.plugins import anthropic, sarvam

from .api import CallContext, Lease, VoiceApiClient
from .config import RuntimeConfig
from .events import EventWriter


class LeaseLost(RuntimeError):
    """A worker that cannot renew loses speech and tool authority immediately."""


class LeaseGuard:
    def __init__(
        self,
        client: VoiceApiClient,
        writer: EventWriter,
        *,
        renew_seconds: int,
        on_lost: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.client = client
        self.writer = writer
        self.renew_seconds = renew_seconds
        self.active = True
        self.lost = False
        self.on_lost = on_lost
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="voice-lease-renewal")

    async def stop(self) -> None:
        self.active = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def require_active(self) -> None:
        if not self.active:
            raise LeaseLost("lease renewal failed; business tools are disabled")

    async def _run(self) -> None:
        while self.active:
            await asyncio.sleep(self.renew_seconds)
            try:
                renewed = await self.client.renew(self.writer.lease)
            except Exception:
                self.active = False
                self.lost = True
                if self.on_lost is not None:
                    await self.on_lost()
                return
            self.writer.update_lease(renewed)


class MadhusudanAgent(Agent):
    def __init__(self, client: VoiceApiClient, lease_guard: LeaseGuard, context: CallContext) -> None:
        instructions = context.prompt or (
            "You are the Madhusudan support voice agent. Do not claim an action has completed "
            "unless the authorised tool records it."
        )
        super().__init__(instructions=instructions)
        self._client = client
        self._lease_guard = lease_guard
        self._context = context

    @function_tool(
        name="create_business_request",
        description="Record an approved support request. It does not place orders or promise callbacks.",
    )
    async def create_business_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Call the one initially permitted business effect through MSVA's lease boundary."""
        self._lease_guard.require_active()
        if "create_business_request" not in self._context.permitted_tools:
            raise LeaseLost("create_business_request is not permitted for this call")
        return await self._client.invoke_tool(
            self._lease_guard.writer.lease,
            invocation_id=str(uuid4()),
            name="create_business_request",
            arguments=request,
        )


class TranscriptObserver:
    """Admits only final caller text and gives revisions a stable per-session identity."""

    def __init__(self, writer: EventWriter, context: CallContext, on_failure: Callable[[], Awaitable[None]]) -> None:
        self.writer = writer
        self.context = context
        self.on_failure = on_failure
        self._generated_segments = 0
        self._sequence = 0
        self._texts: dict[str, str] = {}
        self._revisions: dict[str, int] = {}

    def handle(self, event: UserInputTranscribedEvent) -> None:
        if not event.is_final or not event.transcript.strip():
            return
        if event.speaker_id is not None and event.speaker_id != self.context.caller_participant_id:
            return
        segment_id = event.item_id
        if not segment_id:
            self._generated_segments += 1
            segment_id = f"worker:{self.writer.lease.agent_epoch}:{self._generated_segments}"
        if self._texts.get(segment_id) == event.transcript:
            return
        self._texts[segment_id] = event.transcript
        self._revisions[segment_id] = self._revisions.get(segment_id, 0) + 1
        self._sequence += 1
        asyncio.create_task(
            self._persist(event, segment_id, self._revisions[segment_id], self._sequence),
            name="voice-final-transcript",
        )

    async def _persist(
        self, event: UserInputTranscribedEvent, segment_id: str, revision: int, sequence: int
    ) -> None:
        try:
            await self.writer.emit_final_transcript(
                segment_id=segment_id,
                revision=revision,
                participant_id=self.context.caller_participant_id,
                sequence=sequence,
                text=event.transcript,
                language=str(event.language or self.context.language),
            )
        except Exception:
            # A failed final-evidence write makes further AI speech/business effects unsafe.
            await self.on_failure()


def create_session(config: RuntimeConfig) -> AgentSession:
    """Construct the SDK-supported Sarvam + Claude pipeline from a locked dependency set."""
    config.require_enabled()
    return AgentSession(
        stt=sarvam.STTRealtime(
            language="hi-IN",
            sample_rate=16000,
            api_key=config.sarvam_api_key,
        ),
        llm=anthropic.LLM(
            model="claude-sonnet-4-6",
            api_key=config.anthropic_api_key,
            max_tokens=512,
        ),
        tts=sarvam.TTS(
            target_language_code="hi-IN",
            model="bulbul:v3",
            speech_sample_rate=22050,
            api_key=config.sarvam_api_key,
        ),
    )
