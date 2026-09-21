import asyncio

import pytest

from madhusudan_voice.api import VoiceApiError
from madhusudan_voice.session import LeaseGuard

from fake_voice_api import lease_expiring_in, wait_until


class Writer:
    def __init__(self, lease) -> None:
        self.lease = lease
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
async def test_a_permanent_renewal_refusal_fences_at_once():
    writer = Writer(lease_expiring_in(30))
    fenced: list[str] = []
    api = Api(VoiceApiError("taken over", status=409, code="SESSION_UNAVAILABLE"))
    guard = LeaseGuard(api, writer, renew_seconds=0.02, lease_seconds=30, on_lost=fenced.append)
    guard.start()
    await wait_until(lambda: bool(fenced))
    assert fenced == ["LEASE_LOST"] and writer.failures == ["LEASE_LOST"]
    assert guard.remaining > 25, "fenced by the refusal, not by waiting for expiry"
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
