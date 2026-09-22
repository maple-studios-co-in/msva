import asyncio
import time
from collections.abc import Callable

import pytest

from madhusudan_voice.api import VoiceApiError
from madhusudan_voice.session import LeaseGuard, OutageLog

from fake_voice_api import lease_expiring_in, wait_until


class Spool:
    def __init__(self) -> None:
        self.fault: str | None = None
        # How long the oldest undelivered event has waited: a value, or a function of time.
        self.waiting: float | Callable[[], float] = 0.0

    def stream_fault(self, call_id: str, agent_epoch: int) -> str | None:
        return self.fault

    def waiting_seconds(self, call_id: str, agent_epoch: int) -> float:
        return self.waiting() if callable(self.waiting) else self.waiting


class Writer:
    def __init__(self, lease) -> None:
        self.lease = lease
        self.spool = Spool()
        self.failures: list[str] = []

    def record_failure(self, code: str) -> None:
        self.failures.append(code)

    def update_lease(self, lease) -> None:
        self.lease = lease


class Api:
    def __init__(self, *responses) -> None:
        self.responses = list(responses)
        self.calls = 0

    async def renew(self, lease):
        self.calls += 1
        response = self.responses.pop(0) if self.responses else lease_expiring_in(30)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.mark.asyncio
async def test_an_already_lapsed_claim_never_grants_authority():
    writer = Writer(lease_expiring_in(-1))
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=10, lease_seconds=30, on_lost=fenced.append)
    assert guard.start() is False
    assert guard.lost and not guard.active
    assert fenced == ["LEASE_LOST"] and writer.failures == ["LEASE_LOST"]


@pytest.mark.asyncio
async def test_a_reported_expiry_longer_than_the_lease_is_not_trusted():
    # A server (or clock) reporting three days of lease still grants at most the configured lease.
    guard = LeaseGuard(Api(), Writer(lease_expiring_in(3 * 24 * 3600)), renew_seconds=10, lease_seconds=30)
    assert 29 < guard.remaining <= 30


@pytest.mark.asyncio
async def test_a_worker_clock_behind_the_server_cannot_extend_authority():
    # Wall clock 20 s behind: the lease looks 50 s long locally but is capped at 30 s.
    guard = LeaseGuard(Api(), Writer(lease_expiring_in(30, wall_skew=-20)), renew_seconds=10, lease_seconds=30)
    assert guard.remaining <= 30


@pytest.mark.asyncio
@pytest.mark.parametrize("refusal", [
    VoiceApiError("taken over", status=409, code="SESSION_UNAVAILABLE"),
    VoiceApiError("ended", status=409, code="LEASE_EXPIRED"),
    VoiceApiError("voice switched off", status=503, code="VOICE_DISABLED"),
    VoiceApiError("unknown credential", status=401, code="LEASE_INVALID"),
])
async def test_authority_the_api_withdrew_is_fenced_at_once_without_a_failure_event(refusal):
    # The API ended the call first; a failure stamped after its cutoff would be refused
    # and would stop the stream before its checkpoint.
    writer = Writer(lease_expiring_in(30))
    fenced: list[str] = []
    guard = LeaseGuard(Api(refusal), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append)
    guard.start()
    await wait_until(lambda: bool(fenced))
    assert fenced == ["LEASE_LOST"] and writer.failures == []
    assert guard.remaining > 25, "fenced by the refusal, not by waiting for expiry"
    await guard.stop()


@pytest.mark.asyncio
async def test_any_other_permanent_renewal_refusal_fences_and_is_recorded():
    writer = Writer(lease_expiring_in(30))
    fenced: list[str] = []
    guard = LeaseGuard(Api(VoiceApiError("bad renewal", status=400, code="INVALID_REQUEST")), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append)
    guard.start()
    await wait_until(lambda: bool(fenced))
    assert fenced == ["LEASE_LOST"] and writer.failures == ["LEASE_LOST"]
    await guard.stop()


@pytest.mark.asyncio
async def test_a_short_lease_is_renewed_before_it_lapses():
    # A re-claim can return a lease with less time left than the renewal interval.
    writer = Writer(lease_expiring_in(2))
    fenced: list[str] = []
    api = Api(lease_expiring_in(30))
    guard = LeaseGuard(api, writer, renew_seconds=10, lease_seconds=30, on_lost=fenced.append)
    guard.start()
    await wait_until(lambda: api.calls >= 1)
    await asyncio.sleep(0.05)
    assert fenced == [] and guard.active and guard.remaining > 25
    await guard.stop()


