"""Offline fakes: a subset of the MSVA voice API rules, a LiveKit job context and a session.

The fake API mirrors the event-ingest and lease rules of apps/api/src/voiceService.ts
closely enough to show cross-boundary consequences. It is not a substitute for the
mounted-API integration test; nothing here touches a network or a provider.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import httpx

KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
BASE = "https://api.example/api/internal/voice/v1"


def agent_identity(call_id: str) -> str:
    return "msva-agent-" + hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:32]


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def enabled_env(tmp_path: Path, **overrides: str) -> dict[str, str]:
    env = {
        "VOICE_RUNTIME_ENABLED": "true",
        "VOICE_STT_MODE": "realtime",
        "LIVEKIT_URL": "ws://livekit:7880",
        "LIVEKIT_API_KEY": "key",
        "LIVEKIT_API_SECRET": "secret",
        "SARVAM_API_KEY": "sarvam",
        "ANTHROPIC_API_KEY": "anthropic",
        "VOICE_INTERNAL_API_URL": BASE,
        "VOICE_WORKER_CREDENTIAL": "worker-token",
        "VOICE_REPLAY_CREDENTIAL_KEY": KEY,
        "VOICE_SPOOL_PATH": str(tmp_path / "spool.sqlite3"),
    }
    env.update(overrides)
    return env


@dataclass
class FakeCall:
    call_id: str
    room: str
    dispatch_id: str
    caller: str
    language: str = "hi"
    epoch: int = 0
    token: str | None = None
    lease_created: datetime | None = None
    expires: datetime | None = None
    ended_at: datetime | None = None
    events: dict[str, str] = field(default_factory=dict)
    committed: list[dict] = field(default_factory=list)
    max_seq: int = 0
    tool_receipts: dict[str, dict] = field(default_factory=dict)


class FakeVoiceApi:
    """tool_mode: "commit", "timeout_no_receipt" (POST times out, receipt 404),
    "reject" (403 PARENT_NOT_ACCESSIBLE before any effect) or "limit" (409 TOOL_LIMIT:
    the call already recorded all the requests it may)."""

    CLOCK_SKEW = timedelta(seconds=5)
    REPLAY = timedelta(hours=24)

    def __init__(self, *, lease_seconds: float = 30.0) -> None:
        self.lease_seconds = lease_seconds
        self.calls: dict[str, FakeCall] = {}
        self.log: list[tuple[str, str, int, str]] = []
        self.tool_mode = "commit"
        self.tool_posts: list[dict] = []
        self.renew_status: tuple[int, str] | None = None
        self.claim_offset = timedelta(0)
        # Shifts only the expiry the claim reports, as a worker clock ahead of the server would see it.
        self.report_offset = timedelta(0)

    def add_call(self, call_id: str = "call-1", room: str = "room-1", dispatch_id: str = "dispatch-xyz", caller: str = "caller-1") -> FakeCall:
        call = FakeCall(call_id, room, dispatch_id, caller)
        self.calls[call_id] = call
        return call

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._handle))

    def _reply(self, request: httpx.Request, status: int, body: dict) -> httpx.Response:
        self.log.append((request.method, request.url.path, status, body.get("error", "")))
        return httpx.Response(status, json=body)

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/internal/voice/v1")
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        now = datetime.now(UTC)
        if path == "/leases/claim":
            body = json.loads(request.content)
            if token != "worker-token":
                return self._reply(request, 401, {"error": "WORKER_UNAUTHORIZED"})
            call = self.calls.get(body["callId"])
            if not call:
                return self._reply(request, 404, {"error": "CALL_NOT_FOUND"})
            if body["participantId"] != agent_identity(call.call_id) or body["roomName"] != call.room or body["dispatchId"] != call.dispatch_id:
                return self._reply(request, 403, {"error": "DISPATCH_MISMATCH"})
            if not call.token:
                call.epoch += 1
                call.token = f"v1.{call.epoch}." + "t" * 43
                call.lease_created = now
                call.expires = now + self.claim_offset + timedelta(seconds=self.lease_seconds)
            return self._reply(request, 200, {"callId": call.call_id, "agentEpoch": call.epoch, "expiresAt": iso(call.expires + self.report_offset), "token": call.token})
        parts = path.strip("/").split("/")
        call = self.calls.get(parts[1]) if len(parts) > 1 and parts[0] == "calls" else None
        if not call or not call.token or token != call.token:
            return self._reply(request, 401, {"error": "LEASE_INVALID"})
        rest = parts[2:]
        if rest == ["context"]:
            if call.expires <= now:
                return self._reply(request, 409, {"error": "LEASE_EXPIRED"})
            return self._reply(request, 200, {"callId": call.call_id, "roomName": call.room, "agentEpoch": call.epoch,
                "callerParticipantId": call.caller, "agentParticipantId": agent_identity(call.call_id),
                "language": call.language, "permittedTools": ["create_business_request"], "prompt": "brief"})
        if rest == ["lease", "renew"]:
            if self.renew_status:
                return self._reply(request, self.renew_status[0], {"error": self.renew_status[1]})
            if call.expires <= now:
                return self._reply(request, 409, {"error": "LEASE_EXPIRED"})
            call.expires = now + timedelta(seconds=self.lease_seconds)
            return self._reply(request, 200, {"callId": call.call_id, "agentEpoch": call.epoch, "expiresAt": iso(call.expires), "token": call.token})
        if rest == ["events"]:
            return self._event(request, call, now)
        if rest == ["tools"]:
            body = json.loads(request.content)
            self.tool_posts.append(body)
            if call.expires <= now:
                return self._reply(request, 409, {"error": "LEASE_EXPIRED"})
            if self.tool_mode == "reject":
                return self._reply(request, 403, {"error": "PARENT_NOT_ACCESSIBLE"})
            if self.tool_mode == "limit":
                return self._reply(request, 409, {"error": "TOOL_LIMIT"})
            receipt = {"requestId": f"req-{len(self.tool_posts)}", "callId": call.call_id, "caseId": "case", "ticketNumber": len(self.tool_posts), "truthState": "RECORDED", "actionState": "PENDING_STAFF", "evidenceState": "NOT_REQUESTED"}
            if self.tool_mode == "timeout_no_receipt":
                raise httpx.ReadTimeout("response lost")
            call.tool_receipts[body["invocationId"]] = receipt
            return self._reply(request, 200, receipt)
        if len(rest) == 2 and rest[0] == "tools":
            receipt = call.tool_receipts.get(rest[1])
            if not receipt:
                return self._reply(request, 404, {"error": "TOOL_RECEIPT_NOT_FOUND"})
            return self._reply(request, 200, receipt)
        return self._reply(request, 404, {"error": "NOT_FOUND"})

    def _event(self, request: httpx.Request, call: FakeCall, now: datetime) -> httpx.Response:
        event = json.loads(request.content)
        if event.get("callId") != call.call_id:
            return self._reply(request, 400, {"error": "INVALID_REQUEST"})
        cutoff = call.ended_at if call.ended_at and call.ended_at < call.expires else call.expires
        if now > cutoff + self.REPLAY:
            return self._reply(request, 409, {"error": "LEASE_EXPIRED"})
        if event["agentEpoch"] != call.epoch:
            return self._reply(request, 403, {"error": "EPOCH_MISMATCH"})
        occurred = datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00"))
        is_flush = event["type"] == "transcript.flushed"
        latest = cutoff + (self.REPLAY if is_flush else self.CLOCK_SKEW)
        if occurred < call.lease_created - self.CLOCK_SKEW or occurred > now + self.CLOCK_SKEW or occurred > latest:
            return self._reply(request, 409, {"error": "EVENT_TIME_INVALID"})
        body_hash = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
        if event["eventId"] in call.events:
            if call.events[event["eventId"]] != body_hash:
                return self._reply(request, 409, {"error": "EVENT_CONFLICT"})
            return self._reply(request, 200, {"eventId": event["eventId"], "status": "duplicate"})
        if event["sourceSequence"] != call.max_seq + 1:
            return self._reply(request, 409, {"error": "SEQUENCE_OUT_OF_ORDER"})
        if is_flush and event["payload"]["lastSourceSequence"] != call.max_seq:
            return self._reply(request, 409, {"error": "FLUSH_WATERMARK_INVALID"})
        call.events[event["eventId"]] = body_hash
        call.max_seq = event["sourceSequence"]
        call.committed.append(event)
        return self._reply(request, 200, {"eventId": event["eventId"], "status": "committed"})


class FakeSession:
    """The AgentSession surface main.run_call uses, with SDK-like start/close behavior."""

    def __init__(self, *, start_error: Exception | None = None) -> None:
        self.handlers: dict[str, list[Callable]] = {}
        self.running = False
        self.start_calls = 0
        self.start_error = start_error
        self.shutdowns: list[bool] = []

    def on(self, name: str, callback: Callable) -> None:
        self.handlers.setdefault(name, []).append(callback)

    def emit(self, name: str, *args: Any) -> None:
        for callback in list(self.handlers.get(name, [])):
            callback(*args)

    async def start(self, **kwargs: Any) -> None:
        self.start_calls += 1
        if self.start_error:
            raise self.start_error
        self.running = True

    def shutdown(self, *, drain: bool = True) -> None:
        self.shutdowns.append(drain)
        if self.running:
            self.running = False
            self.emit("close", SimpleNamespace(reason="user"))


class FakeCtx:
    def __init__(self, call_id: str = "call-1", room: str = "room-1", dispatch_id: str = "dispatch-xyz", job_id: str = "job-1") -> None:
        self.job = SimpleNamespace(metadata=json.dumps({"callId": call_id}), room=SimpleNamespace(name=room), id=job_id, dispatch_id=dispatch_id)
        self.local_participant_identity = agent_identity(call_id)
        self.room = object()
        self.shutdown_reasons: list[str] = []

    async def connect(self) -> None:
        return None

    def shutdown(self, reason: str = "") -> None:
        self.shutdown_reasons.append(reason)


@dataclass
class Runtime:
    entry: Callable
    finalize: Callable
    runtimes: dict
    spools: list
    clients: list
    sessions: list
    # The host's replay companion: the one process that delivers the calls' evidence.
    companion: Any

    async def stop_companion(self) -> None:
        await self.companion.stop()
        self.companion.spool.close()
        await self.companion.client.aclose()


def install_runtime(monkeypatch, tmp_path: Path, api: FakeVoiceApi, session_factory: Callable[[], FakeSession] | None = None) -> Runtime:
    """Builds the real AgentServer entrypoint with fake HTTP transport, session and SDK hooks."""
    import madhusudan_voice.main as main
    from madhusudan_voice.api import ReplayDrainer, VoiceApiClient
    from madhusudan_voice.config import RuntimeConfig
    from madhusudan_voice.spool import EventSpool

    spools: list = []
    clients: list = []
    sessions: list = []

    class RecordingSpool(EventSpool):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.closed = False
            spools.append(self)

        def close(self) -> None:
            self.closed = True
            super().close()

    class RecordingClient(VoiceApiClient):
        def __init__(self, base_url: str, *, worker_credential: str | None = None):
            super().__init__(base_url, worker_credential=worker_credential, client=api.client())
            self._owns_client = True
            self.closed = False
            clients.append(self)

        async def aclose(self) -> None:
            self.closed = True
            await super().aclose()

    def make_session(config, language):
        session = (session_factory or FakeSession)()
        sessions.append(session)
        return session

    monkeypatch.setattr(main, "EventSpool", RecordingSpool)
    monkeypatch.setattr(main, "VoiceApiClient", RecordingClient)
    monkeypatch.setattr(main, "create_session", make_session)
    config = RuntimeConfig.from_env(enabled_env(tmp_path))
    server = main.build_server(config)
    finalize = server._session_end_fnc
    runtimes = inspect.getclosurevars(finalize).nonlocals["runtimes"]
    companion = ReplayDrainer(VoiceApiClient(BASE, client=api.client()),
        EventSpool(config.spool_path, max_events=config.spool_max_events, max_bytes=config.spool_max_bytes, replay_key=KEY), interval_seconds=0.02)
    companion.start()
    return Runtime(server._entrypoint_fnc, finalize, runtimes, spools, clients, sessions, companion)


def lease_expiring_in(seconds: float, *, call_id: str = "call", epoch: int = 1, token: str = "token", wall_skew: float = 0.0):
    """A lease as the client would build it: expiry from the server, send time from local clocks."""
    from madhusudan_voice.api import Lease

    now_wall = time.time()
    expires = datetime.fromtimestamp(now_wall + seconds, UTC)
    return Lease(call_id, epoch, iso(expires), token, sent_monotonic=time.monotonic(), sent_wall=now_wall + wall_skew)


async def wait_until(predicate: Callable[[], bool], *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)
