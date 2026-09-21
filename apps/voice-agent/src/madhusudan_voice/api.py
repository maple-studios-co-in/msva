"""The narrow authenticated HTTP boundary to the MSVA service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from .spool import EventSpool


class VoiceApiError(RuntimeError):
    pass


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
        response = await self._client.post(
            f"{self.base_url}/leases/claim",
            headers={"Authorization": f"Bearer {self.worker_credential}"},
            json={"callId": call_id, "roomName": room_name, "dispatchId": dispatch_id, "participantId": participant_id},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"lease claim failed with HTTP {response.status_code}")
        return Lease.from_payload(response.json())

    async def context(self, lease: Lease) -> CallContext:
        response = await self._client.get(
            f"{self.base_url}/calls/{lease.call_id}/context",
            headers={"Authorization": f"Bearer {lease.token}"},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"context fetch failed with HTTP {response.status_code}")
        context = CallContext.from_payload(response.json())
        if context.call_id != lease.call_id or context.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("context does not match the active lease")
        return context

    async def renew(self, lease: Lease) -> Lease:
        response = await self._client.post(
            f"{self.base_url}/calls/{lease.call_id}/lease/renew",
            headers={"Authorization": f"Bearer {lease.token}"},
            json={"agentEpoch": lease.agent_epoch},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"lease renew failed with HTTP {response.status_code}")
        renewed = Lease.from_payload(response.json())
        if renewed.call_id != lease.call_id or renewed.agent_epoch != lease.agent_epoch:
            raise VoiceApiError("renewed lease does not match the active call epoch")
        return renewed

    async def publish(self, event: dict[str, Any], lease: Lease) -> str:
        response = await self._client.post(
            f"{self.base_url}/calls/{lease.call_id}/events",
            headers={"Authorization": f"Bearer {lease.token}"}, json=event,
        )
        if response.status_code != 200:
            raise VoiceApiError(f"event publish failed with HTTP {response.status_code}")
        receipt = response.json()
        if receipt.get("eventId") != event.get("eventId") or receipt.get("status") not in {"committed", "duplicate"}:
            raise VoiceApiError("event receipt is invalid")
        return str(receipt["status"])

    async def flush_spool(self, spool: EventSpool, lease: Lease) -> int:
        committed = 0
        for queued in spool.ready():
            try:
                await self.publish(queued.payload, lease)
            except (httpx.HTTPError, VoiceApiError):
                spool.retry(queued.event_id)
                continue
            spool.acknowledge(queued.event_id)
            committed += 1
        return committed

    async def invoke_tool(self, lease: Lease, *, invocation_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(
            f"{self.base_url}/calls/{lease.call_id}/tools",
            headers={"Authorization": f"Bearer {lease.token}"},
            json={"invocationId": invocation_id, "agentEpoch": lease.agent_epoch, "name": name, "arguments": arguments},
        )
        if response.status_code != 200:
            raise VoiceApiError(f"tool invocation failed with HTTP {response.status_code}")
        return response.json()
