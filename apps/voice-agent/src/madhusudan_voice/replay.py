"""Host companion for durable evidence replay while no LiveKit job is active.

    python -m madhusudan_voice.replay                        run the companion
    python -m madhusudan_voice.replay clear-faults [CALL]    retry stopped streams

A stream stops when the API refuses one of its events for good. Once the cause is
fixed (the worker was pointed at another API deployment, say), clear-faults lets its
events be delivered again.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from .api import ReplayDrainer, VoiceApiClient
from .config import ReplayConfig
from .spool import EventSpool


def open_spool(config: ReplayConfig) -> EventSpool:
    return EventSpool(config.spool_path, max_events=config.spool_max_events,
        max_bytes=config.spool_max_bytes, replay_key=config.replay_credential_key)


async def run_replay() -> None:
    # Only retained per-event lease credentials are used; no worker or provider secret.
    config = ReplayConfig.from_env(dict(os.environ))
    spool = open_spool(config)
    client = VoiceApiClient(config.internal_api_url)
    drainer = ReplayDrainer(client, spool)
    drainer.start()
    try:
        await asyncio.Event().wait()
    finally:
        await drainer.stop()
        spool.close()
        await client.aclose()


def clear_faults(call_id: str | None = None) -> int:
    spool = open_spool(ReplayConfig.from_env(dict(os.environ)))
    try:
        return spool.clear_faults(call_id)
    finally:
        spool.close()


def main(argv: list[str]) -> None:
    logging.basicConfig(level=logging.INFO)
    if not argv:
        asyncio.run(run_replay())
    elif argv[0] == "clear-faults" and len(argv) <= 2:
        print(f"cleared {clear_faults(argv[1] if len(argv) == 2 else None)} stopped events")
    else:
        raise SystemExit("usage: python -m madhusudan_voice.replay [clear-faults [CALL_ID]]")


if __name__ == "__main__":
    main(sys.argv[1:])
