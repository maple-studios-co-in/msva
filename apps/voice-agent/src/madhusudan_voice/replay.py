"""Host companion for durable evidence replay: the one process that delivers evidence.

    python -m madhusudan_voice.replay                        run the companion
    python -m madhusudan_voice.replay clear-faults [CALL]    retry stopped streams
    python -m madhusudan_voice.replay healthcheck            exit 1 once delivery passes stop
    python -m madhusudan_voice.replay quarantine-unreadable  stop streams no key can read

A stream stops when the API refuses one of its events for good. Once the cause is
fixed (the worker was pointed at another API deployment, say), clear-faults lets its
events be delivered again.

The services refuse to start while a stream still being delivered holds a credential
no configured key can read. If that key is lost for good, quarantine-unreadable stops
those streams (their events are never delivered) so the services can start.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

from .api import ReplayDrainer, VoiceApiClient
from .config import ReplayConfig
from .spool import EventSpool


# The companion touches its heartbeat after every completed delivery pass (about once a
# second); a heartbeat older than this means it has stopped delivering.
HEARTBEAT_MAX_AGE_SECONDS = 30


def heartbeat_path(config: ReplayConfig) -> Path:
    return config.spool_path.with_name("replay.heartbeat")


def open_spool(config: ReplayConfig, *, verify_credentials: bool = True) -> EventSpool:
    return EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes,
        replay_key=config.replay_credential_key, verify_credentials=verify_credentials)


async def run_replay() -> None:
    # Only retained per-event lease credentials are used; no worker or provider secret.
    config = ReplayConfig.from_env(dict(os.environ))
    spool = open_spool(config)
    client = VoiceApiClient(config.internal_api_url)
    drainer = ReplayDrainer(client, spool, heartbeat=heartbeat_path(config))
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


def quarantine_unreadable() -> int:
    spool = open_spool(ReplayConfig.from_env(dict(os.environ)), verify_credentials=False)
    try:
        return spool.quarantine_unreadable()
    finally:
        spool.close()


def healthcheck(*, now: float | None = None) -> bool:
    """Whether the companion completed a delivery pass recently."""
    path = heartbeat_path(ReplayConfig.from_env(dict(os.environ)))
    try:
        age = (time.time() if now is None else now) - path.stat().st_mtime
    except OSError:
        return False
    return age <= HEARTBEAT_MAX_AGE_SECONDS


def main(argv: list[str]) -> None:
    logging.basicConfig(level=logging.INFO)
    if not argv:
        asyncio.run(run_replay())
    elif argv[0] == "clear-faults" and len(argv) <= 2:
        print(f"cleared {clear_faults(argv[1] if len(argv) == 2 else None)} stopped events")
    elif argv == ["healthcheck"]:
        raise SystemExit(0 if healthcheck() else 1)
    elif argv == ["quarantine-unreadable"]:
        print(f"stopped {quarantine_unreadable()} streams whose credentials no configured key can read")
    else:
        raise SystemExit("usage: python -m madhusudan_voice.replay [clear-faults [CALL_ID] | healthcheck | quarantine-unreadable]")


if __name__ == "__main__":
    main(sys.argv[1:])
