"""LiveKit AgentServer entrypoint for the separately deployed MSVA voice worker."""

from __future__ import annotations

import json
import logging
import os
import asyncio
import hashlib
from collections.abc import Mapping
from dataclasses import dataclass

from livekit.agents import AgentServer, AgentSession, JobContext, JobRequest, cli
from livekit.agents.voice.room_io.types import RoomOptions

from .api import DispatchPending, ReplayDrainer, VoiceApiClient, VoiceApiError
from .config import RuntimeConfig, RuntimeDisabled
from .events import EventWriter
from .session import AgentSpeechObserver, FailureCode, LeaseGuard, MadhusudanAgent, TranscriptObserver, canonical_language, create_session
from .spool import EventSpool

logger = logging.getLogger(__name__)


def call_id_from_dispatch_metadata(metadata: str) -> str:
    """Only accept the opaque call ID created by MSVA while making the dispatch request."""
    try:
        value = json.loads(metadata)
    except json.JSONDecodeError as exc:
        raise RuntimeDisabled("dispatch metadata must be server-created JSON") from exc
    if not isinstance(value, Mapping) or set(value) != {"callId"} or not isinstance(value["callId"], str):
        raise RuntimeDisabled("dispatch metadata must contain only a non-empty callId")
    if not value["callId"].strip():
        raise RuntimeDisabled("dispatch metadata callId cannot be empty")
    return value["callId"]


def agent_identity_for_call(call_id: str) -> str:
    return "msva-agent-" + hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:32]


def configure_livekit_environment(config: RuntimeConfig) -> None:
    config.require_enabled()
    # AgentServer reads these SDK-standard names. Values are only supplied by secret storage.
    os.environ["LIVEKIT_URL"] = str(config.livekit_url)
    os.environ["LIVEKIT_API_KEY"] = str(config.livekit_api_key)
    os.environ["LIVEKIT_API_SECRET"] = str(config.livekit_api_secret)


@dataclass
class CallRuntime:
    """Everything one call owns. It exists before the first await, so every exit path
    (success, early failure or shutdown) finalizes the same resources exactly once."""

    client: VoiceApiClient
    spool: EventSpool
    drainer: ReplayDrainer
    writer: EventWriter | None = None
    guard: LeaseGuard | None = None
    observer: TranscriptObserver | None = None
    agent_speech: AgentSpeechObserver | None = None
    finalized: bool = False

    def fail(self, code: FailureCode) -> None:
        """Records a failure that happens now; after ready it is always evidence."""
        if self.guard is not None:
            self.guard.fail_closed(code)
        elif self.writer is not None:
            try:
                self.writer.record_failure(code)
            except Exception as error:  # noqa: BLE001 - finalization still runs
                logger.warning("voice failure evidence was not recorded: %s", type(error).__name__)

    async def finalize(self, budget_seconds: float) -> None:
        """One bounded budget: final SDK evidence, the checkpoint, delivery, then close."""
        if self.finalized:
            return
        self.finalized = True
        try:
            async with asyncio.timeout(min(10, budget_seconds)):
                if self.guard is not None:
                    await self.guard.stop()
                if self.observer is not None:
                    await self.observer.drain(min(10, budget_seconds))
                if self.agent_speech is not None:
                    await self.agent_speech.drain(min(10, budget_seconds))
                if self.writer is not None:
                    self.writer.record_flush()
                await self.drainer.drain(min(10, budget_seconds))
        except (TimeoutError, VoiceApiError):
            pass
        except Exception as error:  # noqa: BLE001 - closing below must still happen
            logger.warning("voice call finalization failed: %s", type(error).__name__)
        finally:
            await self.drainer.stop()
            self.spool.close()
            await self.client.aclose()


