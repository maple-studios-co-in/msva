"""LiveKit AgentServer entrypoint for the separately deployed MSVA voice worker."""

from __future__ import annotations

import json
import os
import asyncio
from collections.abc import Mapping

from livekit.agents import AgentServer, JobContext, JobRequest, cli
from livekit.agents.voice.room_io.types import RoomOptions

from .api import DispatchPending, ReplayDrainer, VoiceApiClient, VoiceApiError
from .config import RuntimeConfig, RuntimeDisabled
from .events import EventWriter
from .session import AgentSpeechObserver, LeaseGuard, MadhusudanAgent, TranscriptObserver, canonical_language, create_session
from .spool import EventSpool


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


def configure_livekit_environment(config: RuntimeConfig) -> None:
    config.require_enabled()
    # AgentServer reads these SDK-standard names. Values are only supplied by secret storage.
    os.environ["LIVEKIT_URL"] = str(config.livekit_url)
    os.environ["LIVEKIT_API_KEY"] = str(config.livekit_api_key)
    os.environ["LIVEKIT_API_SECRET"] = str(config.livekit_api_secret)


def build_server(config: RuntimeConfig) -> AgentServer:
    config.require_enabled()
    configure_livekit_environment(config)
    server = AgentServer(
        drain_timeout=config.drain_timeout_seconds,
        load_threshold=0.99,
        num_idle_processes=1,
    )
    server.load_fnc = lambda worker: min(len(worker.active_jobs) / config.call_limit, 1.0)

    async def on_request(request: JobRequest) -> None:
        # Explicit dispatch is the first admission gate. The MSVA API repeats room/dispatch
        # validation while claiming the lease before this job is allowed to speak or use tools.
        if request.agent_name != config.agent_name or request.room.name == "":
            await request.reject()
            return
        await request.accept(name="Madhusudan", identity=f"msva-agent-{request.id}")

    @server.rtc_session(agent_name=config.agent_name, on_request=on_request)
    async def run_call(ctx: JobContext) -> None:
        call_id = call_id_from_dispatch_metadata(ctx.job.metadata)
        room_name = ctx.job.room.name
        await ctx.connect()
        client = VoiceApiClient(str(config.internal_api_url), worker_credential=str(config.worker_credential))
        spool = EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes, replay_key=str(config.replay_credential_key))
        drainer = ReplayDrainer(client, spool)
        drainer.start()
        try:
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
            writer = EventWriter(spool, client, lease)
            await writer.emit("agent.ready", {"participantId": ctx.local_participant_identity})
            session = create_session(config, canonical_language(context.language))
            stopped = asyncio.Event()
            async def stop_speech() -> None:
                await session.interrupt(force=True)
                await session.aclose()
                stopped.set()

            guard = LeaseGuard(
                client, writer, renew_seconds=config.lease_renew_seconds, on_lost=stop_speech
            )
            guard.start()
            observer = TranscriptObserver(writer, context, on_failure=guard.fail_closed)
            agent_speech = AgentSpeechObserver(writer, canonical_language(context.language), on_failure=guard.fail_closed)
            session.on("user_input_transcribed", observer.handle)
            session.on("conversation_item_added", agent_speech.conversation)
            session.on("speech_created", agent_speech.speech)
            session.on("error", lambda *_: asyncio.create_task(guard.fail_closed(), name="voice-provider-fence"))
            session.on("close", lambda *_: stopped.set())
            try:
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
                await stopped.wait()
            finally:
                await guard.stop()
                await observer.drain(min(10, config.drain_timeout_seconds))
                await agent_speech.drain(min(10, config.drain_timeout_seconds))
                if guard.lost:
                    # The API may be unavailable; the event is persisted first and replayed later.
                    await writer.emit("agent.failed", {"code": "LEASE_RENEWAL_FAILED"})
                await writer.emit("agent.final_watermark", {"sourceSequence": writer.last_source_sequence})
        finally:
            try:
                await drainer.drain(min(10, config.drain_timeout_seconds))
            except (TimeoutError, VoiceApiError):
                pass
            await drainer.stop()
            spool.close()
            await client.aclose()

    return server


def run() -> None:
    config = RuntimeConfig.from_env(dict(os.environ))
    server = build_server(config)
    cli.run_app(server)


if __name__ == "__main__":
    run()
