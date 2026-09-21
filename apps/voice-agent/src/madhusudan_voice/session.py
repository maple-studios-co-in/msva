"""The one-AgentSession call path; it never uses the legacy chat streaming endpoint."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from typing import Any, Literal

from livekit.agents import Agent, AgentSession, ModelSettings, function_tool, llm
from livekit.agents.llm import ToolError
from livekit.agents.voice import ConversationItemAddedEvent, RunContext, SpeechCreatedEvent, UserInputTranscribedEvent
from livekit.plugins import anthropic, sarvam

from .api import AUTHORITY_CODES, AuthorityLost, CallContext, ToolRejected, VoiceApiClient, VoiceApiError
from .config import EVIDENCE_STALL_SECONDS, RuntimeConfig
from .events import EventWriter
from .request_tool_schema import TOOL_PARAMETERS
from .spool import ToolIntentConflict

logger = logging.getLogger(__name__)

MAX_TRANSCRIPT_CHARS = 4000
FailureCode = Literal["CONFIGURATION", "TRANSIENT", "FATAL", "LEASE_LOST"]


class LeaseLost(RuntimeError):
    """A worker that cannot renew loses speech and tool authority immediately."""


class LeaseGuard:
    """Holds speech and tool authority only while the lease is certainly valid.

    The deadline runs on the monotonic clock from when the claim or renewal request
    was sent, so wall-clock skew cannot stretch it, and it never exceeds the configured
    lease length whatever expiry the server reports. When authority ends the guard
    records why at that moment and fences synchronously: it never waits for the
    session to close, because it may be running inside a tool the close waits for.
    """

    def __init__(
        self,
        client: VoiceApiClient,
        writer: EventWriter,
        *,
        renew_seconds: float,
        lease_seconds: float,
        on_lost: Callable[[FailureCode], None] | None = None,
        retry_seconds: float = 2.0,
        stall_seconds: float = EVIDENCE_STALL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.writer = writer
        self.renew_seconds = renew_seconds
        self.lease_seconds = lease_seconds
        self.retry_seconds = retry_seconds
        self.stall_seconds = stall_seconds
        self.on_lost = on_lost
        self._clock = clock
        self.active = False
        self.lost = False
        self.failure: FailureCode | None = None
        self._deadline = writer.lease.local_deadline(lease_seconds)
        # Renewed this long before the deadline at the latest, so a short lease (a
        # re-claim can return one) is renewed before it lapses.
        self._margin = min(2.0, lease_seconds / 10)
        # The API's unreachable time so far (while the last renewal had failed), sampled on
        # every renewal pass. A stall is the oldest undelivered event's wait minus the part
        # of it the API was unreachable: during an outage the lease itself ends authority,
        # and a stream that falls behind cannot hide it by delivering a little at a time.
        self._unreachable = 0.0
        self._samples: deque[tuple[float, float]] = deque([(clock(), 0.0)])
        self._renewal_ok = True
        self._checked_at = clock()
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def remaining(self) -> float:
        return max(0.0, self._deadline - self._clock())

    def start(self) -> bool:
        """Begins renewing; a lease that has already lapsed never grants authority."""
        if self.remaining <= 0:
            self.fail_closed("LEASE_LOST")
            return False
        self.active = True
        self._tasks = [
            asyncio.create_task(self._renew(), name="voice-lease-renewal"),
            asyncio.create_task(self._watch_deadline(), name="voice-lease-expiry"),
        ]
        return True

    def require_active(self) -> None:
        if not self.active or self.remaining <= 0:
            raise LeaseLost("lease renewal failed; business tools are disabled")

    def fail_closed(self, code: FailureCode = "LEASE_LOST", *, record: bool = True) -> None:
        """Ends authority now. Idempotent, never raises and never awaits. `record=False`
        skips the failure event when it could not be accepted anyway: the API already
        withdrew authority, or the stream no longer delivers."""
        if self.lost:
            return
        self.active = False
        self.lost = True
        self.failure = code
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        for task in self._tasks:
            if task is not current:
                task.cancel()
        if record:
            try:
                self.writer.record_failure(code)
            except Exception as error:  # noqa: BLE001 - the fence below must still run
                logger.warning("voice failure evidence was not recorded: %s", type(error).__name__)
        if self.on_lost is not None:
            try:
                self.on_lost(code)
            except Exception as error:  # noqa: BLE001 - authority is already withdrawn
                logger.warning("voice fence callback failed: %s", type(error).__name__)

    async def stop(self) -> None:
        """Stops renewing at the end of a call without reporting a failure."""
        self.active = False
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current:
                task.cancel()
        for task in self._tasks:
            if task is not current:
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001 - stopping is best effort
                    pass

    async def _watch_deadline(self) -> None:
        while not self.lost:
            remaining = self.remaining
            if remaining <= 0:
                self.fail_closed("LEASE_LOST")
                return
            # A renewal may have moved the deadline; look again when this one passes.
            await asyncio.sleep(remaining)

    def _evidence_state(self) -> tuple[str | None, float]:
        """Why the call's evidence stream stopped, if it did, and how long its oldest
        undelivered event has waited."""
        lease = self.writer.lease
        try:
            spool = self.writer.spool
            return spool.stream_fault(lease.call_id, lease.agent_epoch), spool.waiting_seconds(lease.call_id, lease.agent_epoch)
        except Exception as error:  # noqa: BLE001 - an unreadable spool also fails the next append
            logger.warning("voice evidence stream state was not read: %s", type(error).__name__)
            return None, 0.0

    def _unreachable_within(self, seconds: float, now: float) -> float:
        """How much of the last `seconds` the API was unreachable."""
        since, earlier = now - seconds, self._samples[0][1]
        for at, total in self._samples:
            if at > since:
                break
            earlier = total
        return self._unreachable - earlier

    async def _renew(self) -> None:
        delay = max(0.0, min(self.renew_seconds, self.remaining - self._margin))
        while not self.lost:
            await asyncio.sleep(delay)
            if self.lost or self.remaining <= 0:
                return
            # Evidence the API refused for good leaves every later event undeliverable, and
            # evidence that stops moving leaves the API blind to the call: either way the
            # call cannot go on as if it were being recorded.
            fault, waiting = self._evidence_state()
            if fault is not None:
                logger.warning("voice evidence stream stopped (%s); ending AI authority", fault)
                self.fail_closed("FATAL", record=False)
                return
            now = self._clock()
            if not self._renewal_ok:
                self._unreachable += now - self._checked_at
            self._checked_at = now
            self._samples.append((now, self._unreachable))
            # A wait longer than ten minutes ended authority long before; older samples are not needed.
            while len(self._samples) > 2 and self._samples[1][0] <= now - 600:
                self._samples.popleft()
            if waiting - self._unreachable_within(waiting, now) > self.stall_seconds:
                logger.warning("voice evidence has waited %.0f s for delivery; ending AI authority", waiting)
                self.fail_closed("FATAL")
                return
            try:
                async with asyncio.timeout(self.remaining):
                    renewed = await self.client.renew(self.writer.lease)
            except VoiceApiError as error:
                if error.status == 401 or error.code in AUTHORITY_CODES:
                    # The API already withdrew authority (ended, expired, taken over or
                    # disabled) and would refuse a failure stamped after its cutoff.
                    self.fail_closed("LEASE_LOST", record=False)
                    return
                if error.permanent:
                    self.fail_closed("LEASE_LOST")
                    return
                self._renewal_ok = False
                delay = min(self.retry_seconds, self.remaining)
                continue
            except TimeoutError:
                self._renewal_ok = False
                continue
            except Exception:  # noqa: BLE001 - an unreadable reply is retried; the deadline still fences
                self._renewal_ok = False
                delay = min(self.retry_seconds, self.remaining)
                continue
            self._renewal_ok = True
            self.writer.update_lease(renewed)
            self._deadline = renewed.local_deadline(self.lease_seconds)
            delay = max(0.0, min(self.renew_seconds, self.remaining - self._margin))


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

    async def llm_node(self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings) -> AsyncIterator[Any]:
        """Generates nothing once authority has ended. The SDK schedules a reply after every
        tool call, so silence after a fence must not depend on the session closing first."""
        if not self._lease_guard.active:
            return
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if not self._lease_guard.active:
                return
            yield chunk

    @function_tool(raw_schema={
        "name": "create_business_request",
        "description": "Record an approved support request for staff follow-up. It does not place orders or promise callbacks.",
        # The request contract itself, so the model can form a request the API accepts.
        "parameters": TOOL_PARAMETERS,
    })
    async def create_business_request(self, raw_arguments: dict[str, object], ctx: RunContext) -> dict[str, Any]:
        """Call the one initially permitted business effect through MSVA's lease boundary."""
        guard = self._lease_guard
        try:
            guard.require_active()
        except LeaseLost as error:
            raise ToolError("The request cannot be recorded on this call.") from error
        request = raw_arguments.get("request")
        if not isinstance(request, dict):
            raise ToolError("The request needs its journey, confirmation, fields and queue; check them with the caller.")
        if "create_business_request" not in self._context.permitted_tools:
            raise ToolError("Recording requests is not permitted on this call.")
        try:
            invocation_id, committed = self._client.record_tool_intent(
                guard.writer.spool,
                guard.writer.lease,
                logical_id=ctx.function_call.call_id,
                name="create_business_request",
                arguments=request,
            )
        except ToolIntentConflict as error:
            raise ToolError("That request conflicts with one already made; ask the caller to confirm the details.") from error
        except Exception as error:
            # Without a durable intent a later retry could duplicate the effect.
            guard.fail_closed("FATAL")
            raise ToolError("The request cannot be recorded on this call.") from error
        guard.writer.tool_intents.add(invocation_id)
        if committed is not None:
            return committed
        try:
            result = await self._client.invoke_tool(
                guard.writer.lease, invocation_id=invocation_id,
                name="create_business_request", arguments=request,
            )
        except ToolRejected as error:
            if error.code == "TOOL_LIMIT":
                raise ToolError("No more requests can be recorded on this call; staff will follow up on the ones already recorded.") from error
            # Refused before any business effect; the model may correct and retry.
            raise ToolError(f"The request was not recorded ({error.code or 'rejected'}); check the details with the caller.") from error
        except AuthorityLost as error:
            guard.fail_closed("LEASE_LOST")
            raise ToolError("The request cannot be recorded on this call.") from error
        except Exception as error:
            # A lost response may already have committed. Fence all further effects until
            # staff reconcile this intent; never issue a second request for it.
            guard.fail_closed("TRANSIENT")
            raise ToolError("The request's status is unknown; staff will follow up.") from error
        try:
            guard.writer.spool.complete_tool_intent(invocation_id, result)
        except Exception as error:  # noqa: BLE001 - a retry reuses the invocation ID and gets this receipt
            logger.warning("voice tool receipt was not stored locally: %s", type(error).__name__)
        return result


