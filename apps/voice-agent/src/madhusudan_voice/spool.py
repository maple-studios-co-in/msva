"""A bounded SQLite WAL outbox for durable worker evidence, never audio."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

# The API accepts evidence for 24 hours after a lease's cutoff, and a call (hence
# its lease) lasts at most about two hours. Past both, a retained credential is
# useless, so everything it guarded can be dropped.
REPLAY_WINDOW_SECONDS = 24 * 60 * 60
MAX_CALL_SECONDS = 2 * 60 * 60
RETENTION_SECONDS = REPLAY_WINDOW_SECONDS + MAX_CALL_SECONDS


class SpoolCapacityError(RuntimeError):
    """New calls must be rejected until durable evidence can be recorded again."""


class ToolIntentConflict(RuntimeError):
    """A provider logical call ID was reused with changed arguments."""


def canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class ReplayCredential:
    call_id: str
    agent_epoch: int
    token: str
    expires_at: str


@dataclass(frozen=True)
class SpoolEvent:
    event_id: str
    call_id: str
    payload: dict[str, Any]
    attempts: int
    credential: ReplayCredential


class EventSpool:
    """Evidence spool with per-event encrypted, historical lease credentials.

    The API limits retained credentials to evidence-only transcript replay for 24
    hours. They are never used for context, lease renewal, or tools.
    """

    def __init__(self, path: Path, *, max_events: int, max_bytes: int, replay_key: str) -> None:
        self.path, self.max_events, self.max_bytes = path, max_events, max_bytes
        try:
            self._cipher = Fernet(replay_key.encode())
        except (ValueError, TypeError) as exc:
            raise ValueError("VOICE_REPLAY_CREDENTIAL_KEY must be a Fernet key") from exc
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        for setting in ("PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA busy_timeout=5000"):
            self._connection.execute(setting)
        with self._write() as db:
            self._migrate(db)

    @staticmethod
    def _columns(db: sqlite3.Connection, table: str) -> set[str]:
        return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}

    def _migrate(self, db: sqlite3.Connection) -> None:
        """Creates or upgrades every table in one transaction, so a crash leaves either the old or the new layout."""
        now = time.time()
        db.execute("""CREATE TABLE IF NOT EXISTS event_spool (
            event_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL,
            payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL, encrypted_token BLOB NOT NULL,
            expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL NOT NULL, created_at REAL NOT NULL, fault TEXT)""")
        if "fault" not in self._columns(db, "event_spool"):
            db.execute("ALTER TABLE event_spool ADD COLUMN fault TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS source_sequence (
            call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL, next_value INTEGER NOT NULL,
            updated_at REAL NOT NULL DEFAULT 0, PRIMARY KEY(call_id, agent_epoch))""")
        db.execute("""CREATE TABLE IF NOT EXISTS segment_order (
            call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL, segment_id TEXT NOT NULL,
            ordering INTEGER NOT NULL, updated_at REAL NOT NULL DEFAULT 0, PRIMARY KEY(call_id, agent_epoch, segment_id),
            UNIQUE(call_id, agent_epoch, ordering))""")
        for table in ("source_sequence", "segment_order"):
            if "updated_at" not in self._columns(db, table):
                db.execute(f"ALTER TABLE {table} ADD COLUMN updated_at REAL NOT NULL DEFAULT 0")
            # Rows from before retention existed count as fresh, never as expired.
            db.execute(f"UPDATE {table} SET updated_at=? WHERE updated_at=0", (now,))
        db.execute("""CREATE TABLE IF NOT EXISTS tool_intent (
            call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL, logical_id TEXT NOT NULL,
            name TEXT NOT NULL, arguments TEXT NOT NULL, invocation_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL, receipt TEXT, created_at REAL NOT NULL,
            PRIMARY KEY(call_id, agent_epoch, logical_id))""")
        if "logical_id" not in self._columns(db, "tool_intent"):
            # Rebuild the old argument-keyed table. Existing entries retain evidence under
            # synthetic legacy IDs but can never collide with a newly supplied SDK call ID.
            db.execute("ALTER TABLE tool_intent RENAME TO tool_intent_legacy")
            db.execute("""CREATE TABLE tool_intent (
                call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL, logical_id TEXT NOT NULL,
                name TEXT NOT NULL, arguments TEXT NOT NULL, invocation_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL, receipt TEXT, created_at REAL NOT NULL,
                PRIMARY KEY(call_id, agent_epoch, logical_id))""")
            db.execute("""INSERT INTO tool_intent(call_id,agent_epoch,logical_id,name,arguments,invocation_id,state,receipt,created_at)
                SELECT call_id,agent_epoch,'legacy:' || invocation_id,name,arguments,invocation_id,state,receipt,created_at FROM tool_intent_legacy""")
            db.execute("DROP TABLE tool_intent_legacy")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS tool_intent_logical ON tool_intent(call_id,agent_epoch,logical_id)")

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        # This makes capacity, sequence reservation, and insert atomic across processes.
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield self._connection
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

    def close(self) -> None:
        self._connection.close()

    def pending_count(self) -> int:
        return int(self._connection.execute("SELECT COUNT(*) FROM event_spool").fetchone()[0])

    def pending_bytes(self) -> int:
        return int(self._connection.execute("SELECT COALESCE(SUM(payload_bytes), 0) FROM event_spool").fetchone()[0])

    def next_sequence(self, *, call_id: str, agent_epoch: int) -> int:
        with self._write() as db:
            row = db.execute("SELECT next_value FROM source_sequence WHERE call_id=? AND agent_epoch=?", (call_id, agent_epoch)).fetchone()
            value = int(row[0]) if row else 1
            db.execute("INSERT OR REPLACE INTO source_sequence(call_id,agent_epoch,next_value,updated_at) VALUES (?, ?, ?, ?)", (call_id, agent_epoch, value + 1, time.time()))
        return value

    def segment_sequence(self, *, call_id: str, agent_epoch: int, segment_id: str) -> int:
        with self._write() as db:
            row = db.execute("SELECT ordering FROM segment_order WHERE call_id=? AND agent_epoch=? AND segment_id=?", (call_id, agent_epoch, segment_id)).fetchone()
            if row:
                return int(row[0])
            maximum = db.execute("SELECT COALESCE(MAX(ordering), 0) FROM segment_order WHERE call_id=? AND agent_epoch=?", (call_id, agent_epoch)).fetchone()
            ordering = int(maximum[0]) + 1
            db.execute("INSERT INTO segment_order(call_id,agent_epoch,segment_id,ordering,updated_at) VALUES (?, ?, ?, ?, ?)", (call_id, agent_epoch, segment_id, ordering, time.time()))
            return ordering

    def _has_room(self, db: sqlite3.Connection, stored_bytes: int) -> bool:
        row = db.execute("SELECT COUNT(*), COALESCE(SUM(payload_bytes), 0) FROM event_spool").fetchone()
        return int(row[0]) < self.max_events and int(row[1]) + stored_bytes <= self.max_bytes

    def enqueue(self, *, event_id: str, call_id: str, payload: dict[str, Any], credential: ReplayCredential, now: float | None = None) -> bool:
        if credential.call_id != call_id:
            raise ValueError("replay credential belongs to another call")
        serialized = canonical_json(payload)
        now = time.time() if now is None else now
        encrypted = self._cipher.encrypt(credential.token.encode())
        # Capacity counts everything retained per event, including the credential.
        stored_bytes = len(serialized.encode()) + len(encrypted)
        with self._write() as db:
            existing = db.execute("SELECT payload FROM event_spool WHERE event_id=?", (event_id,)).fetchone()
            if existing:
                if existing[0] != serialized:
                    raise ValueError("event_id already exists with a different payload")
                return False
            if not self._has_room(db, stored_bytes):
                raise SpoolCapacityError("durable event spool is at capacity")
            db.execute("""INSERT INTO event_spool(event_id,call_id,agent_epoch,payload,payload_bytes,encrypted_token,expires_at,next_attempt_at,created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", (event_id, call_id, credential.agent_epoch, serialized, stored_bytes,
                encrypted, credential.expires_at, now, now))
        return True

    def append_event(
        self, *, call_id: str, agent_epoch: int, credential: ReplayCredential,
        build: Callable[[int], dict[str, Any]], now: float | None = None,
    ) -> tuple[str, int]:
        """Atomically reserve the next sequence and persist its immutable event."""
        now = time.time() if now is None else now
        encrypted = self._cipher.encrypt(credential.token.encode())
        with self._write() as db:
            row = db.execute("SELECT next_value FROM source_sequence WHERE call_id=? AND agent_epoch=?", (call_id, agent_epoch)).fetchone()
            sequence = int(row[0]) if row else 1
            event = build(sequence)
            event_id = str(event.get("eventId", ""))
            serialized = canonical_json(event)
            stored_bytes = len(serialized.encode()) + len(encrypted)
            if not event_id or not self._has_room(db, stored_bytes):
                raise SpoolCapacityError("durable event spool is at capacity")
            db.execute("INSERT OR REPLACE INTO source_sequence(call_id,agent_epoch,next_value,updated_at) VALUES (?, ?, ?, ?)", (call_id, agent_epoch, sequence + 1, now))
            db.execute("""INSERT INTO event_spool(event_id,call_id,agent_epoch,payload,payload_bytes,encrypted_token,expires_at,next_attempt_at,created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", (event_id, call_id, agent_epoch, serialized, stored_bytes,
                encrypted, credential.expires_at, now, now))
        return event_id, sequence

    def ready(self, *, now: float | None = None, limit: int = 100) -> list[SpoolEvent]:
        """The deliverable head of each unfaulted stream. A faulted or pending earlier
        event still blocks everything after it, so no stream ever skips an event."""
        now = time.time() if now is None else now
        rows = self._connection.execute("""SELECT e.event_id,e.call_id,e.agent_epoch,e.payload,e.attempts,e.encrypted_token,e.expires_at
            FROM event_spool e WHERE e.fault IS NULL AND e.next_attempt_at<=? AND NOT EXISTS (
              SELECT 1 FROM event_spool earlier WHERE earlier.call_id=e.call_id AND earlier.agent_epoch=e.agent_epoch
              AND CAST(json_extract(earlier.payload, '$.sourceSequence') AS INTEGER) < CAST(json_extract(e.payload, '$.sourceSequence') AS INTEGER))
            ORDER BY e.created_at LIMIT ?""", (now, limit)).fetchall()
        result = []
        for row in rows:
            try:
                token = self._cipher.decrypt(row[5]).decode()
            except (InvalidToken, UnicodeDecodeError):
                # One unreadable credential stops only its own stream.
                self.fault_event(row[0], "CREDENTIAL_UNREADABLE")
                logger.warning("voice evidence stream stopped: call=%s epoch=%s reason=CREDENTIAL_UNREADABLE", row[1], row[2])
                continue
            result.append(SpoolEvent(row[0], row[1], json.loads(row[3]), int(row[4]), ReplayCredential(row[1], int(row[2]), token, row[6])))
        return result

    def fault_event(self, event_id: str, reason: str) -> None:
        with self._write() as db:
            db.execute("UPDATE event_spool SET fault=? WHERE event_id=? AND fault IS NULL", (reason, event_id))

    def fault_stream(self, call_id: str, agent_epoch: int, reason: str) -> None:
        """Stops delivery of a stream the API refused; its events are kept until retention ends."""
        with self._write() as db:
            db.execute("UPDATE event_spool SET fault=? WHERE call_id=? AND agent_epoch=? AND fault IS NULL", (reason, call_id, agent_epoch))

    def acknowledge(self, event_id: str) -> None:
        with self._write() as db:
            db.execute("DELETE FROM event_spool WHERE event_id=?", (event_id,))

    def retry(self, event_id: str, *, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._write() as db:
            row = db.execute("SELECT attempts FROM event_spool WHERE event_id=?", (event_id,)).fetchone()
            if row:
                attempts = int(row[0]) + 1
                db.execute("UPDATE event_spool SET attempts=?, next_attempt_at=? WHERE event_id=?", (attempts, now + min(300, 2 ** min(attempts, 8)), event_id))

    def prune(self, *, now: float | None = None, retention_seconds: float = RETENTION_SECONDS, batch: int = 1000) -> dict[str, int]:
        """Bounds every table. Evidence whose credential the API can no longer accept
        is unrecoverable: it is dropped and reported, never retried forever."""
        now = time.time() if now is None else now
        horizon = now - retention_seconds
        removed = {"unrecoverable": 0, "faulted": 0, "tool_intents": 0, "sequences": 0, "segments": 0}
        with self._write() as db:
            # A call's lease cutoff is at most a call length after any of its events,
            # and the API stops accepting evidence a replay window after that cutoff.
            rows = db.execute("SELECT event_id, call_id, agent_epoch, fault FROM event_spool WHERE created_at < ? ORDER BY created_at LIMIT ?", (horizon, batch)).fetchall()
            for event_id, call_id, agent_epoch, fault in rows:
                db.execute("DELETE FROM event_spool WHERE event_id=?", (event_id,))
                removed["faulted" if fault is not None else "unrecoverable"] += 1
                if fault is None:
                    logger.warning("voice evidence unrecoverable after the replay window: call=%s epoch=%s", call_id, agent_epoch)
            removed["tool_intents"] = db.execute("DELETE FROM tool_intent WHERE created_at < ?", (horizon,)).rowcount
            # Sequence state is kept while its stream still has events, so a live or
            # recovering stream can never restart its numbering.
            for table, key in (("source_sequence", "sequences"), ("segment_order", "segments")):
                removed[key] = db.execute(f"""DELETE FROM {table} WHERE updated_at < ? AND NOT EXISTS (
                    SELECT 1 FROM event_spool e WHERE e.call_id={table}.call_id AND e.agent_epoch={table}.agent_epoch)""", (horizon,)).rowcount
        return removed

    def tool_intent(self, *, call_id: str, agent_epoch: int, logical_id: str, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        body = canonical_json(arguments)
        with self._write() as db:
            row = db.execute("SELECT invocation_id,name,arguments,state,receipt FROM tool_intent WHERE call_id=? AND agent_epoch=? AND logical_id=?", (call_id, agent_epoch, logical_id)).fetchone()
            if row:
                if row[1] != name or row[2] != body:
                    raise ToolIntentConflict("logical tool call was reused with different content")
                return str(row[0]), json.loads(row[4]) if row[3] == "COMMITTED" and row[4] else None
            invocation_id = str(uuid4())
            db.execute("INSERT INTO tool_intent(call_id,agent_epoch,logical_id,name,arguments,invocation_id,state,created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)", (call_id, agent_epoch, logical_id, name, body, invocation_id, time.time()))
            return invocation_id, None

    def complete_tool_intent(self, invocation_id: str, receipt: dict[str, Any]) -> None:
        with self._write() as db:
            db.execute("UPDATE tool_intent SET state='COMMITTED', receipt=? WHERE invocation_id=?", (canonical_json(receipt), invocation_id))
