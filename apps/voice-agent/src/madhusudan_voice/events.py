"""Durable worker event construction, with monotonic sequence numbers per lease epoch."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from .api import Lease, VoiceApiClient
from .spool import EventSpool


class EventWriter:
    def __init__(self, spool: EventSpool, client: VoiceApiClient, lease: Lease) -> None:
        self.spool = spool
        self.client = client
        self.lease = lease
        self._source_sequence = 0

    async def emit(self, event_type: str, payload: dict[str, Any]) -> str:
        self._source_sequence = self.spool.next_sequence(
            call_id=self.lease.call_id, agent_epoch=self.lease.agent_epoch
        )
        event_id = str(uuid4())
        event = {
            "schemaVersion": 1,
            "eventId": event_id,
            "callId": self.lease.call_id,
            "agentEpoch": self.lease.agent_epoch,
            "sourceSequence": self._source_sequence,
            "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "type": event_type,
            "payload": payload,
        }
        # Persistence precedes every delivery attempt. Payloads contain only event metadata/text,
        # never audio bytes or HTTP headers.
        self.spool.enqueue(
            event_id=event_id,
            call_id=self.lease.call_id,
            payload=event,
            credential=self.client.replay_credential(self.lease),
        )
        return event_id

    @property
    def last_source_sequence(self) -> int:
        return self._source_sequence

    async def emit_agent_transcript(self, *, text: str, language: str) -> str:
        if not text.strip() or len(text) > 4000:
            raise ValueError("agent transcript text must be non-empty and at most 4000 characters")
        return await self.emit(
            "transcript.final",
            {
                "segmentId": f"agent:{self.lease.agent_epoch}:{self._source_sequence + 1}",
                "revision": 1,
                "speaker": "AGENT",
                "participantId": None,
                "sequence": self._source_sequence + 1,
                "text": text,
                "language": language,
            },
        )

    async def emit_final_transcript(
        self,
        *,
        segment_id: str,
        revision: int,
        participant_id: str,
        sequence: int,
        text: str,
        language: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> str:
        """Persist only a final caller segment; interim captions are intentionally excluded."""
        if not text.strip() or len(text) > 4000:
            raise ValueError("final transcript text must be non-empty and at most 4000 characters")
        if revision < 1 or sequence < 1:
            raise ValueError("final transcript revision and sequence must be positive")
        return await self.emit(
            "transcript.final",
            {
                "segmentId": segment_id,
                "revision": revision,
                "speaker": "CALLER",
                "participantId": participant_id,
                "sequence": sequence,
                "text": text,
                "startMs": start_ms,
                "endMs": end_ms,
                "language": language,
            },
        )

    def update_lease(self, lease: Lease) -> None:
        if lease.call_id != self.lease.call_id or lease.agent_epoch != self.lease.agent_epoch:
            raise ValueError("cannot change an event writer to another call epoch")
        self.lease = lease
