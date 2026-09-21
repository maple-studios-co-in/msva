"""The narrow authenticated HTTP boundary to the MSVA service."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx

from .spool import EventSpool, ReplayCredential

logger = logging.getLogger(__name__)

MAX_RESPONSE_BYTES = 65_536
# A refused request was understood and will be refused again; retrying cannot help.
PERMANENT_STATUSES = frozenset({400, 401, 403, 404, 409, 413, 422})
# The lease no longer authorizes this worker (expired, ended, taken over or disabled).
AUTHORITY_CODES = frozenset({"LEASE_INVALID", "LEASE_EXPIRED", "LEASE_STALE", "SESSION_UNAVAILABLE", "RECOVERY_REQUIRED", "VOICE_DISABLED"})
# The API's own reasons for refusing an event for good. Any other refusal (an HTML 404
# from a misrouted URL, a proxy error) says nothing about the event, so it is retried.
EVENT_REFUSAL_CODES = frozenset({
    "INVALID_REQUEST", "LEASE_INVALID", "LEASE_EXPIRED", "EPOCH_MISMATCH", "EVENT_TIME_INVALID", "EVENT_CONFLICT",
    "SEQUENCE_CONFLICT", "SEQUENCE_OUT_OF_ORDER", "EVENT_CAPACITY", "PARTICIPANT_MISMATCH", "SEGMENT_IDENTITY_CONFLICT",
    "SEGMENT_REVISION_CONFLICT", "SEGMENT_SEQUENCE_CONFLICT", "FLUSH_WATERMARK_INVALID", "CONTROL_ACK_INVALID", "CONFLICT",
})
# The API refused the tool request before any business effect; the model may correct it.
REJECTION_CODES = frozenset({"INVALID_REQUEST", "INVALID_TOOL_ARGUMENTS", "CALL_NOT_FOUND", "IDENTITY_REQUIRED", "PARENT_NOT_ACCESSIBLE", "IDEMPOTENCY_CONFLICT", "INVOCATION_CONFLICT"})
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class VoiceApiError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def permanent(self) -> bool:
        return self.status in PERMANENT_STATUSES


class DispatchPending(VoiceApiError):
    """The API has not yet bound the just-created provider dispatch."""


class ToolRejected(VoiceApiError):
    """The API refused the tool request before any business effect."""


class ToolOutcomeUncertain(VoiceApiError):
    """The tool request may have committed; no new request may be made for it."""


class AuthorityLost(VoiceApiError):
    """The lease no longer authorizes this worker to act."""


@dataclass(frozen=True)
class Lease:
    call_id: str
    agent_epoch: int
    expires_at: str
    token: str
    # Local clocks when the request that produced this lease was sent. The server
    # set its expiry after that moment, so a deadline measured from here is never late.
    sent_monotonic: float = field(default=0.0, compare=False)
    sent_wall: float = field(default=0.0, compare=False)

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, sent_monotonic: float = 0.0, sent_wall: float = 0.0) -> "Lease":
        required = ("callId", "agentEpoch", "expiresAt", "token")
        if any(not payload.get(key) for key in required):
            raise VoiceApiError("lease response is incomplete")
        return cls(
            call_id=str(payload["callId"]),
            agent_epoch=int(payload["agentEpoch"]),
            expires_at=str(payload["expiresAt"]),
            token=str(payload["token"]),
            sent_monotonic=sent_monotonic,
            sent_wall=sent_wall,
        )

    def local_deadline(self, max_seconds: float) -> float:
        """Monotonic time by which this lease has certainly expired.

        Wall-clock skew can only shorten it, and a reported expiry longer than the
        configured lease is not trusted."""
        try:
            expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return self.sent_monotonic
        return self.sent_monotonic + min(max(0.0, expires - self.sent_wall), max_seconds)


@dataclass(frozen=True)
class CallContext:
    call_id: str
    room_name: str
    agent_epoch: int
    caller_participant_id: str
    agent_participant_id: str
    language: str
    permitted_tools: tuple[str, ...]
    prompt: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CallContext":
        required = (
            "callId", "roomName", "agentEpoch", "callerParticipantId", "agentParticipantId", "language", "permittedTools"
        )
        if any(key not in payload for key in required):
            raise VoiceApiError("context response is incomplete")
        if not isinstance(payload["permittedTools"], list):
            raise VoiceApiError("permittedTools must be a list")
        return cls(
            call_id=str(payload["callId"]), room_name=str(payload["roomName"]),
            agent_epoch=int(payload["agentEpoch"]), caller_participant_id=str(payload["callerParticipantId"]),
            agent_participant_id=str(payload["agentParticipantId"]), language=str(payload["language"]),
            permitted_tools=tuple(str(item) for item in payload["permittedTools"]),
            prompt=str(payload.get("prompt", "")),
        )


class VoiceApiClient:
    def __init__(self, base_url: str, *, worker_credential: str | None = None, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        # Only a claim needs the global worker credential; replay uses retained per-call leases.
        self.worker_credential = worker_credential
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0))
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def claim_lease(self, *, call_id: str, room_name: str, dispatch_id: str, participant_id: str) -> Lease:
        if not self.worker_credential:
            raise VoiceApiError("a worker credential is required to claim a lease")
        sent_monotonic, sent_wall = time.monotonic(), time.time()
        response = await self._request("POST",
            f"{self.base_url}/leases/claim",
            headers={"Authorization": f"Bearer {self.worker_credential}"},
            json={"callId": call_id, "roomName": room_name, "dispatchId": dispatch_id, "participantId": participant_id},
        )
        if response.status_code == 503 and self._json(response).get("error") == "DISPATCH_PENDING":
            raise DispatchPending("provider dispatch binding is pending", status=503, code="DISPATCH_PENDING")
        if response.status_code != 200:
            raise self._error("lease claim", response)
        return Lease.from_payload(self._json(response), sent_monotonic=sent_monotonic, sent_wall=sent_wall)

    async def context(self, lease: Lease) -> CallContext:
        response = await self._request("GET",
            f"{self.base_url}/calls/{lease.call_id}/context",
            headers={"Authorization": f"Bearer {lease.token}"},
        )
        if response.status_code != 200:
            raise self._error("context fetch", response)
        context = CallContext.from_payload(self._json(response))
        if context.call_id != lease.call_id or context.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("context does not match the active lease")
        return context

    async def renew(self, lease: Lease) -> Lease:
        sent_monotonic, sent_wall = time.monotonic(), time.time()
        response = await self._request("POST",
            f"{self.base_url}/calls/{lease.call_id}/lease/renew",
            headers={"Authorization": f"Bearer {lease.token}"},
            json={"agentEpoch": lease.agent_epoch},
        )
        if response.status_code != 200:
            raise self._error("lease renew", response)
        renewed = Lease.from_payload(self._json(response), sent_monotonic=sent_monotonic, sent_wall=sent_wall)
        if renewed.call_id != lease.call_id or renewed.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("renewed lease does not match the active call epoch")
        return renewed

    async def publish(self, event: dict[str, Any], lease: Lease) -> str:
        response = await self._request("POST",
            f"{self.base_url}/calls/{lease.call_id}/events",
            headers={"Authorization": f"Bearer {lease.token}"}, json=event,
        )
        if response.status_code != 200:
            raise self._error("event publish", response)
        receipt = self._json(response)
        if receipt.get("eventId") != event.get("eventId") or receipt.get("status") not in {"committed", "duplicate"}:
            raise VoiceApiError("event receipt is invalid")
        return str(receipt["status"])

    def replay_credential(self, lease: Lease) -> ReplayCredential:
        return ReplayCredential(lease.call_id, lease.agent_epoch, lease.token, lease.expires_at)

    async def flush_spool(self, spool: EventSpool) -> int:
        committed = 0
        # ready() returns each stream's head. Every head is posted once per round before
        # the next query, so one stream's backlog never holds up another's, and no stream
        # jumps its own events.
        while heads := spool.ready():
            for queued in heads:
                try:
                    # Every schema-declared lifecycle event is evidence. The API separately
                    # constrains historical receipt so this never restores call authority.
                    await self.publish(queued.payload, Lease(
                        queued.credential.call_id, queued.credential.agent_epoch,
                        queued.credential.expires_at, queued.credential.token,
                    ))
                except VoiceApiError as error:
                    if error.permanent and error.code in EVENT_REFUSAL_CODES:
                        # A refused event will be refused forever, and later events must not
                        # jump it: stop this stream and surface a sanitized fault.
                        reason = f"HTTP_{error.status}:{error.code}"
                        spool.fault_stream(queued.credential.call_id, queued.credential.agent_epoch, reason)
                        logger.warning("voice evidence stream stopped: call=%s epoch=%s reason=%s",
                            queued.credential.call_id, queued.credential.agent_epoch, reason)
                    else:
                        if error.permanent:
                            logger.warning("voice evidence delivery got an unrecognized refusal (HTTP %s); retrying", error.status)
                        # Backing off hides this stream from ready(); other streams still drain.
                        spool.retry(queued.event_id)
                    continue
                spool.acknowledge(queued.event_id)
                committed += 1
        return committed

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One bounded deadline and bounded, unencoded response body for every worker API request."""
        # Asking for an identity encoding keeps a small compressed body from expanding
        # past the size cap after it has been counted.
        headers = {"Accept-Encoding": "identity", **kwargs.pop("headers", {})}
        try:
            async with asyncio.timeout(12):
                async with self._client.stream(method, url, headers=headers, **kwargs) as response:
                    if response.headers.get("content-encoding", "identity").strip().lower() not in {"", "identity"}:
                        raise VoiceApiError("internal voice API response is encoded")
                    if response.is_stream_consumed:  # MockTransport JSON/content response
                        body = response.content
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise VoiceApiError("internal voice API response exceeds 64 KiB")
                    else:
                        chunks: list[bytes] = []
                        size = 0
                        async for chunk in response.aiter_raw():
                            size += len(chunk)
                            if size > MAX_RESPONSE_BYTES:
                                raise VoiceApiError("internal voice API response exceeds 64 KiB")
                            chunks.append(chunk)
                        body = b"".join(chunks)
        except (TimeoutError, httpx.HTTPError) as exc:
            raise VoiceApiError("internal voice API is unavailable") from exc
        return httpx.Response(response.status_code, headers=response.headers, content=body, request=response.request)

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            decoded = response.json()
        except ValueError as exc:
            raise VoiceApiError("internal voice API returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise VoiceApiError("internal voice API returned a non-object JSON response")
        return decoded

    @classmethod
    def _error(cls, action: str, response: httpx.Response, error_type: type[VoiceApiError] = VoiceApiError) -> VoiceApiError:
        """A sanitized error: the status and a well-formed error code, never the raw body."""
        try:
            code = cls._json(response).get("error")
        except VoiceApiError:
            code = None
        code = code if isinstance(code, str) and _CODE.match(code) else None
        return error_type(f"{action} failed with HTTP {response.status_code}", status=response.status_code, code=code)

    async def invoke_tool(self, lease: Lease, *, invocation_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._request("POST",
                f"{self.base_url}/calls/{lease.call_id}/tools",
                headers={"Authorization": f"Bearer {lease.token}"},
                json={"invocationId": invocation_id, "agentEpoch": lease.agent_epoch, "name": name, "arguments": arguments},
            )
        except VoiceApiError:
            # No response: the request may have committed. Only read its receipt.
            return await self.tool_receipt(lease, invocation_id)
        if response.status_code == 200:
            return self._json(response)
        error = self._error("tool invocation", response)
        if error.status == 401 or error.code in AUTHORITY_CODES:
            raise self._error("tool invocation", response, AuthorityLost)
        if error.permanent:
            raise self._error("tool invocation", response, ToolRejected)
        return await self.tool_receipt(lease, invocation_id)

    def record_tool_intent(self, spool: EventSpool, lease: Lease, *, logical_id: str, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        return spool.tool_intent(call_id=lease.call_id, agent_epoch=lease.agent_epoch, logical_id=logical_id, name=name, arguments=arguments)

    async def tool_receipt(self, lease: Lease, invocation_id: str) -> dict[str, Any]:
        try:
            response = await self._request("GET",
                f"{self.base_url}/calls/{lease.call_id}/tools/{invocation_id}",
                headers={"Authorization": f"Bearer {lease.token}"},
            )
        except VoiceApiError as exc:
            raise ToolOutcomeUncertain("tool outcome is uncertain; no new request will be made") from exc
        if response.status_code == 200:
            return self._json(response)
        error = self._error("tool receipt", response)
        if error.code in REJECTION_CODES:
            # A recorded rejection: the request made no business effect.
            raise self._error("tool receipt", response, ToolRejected)
        raise self._error("tool outcome is uncertain; no new request will be made", response, ToolOutcomeUncertain)


class ReplayDrainer:
    """Independent bounded replay loop; event creation never waits for the API."""

    def __init__(self, client: VoiceApiClient, spool: EventSpool, *, interval_seconds: float = 1.0, prune_seconds: float = 300.0) -> None:
        self.client, self.spool, self.interval_seconds, self.prune_seconds = client, spool, interval_seconds, prune_seconds
        self._stopping = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="voice-evidence-replay")

    async def drain(self, timeout_seconds: float) -> int:
        async with asyncio.timeout(timeout_seconds):
            return await self.client.flush_spool(self.spool)

    async def stop(self) -> None:
        self._stopping.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception as error:  # noqa: BLE001 - stopping must not skip the caller's cleanup
                logger.warning("voice evidence replay stopped with %s", type(error).__name__)

    async def _run(self) -> None:
        last_prune = float("-inf")
        while not self._stopping.is_set():
            try:
                await self.client.flush_spool(self.spool)
                if time.monotonic() - last_prune >= self.prune_seconds:
                    self.spool.prune()
                    last_prune = time.monotonic()
            except Exception as error:  # noqa: BLE001 - one bad pass must not end evidence recovery
                logger.warning("voice evidence replay pass failed with %s", type(error).__name__)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                pass
