"""Host companion for durable evidence replay while no LiveKit job is active."""

from __future__ import annotations

import asyncio
import os

from .api import ReplayDrainer, VoiceApiClient
from .config import RuntimeConfig
from .spool import EventSpool


async def run_replay() -> None:
    config = RuntimeConfig.from_env(dict(os.environ)).require_enabled()
    spool = EventSpool(config.spool_path, max_events=config.spool_max_events,
        max_bytes=config.spool_max_bytes, replay_key=str(config.replay_credential_key))
    client = VoiceApiClient(str(config.internal_api_url), worker_credential=str(config.worker_credential))
    drainer = ReplayDrainer(client, spool)
    drainer.start()
    try:
        await asyncio.Event().wait()
    finally:
        await drainer.stop()
        spool.close()
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(run_replay())
