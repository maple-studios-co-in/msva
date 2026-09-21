"""Host companion for durable evidence replay while no LiveKit job is active."""

from __future__ import annotations

import asyncio
import logging
import os

from .api import ReplayDrainer, VoiceApiClient
from .config import ReplayConfig
from .spool import EventSpool


async def run_replay() -> None:
    # Only retained per-event lease credentials are used; no worker or provider secret.
    config = ReplayConfig.from_env(dict(os.environ))
    spool = EventSpool(config.spool_path, max_events=config.spool_max_events,
        max_bytes=config.spool_max_bytes, replay_key=config.replay_credential_key)
    client = VoiceApiClient(config.internal_api_url)
    drainer = ReplayDrainer(client, spool)
    drainer.start()
    try:
        await asyncio.Event().wait()
    finally:
        await drainer.stop()
        spool.close()
        await client.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_replay())
