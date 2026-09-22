"""Durable worker event construction, with monotonic sequence numbers per lease epoch."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from .api import Lease, VoiceApiClient
from .spool import EventSpool


class EventWriter:
    def __init__(self, spool: EventSpool, client: VoiceApiClient, lease: Lease, *, agent_participant_id: str | None = None) -> None:
        self.spool = spool
        self.client = client
        self.lease = lease
        self._source_sequence = 0
        self.agent_participant_id = agent_participant_id
        # Set once an event could not be stored: the stream has a gap from then on.
        self.evidence_lost = False
        # Invocation IDs of the tool intents this call recorded. Another job can share the
        # call and epoch (a re-claim returns the same lease), so only these are released.
        self.tool_intents: set[str] = set()

    async def emit(self, event_type: str, payload: dict[str, Any]) -> str:
        return self.append(event_type, payload)

    def append(self, event_type: str, payload: dict[str, Any]) -> str:
        """Persist one event now, stamped with the current time; delivery happens later."""
        event_id = str(uuid4())
        def build(source_sequence: int) -> dict[str, Any]:
            return {"schemaVersion": 1, "eventId": event_id, "callId": self.lease.call_id,
                "agentEpoch": self.lease.agent_epoch, "sourceSequence": source_sequence,
                "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"), "type": event_type, "payload": payload}
        # Persistence precedes every delivery attempt. Payloads contain only event metadata/text,
        # never audio bytes or HTTP headers.
        try:
            _, self._source_sequence = self.spool.append_event(call_id=self.lease.call_id, agent_epoch=self.lease.agent_epoch,
                credential=self.client.replay_credential(self.lease), build=build)
        except Exception:
            self.evidence_lost = True
            raise
        return event_id

    def record_failure(self, code: str) -> str:
        """Failure evidence is written when authority ends, not at shutdown: the API only
        accepts it within seconds of the lease cutoff."""
        return self.append("agent.failed", {"code": code})

    def record_flush(self) -> str | None:
        """Checkpoint exactly the prefix persisted so far. There is nothing to checkpoint
        before ready, and no checkpoint once an event was lost: the API would take the
        stream for complete when words are missing from it."""
        if self._source_sequence < 1 or self.evidence_lost:
            return None
        return self.append("transcript.flushed", {"lastSourceSequence": self._source_sequence})

    @property
    def last_source_sequence(self) -> int:
        return self._source_sequence

    async def emit_agent_transcript(self, *, text: str, language: str, segment_id: str | None = None, sequence: int = 0) -> str:
        if not text.strip() or len(text) > 4000:
            raise ValueError("agent transcript text must be non-empty and at most 4000 characters")
        segment_id = segment_id or f"agent:{self.lease.agent_epoch}:{self._source_sequence + 1}"
        stable_sequence = self.spool.segment_sequence(call_id=self.lease.call_id, agent_epoch=self.lease.agent_epoch, segment_id=segment_id)
        return await self.emit(
            "transcript.final",
            {
                "segmentId": segment_id,
                "revision": 1,
                "speaker": "AGENT",
                "participantId": self.agent_participant_id or "unbound-agent",
                "sequence": stable_sequence,
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
        stable_sequence = self.spool.segment_sequence(call_id=self.lease.call_id, agent_epoch=self.lease.agent_epoch, segment_id=segment_id)
        return await self.emit(
            "transcript.final",
            {
                "segmentId": segment_id,
                "revision": revision,
                "speaker": "CALLER",
                "participantId": participant_id,
                "sequence": stable_sequence,
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