@pytest.mark.asyncio
async def test_a_stopped_evidence_stream_ends_authority():
    writer = Writer(lease_expiring_in(30))
    writer.spool.fault = "HTTP_409:EVENT_CAPACITY"
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append)
    guard.start()
    await wait_until(lambda: bool(fenced))
    assert fenced == ["FATAL"] and writer.failures == [] and not guard.active
    await guard.stop()


@pytest.mark.asyncio
async def test_evidence_that_stops_moving_ends_authority():
    # The companion is down, or a proxy refuses the events: the API hears nothing of the call.
    writer = Writer(lease_expiring_in(30))
    writer.spool.waiting = 1.0
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await wait_until(lambda: bool(fenced))
    # Recorded: the failure waits behind the rest of the stream and arrives with it.
    assert fenced == ["FATAL"] and writer.failures == ["FATAL"] and not guard.active
    await guard.stop()


@pytest.mark.asyncio
async def test_evidence_held_up_by_an_api_outage_does_not_end_authority():
    # While renewals fail the lease bounds the call; once the API is back, delivery gets
    # the whole allowance to catch up before the call is judged stuck.
    writer = Writer(lease_expiring_in(30))
    started = time.monotonic()
    # Everything stored since the outage began is waiting for the API.
    writer.spool.waiting = lambda: time.monotonic() - started
    api = Api(*[VoiceApiError("unavailable", status=503)] * 30)
    guard = LeaseGuard(api, writer, renew_seconds=0.02, retry_seconds=0.02, lease_seconds=30, stall_seconds=0.5)
    guard.start()
    await wait_until(lambda: api.calls >= 31)
    await asyncio.sleep(0.1)
    writer.spool.waiting = 0.0
    await asyncio.sleep(0.4)
    assert guard.active and writer.failures == []
    await guard.stop()


