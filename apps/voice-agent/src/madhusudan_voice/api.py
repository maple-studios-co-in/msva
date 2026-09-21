"""The narrow authenticated HTTP boundary to the MSVA service."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from .spool import EventSpool, ReplayCredential


class VoiceApiError(RuntimeError):
    pass


class DispatchPending(VoiceApiError):
    """The API has not yet bound the just-created provider dispatch."""


@dataclass(frozen=True)
class Lease:
    call_id: str
    agent_epoch: int
    expires_at: str
    token: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Lease":
        required = ("callId", "agentEpoch", "expiresAt", "token")
        if any(not payload.get(key) for key in required):
            raise VoiceApiError("lease response is incomplete")
        return cls(
            call_id=str(payload["callId"]),
            agent_epoch=int(payload["agentEpoch"]),
            expires_at=str(payload["expiresAt"]),
            token=str(payload["token"]),
        )


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
    def __init__(self, base_url: str, *, worker_credential: str, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.worker_credential = worker_credential
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0))
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def claim_lease(self, *, call_id: str, room_name: str, dispatch_id: str, participant_id: str) -> Lease:
        response = await self._request("POST",
            f"{self.base_url}/leases/claim",
            headers={"Authorization": f"Bearer {self.worker_credential}"},
            json={"callId": call_id, "roomName": room_name, "dispatchId": dispatch_id, "participantId": participant_id},
        )
        if response.status_code == 503 and self._json(response).get("error") == "DISPATCH_PENDING":
            raise DispatchPending("provider dispatch binding is pending")
        if response.status_code != 200:
            raise VoiceApiError(f"lease claim failed with HTTP {response.status_code}")
        return Lease.from_payload(self._json(response))

    async def context(self, lease: Lease) -> CallContext:
        response = await self._request("GET",
            f"{self.base_url}/calls/{lease.call_id}/context",
            headers={"Authorization": f"Bearer {lease.token}"},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"context fetch failed with HTTP {response.status_code}")
        context = CallContext.from_payload(self._json(response))
        if context.call_id != lease.call_id or context.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("context does not match the active lease")
        return context

    async def renew(self, lease: Lease) -> Lease:
        response = await self._request("POST",
            f"{self.base_url}/calls/{lease.call_id}/lease/renew",
            headers={"Authorization": f"Bearer {lease.token}"},
            json={"agentEpoch": lease.agent_epoch},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"lease renew failed with HTTP {response.status_code}")
        renewed = Lease.from_payload(self._json(response))
        if renewed.call_id != lease.call_id or renewed.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("renewed lease does not match the active call epoch")
        return renewed

    async def publish(self, event: dict[str, Any], lease: Lease) -> str:
        response = await self._request("POST",
            f"{self.base_url}/calls/{lease.call_id}/events",
            headers={"Authorization": f"Bearer {lease.token}"}, json=event,
        )
        if response.status_code != 200:
            raise VoiceApiError(f"event publish failed with HTTP {response.status_code}")
        receipt = self._json(response)
        if receipt.get("eventId") != event.get("eventId") or receipt.get("status") not in {"committed", "duplicate"}:
            raise VoiceApiError("event receipt is invalid")
        return str(receipt["status"])

    def replay_credential(self, lease: Lease) -> ReplayCredential:
        return ReplayCredential(lease.call_id, lease.agent_epoch, lease.token, lease.expires_at)

    async def flush_spool(self, spool: EventSpool) -> int:
        committed = 0
        # Each ready() returns only each stream's head. Requery after every commit
        # so a contiguous ready/final/flushed stream drains without ever jumping it.
        while queued_events := spool.ready():
            queued = queued_events[0]
            try:
                # Every schema-declared lifecycle event is evidence. The API separately
                # constrains historical receipt so this never restores call authority.
                await self.publish(queued.payload, Lease(
                    queued.credential.call_id, queued.credential.agent_epoch,
                    queued.credential.expires_at, queued.credential.token,
                ))
            except (httpx.HTTPError, VoiceApiError):
                spool.retry(queued.event_id)
                break
            spool.acknowledge(queued.event_id)
            committed += 1
        return committed

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One bounded deadline and bounded response body for every worker API request."""
        try:
            async with asyncio.timeout(12):
                async with self._client.stream(method, url, **kwargs) as response:
                    if response.is_stream_consumed:  # MockTransport JSON/content response
                        body = response.content
                        if len(body) > 65_536:
                            raise VoiceApiError("internal voice API response exceeds 64 KiB")
                    else:
                        chunks: list[bytes] = []
                        size = 0
                        async for chunk in response.aiter_raw():
                            size += len(chunk)
                            if size > 65_536:
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

    async def invoke_tool(self, lease: Lease, *, invocation_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            async with asyncio.timeout(12):
                response = await self._request("POST",
                    f"{self.base_url}/calls/{lease.call_id}/tools",
                    headers={"Authorization": f"Bearer {lease.token}"},
                    json={"invocationId": invocation_id, "agentEpoch": lease.agent_epoch, "name": name, "arguments": arguments},
                )
        except (TimeoutError, httpx.HTTPError, VoiceApiError):
            return await self.tool_receipt(lease, invocation_id)
        if response.status_code != 200:
            raise VoiceApiError(f"tool invocation failed with HTTP {response.status_code}")
        return self._json(response)

    def record_tool_intent(self, spool: EventSpool, lease: Lease, *, logical_id: str, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        return spool.tool_intent(call_id=lease.call_id, agent_epoch=lease.agent_epoch, logical_id=logical_id, name=name, arguments=arguments)

    async def tool_receipt(self, lease: Lease, invocation_id: str) -> dict[str, Any]:
        response = await self._request("GET",
            f"{self.base_url}/calls/{lease.call_id}/tools/{invocation_id}",
            headers={"Authorization": f"Bearer {lease.token}"},
        )
        if response.status_code != 200:
            raise VoiceApiError("tool outcome is uncertain; no new request will be made")
        return self._json(response)


class ReplayDrainer:
    """Independent bounded replay loop; event creation never waits for the API."""

    def __init__(self, client: VoiceApiClient, spool: EventSpool, *, interval_seconds: float = 1.0) -> None:
        self.client, self.spool, self.interval_seconds = client, spool, interval_seconds
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

    async def _run(self) -> None:
        while not self._stopping.is_set():
            await self.client.flush_spool(self.spool)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                pass
