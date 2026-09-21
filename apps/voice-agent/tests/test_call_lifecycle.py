"""The real AgentServer call entrypoint, driven with fake HTTP, session and job context."""

from datetime import UTC, datetime, timedelta

import pytest

from fake_voice_api import FakeCtx, FakeSession, FakeVoiceApi, install_runtime


def committed_types(api: FakeVoiceApi) -> list[str]:
    return [f"{event['type']}:{event['payload'].get('code', '')}".rstrip(":") for event in api.calls["call-1"].committed]


def assert_released(runtime) -> None:
    assert all(drainer.stopped for drainer in runtime.drainers)
    assert all(spool.closed for spool in runtime.spools)
    assert all(client.closed for client in runtime.clients)
    assert runtime.runtimes == {}


@pytest.mark.asyncio
async def test_a_refused_claim_releases_everything_it_opened(tmp_path, monkeypatch):
    api = FakeVoiceApi()
    api.add_call(dispatch_id="another-dispatch")
    runtime = install_runtime(monkeypatch, tmp_path, api)
    with pytest.raises(Exception):
        await runtime.entry(FakeCtx())
    assert_released(runtime)
    assert runtime.sessions == []


@pytest.mark.asyncio
async def test_a_failed_session_start_is_reported_as_fatal(tmp_path, monkeypatch):
    api = FakeVoiceApi()
    api.add_call()
    runtime = install_runtime(monkeypatch, tmp_path, api, session_factory=lambda: FakeSession(start_error=RuntimeError("provider refused")))
    with pytest.raises(RuntimeError, match="provider refused"):
        await runtime.entry(FakeCtx())
    assert committed_types(api) == ["agent.ready", "agent.failed:FATAL", "transcript.flushed"]
    assert_released(runtime)


@pytest.mark.asyncio
async def test_a_lapsed_claim_never_starts_a_speaking_session(tmp_path, monkeypatch):
    api = FakeVoiceApi()
    api.add_call()
    api.report_offset = timedelta(seconds=-40)  # worker clock 40 s ahead of the server
    runtime = install_runtime(monkeypatch, tmp_path, api)
    ctx = FakeCtx()
    await runtime.entry(ctx)
    assert runtime.sessions == []
    assert ctx.shutdown_reasons == ["voice authority ended: LEASE_LOST"]
    assert committed_types(api) == ["agent.ready", "agent.failed:LEASE_LOST", "transcript.flushed"]
    assert_released(runtime)


@pytest.mark.asyncio
async def test_a_fence_ends_the_job_and_records_its_cause_at_that_moment(tmp_path, monkeypatch):
    api = FakeVoiceApi()
    api.add_call()
    runtime = install_runtime(monkeypatch, tmp_path, api)
    ctx = FakeCtx()
    await runtime.entry(ctx)
    session = runtime.sessions[0]
    assert session.running
    call_runtime = runtime.runtimes["job-1"]
    fenced_at = datetime.now(UTC)
    call_runtime.guard.fail_closed("TRANSIENT")
    assert session.shutdowns == [False], "the session is closed without waiting for it"
    assert "voice authority ended: TRANSIENT" in ctx.shutdown_reasons
    await runtime.finalize(ctx)
    assert committed_types(api) == ["agent.ready", "agent.failed:TRANSIENT", "transcript.flushed"]
    failure = api.calls["call-1"].committed[1]
    occurred = datetime.fromisoformat(failure["occurredAt"].replace("Z", "+00:00"))
    assert occurred - fenced_at < timedelta(seconds=1), "failure evidence is stamped at the fence, not at shutdown"
    assert_released(runtime)


@pytest.mark.asyncio
async def test_a_caller_hangup_ends_the_job_and_checkpoints_evidence(tmp_path, monkeypatch):
    api = FakeVoiceApi()
    api.add_call()
    runtime = install_runtime(monkeypatch, tmp_path, api)
    ctx = FakeCtx()
    await runtime.entry(ctx)
    runtime.sessions[0].shutdown(drain=True)  # what close_on_disconnect does when the caller leaves
    assert ctx.shutdown_reasons == ["voice session closed"]
    await runtime.finalize(ctx)
    assert committed_types(api) == ["agent.ready", "transcript.flushed"]
    assert_released(runtime)