@pytest.mark.asyncio
async def test_an_earlier_outage_does_not_excuse_evidence_stuck_later():
    writer = Writer(lease_expiring_in(30))
    api = Api(*[VoiceApiError("unavailable", status=503)] * 25)
    fenced: list[str] = []
    guard = LeaseGuard(api, writer, renew_seconds=0.02, retry_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await wait_until(lambda: api.calls >= 26)
    stuck = time.monotonic()
    writer.spool.waiting = lambda: time.monotonic() - stuck
    await wait_until(lambda: bool(fenced))
    # Judged on how long this event has waited, with nothing taken off for the outage before it.
    assert fenced == ["FATAL"] and time.monotonic() - stuck < 0.45
    await guard.stop()


@pytest.mark.asyncio
async def test_intermittent_renewal_failures_do_not_hide_stuck_evidence():
    # One renewal in five failing excuses only the time the API was down.
    writer = Writer(lease_expiring_in(30))
    started = time.monotonic()
    writer.spool.waiting = lambda: time.monotonic() - started
    fenced: list[str] = []
    responses = [VoiceApiError("unavailable", status=503) if turn % 5 == 4 else lease_expiring_in(30) for turn in range(500)]
    api = Api(*responses)
    guard = LeaseGuard(api, writer, renew_seconds=0.02, retry_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await wait_until(lambda: bool(fenced))
    # About a fifth of the wait is excused, so the fence comes at about 0.25 s, after failures.
    assert fenced == ["FATAL"] and writer.failures == ["FATAL"]
    assert api.calls >= 5 and time.monotonic() - started < 0.5
    await guard.stop()


@pytest.mark.asyncio
async def test_evidence_falling_behind_ends_authority_while_some_of_it_still_arrives():
    # Every other check an event was delivered and the wait dips, but the stream falls
    # further behind all the same.
    writer = Writer(lease_expiring_in(30))
    started, reads, last = time.monotonic(), 0, 0.0

    def waiting() -> float:
        nonlocal reads, last
        reads += 1
        last = last - 0.001 if reads % 2 == 0 else 0.9 * (time.monotonic() - started)
        return last

    writer.spool.waiting = waiting
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await wait_until(lambda: bool(fenced))
    assert fenced == ["FATAL"]
    await guard.stop()


@pytest.mark.asyncio
async def test_a_spool_read_failing_now_and_then_does_not_hide_stuck_evidence():
    writer = Writer(lease_expiring_in(30))
    started, reads = time.monotonic(), 0

    def waiting() -> float:
        nonlocal reads
        reads += 1
        if reads % 3:
            raise OSError("database is locked")
        return time.monotonic() - started

    writer.spool.waiting = waiting
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await wait_until(lambda: bool(fenced))
    # Two reads in three fail. The wait keeps counting through them, so the fence comes at
    # about 0.25 s; dropping the time around failed reads would put it near 0.6 s.
    assert fenced == ["FATAL"] and reads >= 3 and time.monotonic() - started < 0.45
    await guard.stop()


@pytest.mark.asyncio
async def test_a_forward_clock_step_does_not_end_authority():
    # Events are delivered as they come; for a moment after the wall clock steps 20 s
    # forward, the event stored just before the step looks 20 s old.
    writer = Writer(lease_expiring_in(30))
    stepped = time.monotonic() + 0.1
    writer.spool.waiting = lambda: 0.05 + (20.0 if stepped <= time.monotonic() < stepped + 0.1 else 0.0)
    api = Api()
    guard = LeaseGuard(api, writer, renew_seconds=0.02, lease_seconds=30, stall_seconds=0.2)
    guard.start()
    await asyncio.sleep(0.4)
    assert api.calls >= 5 and guard.active and writer.failures == []
    await guard.stop()


@pytest.mark.asyncio
async def test_a_head_older_than_the_guard_gets_the_whole_allowance():
    # A call re-claimed on its own lease inherits the first job's undelivered events.
    writer = Writer(lease_expiring_in(30))
    started = time.monotonic()
    writer.spool.waiting = lambda: 20.0 + time.monotonic() - started
    fenced: list[str] = []
    guard = LeaseGuard(Api(), writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append, stall_seconds=0.2)
    guard.start()
    await asyncio.sleep(0.1)
    assert not fenced
    await wait_until(lambda: bool(fenced))
    assert fenced == ["FATAL"] and time.monotonic() - started >= 0.2
    await guard.stop()


def test_the_outage_log_excuses_a_whole_outage_after_a_long_call():
    # Passes every second: renewals succeed for 700 s, then fail for 25 s.
    log = OutageLog(0.0)
    for second in range(1, 727):
        log.record(float(second), reachable=not 700 < second <= 725)
    # An event stored as the outage began has waited 26 s, 1 s of it while the API was up.
    assert log.unreachable == 25.0 and log.unreachable_within(26.0, 726.0) == 25.0
    for second in range(727, 740):
        log.record(float(second), reachable=True)
    # A wait that began after the outage has none of it.
    assert log.unreachable_within(10.0, 739.0) == 0.0


@pytest.mark.asyncio
async def test_evidence_still_within_the_limit_keeps_authority():
    writer = Writer(lease_expiring_in(30))
    writer.spool.waiting = 14.0
    api = Api()
    guard = LeaseGuard(api, writer, renew_seconds=0.02, lease_seconds=30, stall_seconds=15)
    guard.start()
    await wait_until(lambda: api.calls >= 3)
    assert guard.active and writer.failures == []
    await guard.stop()


@pytest.mark.asyncio
async def test_a_transient_renewal_failure_is_retried_without_losing_authority():
    writer = Writer(lease_expiring_in(30))
    fenced: list[str] = []
    renewed = lease_expiring_in(30)
    api = Api(VoiceApiError("unavailable", status=503), renewed)
    guard = LeaseGuard(api, writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append, retry_seconds=0.02)
    guard.start()
    await wait_until(lambda: api.calls >= 2)
    await asyncio.sleep(0.05)
    assert not fenced and guard.active
    assert writer.lease is renewed or api.calls > 2
    await guard.stop()
    assert writer.failures == []


@pytest.mark.asyncio
async def test_the_fence_survives_a_failing_callback_and_failure_record():
    class BrokenWriter(Writer):
        def record_failure(self, code: str) -> None:
            raise RuntimeError("spool full")

    def broken_fence(code: str) -> None:
        raise RuntimeError("session already gone")

    guard = LeaseGuard(Api(), BrokenWriter(lease_expiring_in(30)), renew_seconds=10, lease_seconds=30, on_lost=broken_fence)
    guard.start()
    guard.fail_closed("TRANSIENT")
    guard.fail_closed("FATAL")
    assert guard.lost and guard.failure == "TRANSIENT"
    await guard.stop()
