"""LiveKit AgentServer entrypoint for the separately deployed MSVA voice worker."""

from __future__ import annotations

import json
import os
import asyncio
from collections.abc import Mapping

from livekit.agents import AgentServer, JobContext, JobRequest, cli

from .api import VoiceApiClient
from .config import RuntimeConfig, RuntimeDisabled
from .events import EventWriter
from .session import LeaseGuard, MadhusudanAgent, TranscriptObserver, create_session
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
        spool = EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes)
        try:
            lease = await client.claim_lease(
                call_id=call_id,
                room_name=room_name,
                dispatch_id=config.dispatch_id,
                participant_id=ctx.local_participant_identity,
            )
            context = await client.context(lease)
            if context.room_name != room_name or context.agent_participant_id != ctx.local_participant_identity:
                raise RuntimeDisabled("MSVA context does not match the dispatched LiveKit participant")
            writer = EventWriter(spool, client, lease)
            await writer.emit("agent.ready", {"participantId": ctx.local_participant_identity})
            session = create_session(config)
            async def stop_speech() -> None:
                await session.interrupt(force=True)

            guard = LeaseGuard(
                client, writer, renew_seconds=config.lease_renew_seconds, on_lost=stop_speech
            )
            stopped = asyncio.Event()

            async def on_shutdown(_: str) -> None:
                stopped.set()

            ctx.add_shutdown_callback(on_shutdown)
            guard.start()
            observer = TranscriptObserver(writer, context, on_failure=stop_speech)
            session.on("user_input_transcribed", observer.handle)
            try:
                await session.start(
                    room=ctx.room,
                    agent=MadhusudanAgent(client, guard, context),
                    record=False,
                )
                await stopped.wait()
            finally:
                await guard.stop()
                if guard.lost:
                    # The API may be unavailable; the event is persisted first and replayed later.
                    await writer.emit("agent.failed", {"code": "LEASE_RENEWAL_FAILED"})
        finally:
            spool.close()
            await client.aclose()

    return server


def run() -> None:
    config = RuntimeConfig.from_env(dict(os.environ))
    server = build_server(config)
    cli.run_app(server)


if __name__ == "__main__":
    run()
