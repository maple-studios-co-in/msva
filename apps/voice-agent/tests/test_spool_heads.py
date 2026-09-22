"""Finding each evidence stream's next event."""

import json
import sqlite3
import time

from cryptography.fernet import Fernet

from madhusudan_voice.spool import EventSpool

from fake_voice_api import KEY


def spool_at(path) -> EventSpool:
    return EventSpool(path, max_events=20_000, max_bytes=50_000_000, replay_key=KEY)


def test_a_spool_from_before_sequence_numbers_keeps_its_order(tmp_path):
    path = tmp_path / "spool.sqlite3"
    token = Fernet(KEY.encode()).encrypt(b"lease-token")
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE event_spool (
            event_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, agent_epoch INTEGER NOT NULL,
            payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL, encrypted_token BLOB NOT NULL,
            expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL NOT NULL, created_at REAL NOT NULL, fault TEXT)""")
        # Stored out of order: the second event was written first.
        for event_id, sequence, created in (("final", 2, 1.0), ("ready", 1, 2.0)):
            payload = json.dumps({"eventId": event_id, "sourceSequence": sequence})
            db.execute("INSERT INTO event_spool VALUES (?, 'call-1', 1, ?, 10, ?, '2030-01-01T00:00:00Z', 0, 0, ?, NULL)", (event_id, payload, token, created))
    spool = spool_at(path)
    assert [event.event_id for event in spool.ready(now=10)] == ["ready"]
    spool.acknowledge("ready")
    assert [event.event_id for event in spool.ready(now=10)] == ["final"]


def test_stream_heads_are_found_quickly_in_a_large_backlog(tmp_path):
    spool = spool_at(tmp_path / "spool.sqlite3")
    token = spool._cipher.encrypt(b"lease-token")
    rows = [(f"{call}-{sequence}", call, 1, sequence, json.dumps({"eventId": f"{call}-{sequence}", "sourceSequence": sequence}), 10, token, "2030-01-01T00:00:00Z", 0, float(sequence))
        for call in ("call-a", "call-b") for sequence in range(1, 5_001)]
    with spool._write() as db:
        db.executemany("""INSERT INTO event_spool(event_id,call_id,agent_epoch,source_sequence,payload,payload_bytes,encrypted_token,expires_at,next_attempt_at,created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows)
    started = time.perf_counter()
    heads = spool.ready(now=10)
    elapsed = time.perf_counter() - started
    assert sorted(event.event_id for event in heads) == ["call-a-1", "call-b-1"]
    assert elapsed < 0.25, f"finding two heads among 10,000 events took {elapsed:.3f} s"


def test_a_streams_wait_is_measured_from_its_oldest_undelivered_event(tmp_path):
    from madhusudan_voice.spool import ReplayCredential

    spool = spool_at(tmp_path / "spool.sqlite3")
    credential = ReplayCredential("call-1", 1, "lease-token", "2030-01-01T00:00:00Z")
    assert spool.waiting_seconds("call-1", 1, now=100.0) == 0.0
    for event_id, sequence, written in (("ready", 1, 10.0), ("final", 2, 40.0)):
        spool.enqueue(event_id=event_id, call_id="call-1", payload={"eventId": event_id, "sourceSequence": sequence}, credential=credential, now=written)
    assert spool.waiting_seconds("call-1", 1, now=100.0) == 90.0
    spool.acknowledge("ready")
    assert spool.waiting_seconds("call-1", 1, now=100.0) == 60.0
    assert spool.waiting_seconds("call-2", 1, now=100.0) == 0.0