def build_server(config: RuntimeConfig) -> AgentServer:
    config.require_enabled()
    configure_livekit_environment(config)
    server = AgentServer(
        drain_timeout=config.drain_timeout_seconds,
        load_threshold=0.99,
        num_idle_processes=1,
    )
    server.load_fnc = lambda worker: min(len(worker.active_jobs) / config.call_limit, 1.0)
    runtimes: dict[str, CallRuntime] = {}

    async def finalize_runtime(ctx: JobContext) -> None:
        # AgentServer invokes this only after AgentSession.aclose, so final SDK callbacks
        # have already run; the flush checkpoint covers everything persisted.
        runtime = runtimes.pop(ctx.job.id, None)
        if runtime is not None:
            await runtime.finalize(config.drain_timeout_seconds)

    async def on_request(request: JobRequest) -> None:
        # Explicit dispatch is the first admission gate. The MSVA API repeats room/dispatch
        # validation while claiming the lease before this job is allowed to speak or use tools.
        if request.agent_name != config.agent_name or request.room.name == "":
            await request.reject()
            return
        try:
            call_id = call_id_from_dispatch_metadata(request.job.metadata)
        except RuntimeDisabled:
            await request.reject()
            return
        await request.accept(name="Madhusudan", identity=agent_identity_for_call(call_id))

    @server.rtc_session(agent_name=config.agent_name, on_request=on_request, on_session_end=finalize_runtime)
    async def run_call(ctx: JobContext) -> None:
        call_id = call_id_from_dispatch_metadata(ctx.job.metadata)
        room_name = ctx.job.room.name
        client = VoiceApiClient(str(config.internal_api_url), worker_credential=str(config.worker_credential))
        try:
            spool = EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes, replay_key=str(config.replay_credential_key))
        except Exception:
            await client.aclose()
            raise
        runtime = CallRuntime(client, spool, ReplayDrainer(client, spool))
        runtimes[ctx.job.id] = runtime
        session: AgentSession | None = None

        def fence(code: FailureCode) -> None:
            # Never awaits: closing from inside a running tool would wait for that tool.
            # Ending the job runs finalization promptly instead of when the room closes.
            if session is not None:
                session.shutdown(drain=False)
            ctx.shutdown(reason=f"voice authority ended: {code}")

        runtime.drainer.start()
        try:
            await ctx.connect()
            # Dispatch persistence can lag LiveKit's accepted job. Retry only the explicit,
            # non-authorising DISPATCH_PENDING 503; mismatches remain terminal.
            for attempt in range(4):
                try:
                    lease = await client.claim_lease(call_id=call_id, room_name=room_name,
                        dispatch_id=ctx.job.dispatch_id, participant_id=ctx.local_participant_identity)
                    break
                except DispatchPending:
                    if attempt == 3:
                        raise
                    await asyncio.sleep(0.25 * (attempt + 1))
            context = await client.context(lease)
            if context.room_name != room_name or context.agent_participant_id != ctx.local_participant_identity:
                raise RuntimeDisabled("MSVA context does not match the dispatched LiveKit participant")
            writer = EventWriter(spool, client, lease, agent_participant_id=context.agent_participant_id)
            runtime.writer = writer
            writer.append("agent.ready", {"participantId": ctx.local_participant_identity})
            guard = LeaseGuard(client, writer, renew_seconds=config.lease_renew_seconds, lease_seconds=config.lease_seconds, on_lost=fence)
            runtime.guard = guard
            if not guard.start():
                # The claim had already lapsed: never start a speaking session.
                runtimes.pop(ctx.job.id, None)
                await runtime.finalize(config.drain_timeout_seconds)
                return
            session = create_session(config, canonical_language(context.language))
            observer = TranscriptObserver(writer, context, on_failure=lambda: guard.fail_closed("FATAL"))
            agent_speech = AgentSpeechObserver(writer, canonical_language(context.language), on_failure=lambda: guard.fail_closed("FATAL"))
            runtime.observer, runtime.agent_speech = observer, agent_speech
            session.on("user_input_transcribed", observer.handle)
            session.on("conversation_item_added", agent_speech.conversation)
            session.on("speech_created", agent_speech.speech)
            # Recoverable provider errors are retried by the SDK; only a lost pipeline ends authority.
            session.on("error", lambda event: None if getattr(event.error, "recoverable", False) else guard.fail_closed("TRANSIENT"))
            session.on("close", lambda _event: ctx.shutdown(reason="voice session closed"))
            await session.start(
                    room=ctx.room,
                    agent=MadhusudanAgent(client, guard, context),
                    room_options=RoomOptions(
                        participant_identity=context.caller_participant_id,
                        text_input=False,
                        close_on_disconnect=True,
                    ),
                    record=False,
                )
            if guard.lost:
                # Authority ended while starting, before the session could be closed.
                session.shutdown(drain=False)
            # Return after start. Session termination triggers the supported on_session_end
            # callback after SDK aclose, avoiding the framework's 15-second entrypoint wait.
            return
        except Exception:
            runtime.fail("FATAL")
            runtimes.pop(ctx.job.id, None)
            await runtime.finalize(config.drain_timeout_seconds)
            raise

    return server


def run() -> None:
    config = RuntimeConfig.from_env(dict(os.environ))
    server = build_server(config)
    # Opening the spool once proves the replay key can read it, so a wrong key stops the
    # worker here instead of failing every call it accepts.
    EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes,
        replay_key=str(config.replay_credential_key)).close()
    cli.run_app(server)


if __name__ == "__main__":
    run()
