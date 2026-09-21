"""The one-AgentSession call path; it never uses the legacy chat streaming endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from datetime import UTC, datetime

from livekit.agents import Agent, AgentSession, function_tool
from livekit.agents.voice import ConversationItemAddedEvent, SpeechCreatedEvent, UserInputTranscribedEvent
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
        self._expiry_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if datetime.now(UTC) >= self._expiry():
            self.active = False
            self.lost = True
            return
        self._task = asyncio.create_task(self._run(), name="voice-lease-renewal")
        self._arm_expiry()

    def _expiry(self) -> datetime:
        return datetime.fromisoformat(self.writer.lease.expires_at.replace("Z", "+00:00"))

    def _arm_expiry(self) -> None:
        if self._expiry_task:
            self._expiry_task.cancel()
        self._expiry_task = asyncio.create_task(self._expire_at_deadline(), name="voice-lease-expiry")

    async def _expire_at_deadline(self) -> None:
        await asyncio.sleep(max(0, (self._expiry() - datetime.now(UTC)).total_seconds()))
        await self.fail_closed()

    async def stop(self) -> None:
        self.active = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._expiry_task:
            self._expiry_task.cancel()

    def require_active(self) -> None:
        expires_at = self._expiry()
        if not self.active or datetime.now(UTC) >= expires_at:
            raise LeaseLost("lease renewal failed; business tools are disabled")

    async def fail_closed(self) -> None:
        if self.lost:
            return
        self.active = False
        self.lost = True
        if self.on_lost is not None:
            await self.on_lost()

    async def _run(self) -> None:
        while self.active:
            expires_at = self._expiry()
            wait = min(self.renew_seconds, max(0, (expires_at - datetime.now(UTC)).total_seconds()))
            if wait == 0:
                await self.fail_closed()
                return
            await asyncio.sleep(wait)
            try:
                async with asyncio.timeout(max(0.001, (expires_at - datetime.now(UTC)).total_seconds())):
                    renewed = await self.client.renew(self.writer.lease)
            except Exception:
                await self.fail_closed()
                return
            self.writer.update_lease(renewed)
            self._arm_expiry()


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
        invocation_id = self._client.record_tool_intent(
            self._lease_guard.writer.spool,
            self._lease_guard.writer.lease,
            name="create_business_request",
            arguments=request,
        )
        try:
            result = await self._client.invoke_tool(
                self._lease_guard.writer.lease, invocation_id=invocation_id,
                name="create_business_request", arguments=request,
            )
            self._lease_guard.writer.spool.complete_tool_intent(invocation_id, result)
            return result
        except Exception:
            # A lost write may already have committed. The pilot fences all further effects
            # until a human or a future safe receipt reconciliation resolves this intent.
            await self._lease_guard.fail_closed()
            raise


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
        self._tasks: set[asyncio.Task[None]] = set()

    def handle(self, event: UserInputTranscribedEvent) -> None:
        if not event.is_final or not event.transcript.strip():
            return
        # speaker_id is provider diarization, not a LiveKit participant identity. RoomOptions
        # pins audio input to the caller; never use provider speaker labels as authorization.
        segment_id = event.item_id
        if not segment_id:
            self._generated_segments += 1
            segment_id = f"worker:{self.writer.lease.agent_epoch}:{self._generated_segments}"
        if self._texts.get(segment_id) == event.transcript:
            return
        self._texts[segment_id] = event.transcript
        self._revisions[segment_id] = self._revisions.get(segment_id, 0) + 1
        self._sequence += 1
        task = asyncio.create_task(
            self._persist(event, segment_id, self._revisions[segment_id], self._sequence),
            name="voice-final-transcript",
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self, timeout_seconds: float) -> None:
        if self._tasks:
            async with asyncio.timeout(timeout_seconds):
                await asyncio.gather(*self._tasks)

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


class AgentSpeechObserver:
    """Records assistant text only after its corresponding LiveKit speech playout completes."""

    def __init__(self, writer: EventWriter, language: str, on_failure: Callable[[], Awaitable[None]]) -> None:
        self.writer, self.language, self.on_failure = writer, language, on_failure
        self._tasks: set[asyncio.Task[None]] = set()

    def conversation(self, event: ConversationItemAddedEvent) -> None:
        # Items are read from the speech handle at completion, which associates them
        # with actual playout instead of a global conversation queue.
        return None

    def speech(self, event: SpeechCreatedEvent) -> None:
        task = asyncio.create_task(self._after_playout(event), name="voice-agent-playout-evidence")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _after_playout(self, event: SpeechCreatedEvent) -> None:
        try:
            await event.speech_handle.wait_for_playout()
            for item in event.speech_handle.chat_items:
                if getattr(item, "role", None) != "assistant":
                    continue
                text = getattr(item, "raw_text_content", None)
                if text:
                    await self.writer.emit_agent_transcript(
                        text=text, language=self.language, segment_id=str(getattr(item, "id", "agent-item")), sequence=0
                    )
        except Exception:
            await self.on_failure()

    async def drain(self, timeout_seconds: float) -> None:
        if self._tasks:
            async with asyncio.timeout(timeout_seconds):
                await asyncio.gather(*self._tasks)


def canonical_language(value: str) -> str:
    normalized = value.lower().replace("_", "-")
    if normalized.startswith("hi"):
        return "hi"
    if normalized.startswith("en"):
        return "en"
    if normalized in {"hinglish", "hi-en", "en-hi"}:
        return "hinglish"
    return "unknown"


def create_session(config: RuntimeConfig, language: str) -> AgentSession:
    """Construct the SDK-supported Sarvam + Claude pipeline from a locked dependency set."""
    config.require_enabled()
    return AgentSession(
        stt=sarvam.STTRealtime(
            language="hi-IN" if canonical_language(language) in {"hi", "hinglish"} else "en-IN",
            sample_rate=16000,
            api_key=config.sarvam_api_key,
        ),
        llm=anthropic.LLM(
            model="claude-sonnet-4-6",
            api_key=config.anthropic_api_key,
            max_tokens=512,
        ),
        tts=sarvam.TTS(
            target_language_code="hi-IN" if canonical_language(language) in {"hi", "hinglish"} else "en-IN",
            model="bulbul:v3",
            speech_sample_rate=22050,
            api_key=config.sarvam_api_key,
        ),
    )