class TranscriptObserver:
    """Admits only final caller text and gives revisions a stable per-session identity."""

    def __init__(self, writer: EventWriter, context: CallContext, on_failure: Callable[[], None]) -> None:
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
                text=event.transcript.strip()[:MAX_TRANSCRIPT_CHARS],
                language=canonical_language(str(event.language or self.context.language)),
            )
        except Exception:
            # A failed final-evidence write makes further AI speech/business effects unsafe.
            self.on_failure()


class AgentSpeechObserver:
    """Records assistant text only after its corresponding LiveKit speech playout completes."""

    def __init__(self, writer: EventWriter, language: str, on_failure: Callable[[], None]) -> None:
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
                text = (getattr(item, "raw_text_content", None) or "").strip()
                if text:
                    await self.writer.emit_agent_transcript(
                        text=text[:MAX_TRANSCRIPT_CHARS], language=self.language, segment_id=str(getattr(item, "id", "agent-item")), sequence=0
                    )
        except Exception:
            self.on_failure()

    async def drain(self, timeout_seconds: float) -> None:
        if self._tasks:
            async with asyncio.timeout(timeout_seconds):
                await asyncio.gather(*self._tasks)


def canonical_language(value: str) -> str:
    normalized = value.lower().replace("_", "-")
    if normalized in {"hinglish", "hi-en", "en-hi"}:
        return "hinglish"
    if normalized.startswith("hi"):
        return "hi"
    if normalized.startswith("en"):
        return "en"
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
