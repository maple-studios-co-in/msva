"""A bounded SQLite WAL outbox for durable worker evidence, never audio."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class SpoolCapacityError(RuntimeError):
    """New calls must be rejected until durable evidence can be recorded again."""


def canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class SpoolEvent:
    event_id: str
    call_id: str
    payload: dict[str, Any]
    attempts: int


class EventSpool:
    def __init__(self, path: Path, *, max_events: int, max_bytes: int) -> None:
        self.path = path
        self.max_events = max_events
        self.max_bytes = max_bytes
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path, timeout=5)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA busy_timeout=5000")
        self._connection.execute(
            """CREATE TABLE IF NOT EXISTS event_spool (
                event_id TEXT PRIMARY KEY,
                call_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at REAL NOT NULL,
                created_at REAL NOT NULL
            )"""
        )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()

    def pending_count(self) -> int:
        return int(self._connection.execute("SELECT COUNT(*) FROM event_spool").fetchone()[0])

    def pending_bytes(self) -> int:
        return int(
            self._connection.execute("SELECT COALESCE(SUM(payload_bytes), 0) FROM event_spool").fetchone()[0]
        )

    def enqueue(self, *, event_id: str, call_id: str, payload: dict[str, Any], now: float | None = None) -> bool:
        serialized = canonical_json(payload)
        payload_bytes = len(serialized.encode("utf-8"))
        now = time.time() if now is None else now
        with self._connection:
            existing = self._connection.execute(
                "SELECT payload FROM event_spool WHERE event_id = ?", (event_id,)
            ).fetchone()
            if existing is not None:
                if existing[0] != serialized:
                    raise ValueError("event_id already exists with a different payload")
                return False
            if self.pending_count() >= self.max_events or self.pending_bytes() + payload_bytes > self.max_bytes:
                raise SpoolCapacityError("durable event spool is at capacity")
            self._connection.execute(
                "INSERT INTO event_spool(event_id, call_id, payload, payload_bytes, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (event_id, call_id, serialized, payload_bytes, now, now),
            )
        return True

    def ready(self, *, now: float | None = None, limit: int = 100) -> list[SpoolEvent]:
        now = time.time() if now is None else now
        rows = self._connection.execute(
            "SELECT event_id, call_id, payload, attempts FROM event_spool WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?",
            (now, limit),
        ).fetchall()
        return [SpoolEvent(row[0], row[1], json.loads(row[2]), row[3]) for row in rows]

    def acknowledge(self, event_id: str) -> None:
        with self._connection:
            self._connection.execute("DELETE FROM event_spool WHERE event_id = ?", (event_id,))

    def retry(self, event_id: str, *, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._connection:
            row = self._connection.execute(
                "SELECT attempts FROM event_spool WHERE event_id = ?", (event_id,)
            ).fetchone()
            if row is None:
                return
            attempts = int(row[0]) + 1
            delay = min(300, 2 ** min(attempts, 8))
            self._connection.execute(
                "UPDATE event_spool SET attempts = ?, next_attempt_at = ? WHERE event_id = ?",
                (attempts, now + delay, event_id),
            )
