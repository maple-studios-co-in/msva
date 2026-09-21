"""The business tool inside a real livekit-agents AgentSession (text mode, scripted LLM, no network)."""

import asyncio
import json
import time

import pytest
from livekit.agents import AgentSession, llm
from livekit.agents.llm import ChatChunk, ChoiceDelta, FunctionToolCall, ToolError
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN

from madhusudan_voice.api import VoiceApiClient
from madhusudan_voice.events import EventWriter
from madhusudan_voice.session import LeaseGuard, MadhusudanAgent
from madhusudan_voice.spool import EventSpool

from fake_voice_api import BASE, KEY, FakeVoiceApi, agent_identity, wait_until


class ScriptedStream(llm.LLMStream):
    def __init__(self, owner, *, chat_ctx, tools, conn_options, chunks):
        super().__init__(owner, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._chunks = chunks

    async def _run(self) -> None:
        for chunk in self._chunks:
            self._event_ch.send_nowait(chunk)


class ScriptedLLM(llm.LLM):
    def __init__(self, scripts):
        super().__init__()
        self.scripts = scripts
        self.calls = 0

    def chat(self, *, chat_ctx, tools=None, conn_options=DEFAULT_API_CONNECT_OPTIONS,
             parallel_tool_calls=NOT_GIVEN, tool_choice=NOT_GIVEN, extra_kwargs=NOT_GIVEN):
        chunks = self.scripts[min(self.calls, len(self.scripts) - 1)]
        self.calls += 1
        return ScriptedStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options, chunks=chunks)


def tool_call(call_id: str, description: str) -> list[ChatChunk]:
    return [ChatChunk(id="c", delta=ChoiceDelta(role="assistant", tool_calls=[FunctionToolCall(
        name="create_business_request", arguments=json.dumps({"request": {"description": description}}), call_id=call_id)]))]


def text(value: str) -> list[ChatChunk]:
    return [ChatChunk(id="x", delta=ChoiceDelta(role="assistant", content=value))]


async def start_call(tmp_path, scripts, tool_mode, *, close_on_fence=True):
    api = FakeVoiceApi()
    api.add_call()
    api.tool_mode = tool_mode
    client = VoiceApiClient(BASE, worker_credential="worker-token", client=api.client())
    lease = await client.claim_lease(call_id="call-1", room_name="room-1", dispatch_id="dispatch-xyz", participant_id=agent_identity("call-1"))
    context = await client.context(lease)
    spool = EventSpool(tmp_path / "spool.sqlite3", max_events=100, max_bytes=1_000_000, replay_key=KEY)
    writer = EventWriter(spool, client, lease, agent_participant_id=context.agent_participant_id)
    session = AgentSession(llm=ScriptedLLM(scripts))
    closed = asyncio.Event()
    session.on("close", lambda _event: closed.set())
    # The same non-blocking fence main.run_call installs.
    on_lost = (lambda _code: session.shutdown(drain=False)) if close_on_fence else None
    guard = LeaseGuard(client, writer, renew_seconds=10, lease_seconds=30, on_lost=on_lost)
    guard.start()
    await session.start(MadhusudanAgent(client, guard, context))
    return api, session, guard, closed, spool


@pytest.mark.asyncio
async def test_an_uncertain_outcome_fences_and_closes_the_session_promptly(tmp_path):
    api, session, guard, closed, spool = await start_call(tmp_path, [tool_call("toolu_A", "milk was spoiled"), text("Recorded.")], "timeout_no_receipt")
    started = time.monotonic()
    session.run(user_input="please record my complaint")
    await asyncio.wait_for(closed.wait(), timeout=5)
    assert time.monotonic() - started < 2.0, "the fence must not wait for the tool it runs inside"
    assert guard.lost and guard.failure == "TRANSIENT"
    assert len(api.tool_posts) == 1
    failures = [json.loads(row[0]) for row in spool._connection.execute("SELECT payload FROM event_spool").fetchall()]
    assert [event["payload"] for event in failures if event["type"] == "agent.failed"] == [{"code": "TRANSIENT"}]


@pytest.mark.asyncio
async def test_nothing_is_said_after_a_fence_even_before_the_session_closes(tmp_path):
    # The SDK asks the model for a reply after every tool call; that reply must not depend on
    # the session closing first.
    api, session, guard, closed, _spool = await start_call(tmp_path, [tool_call("toolu_A", "milk was spoiled"), text("Recorded.")], "timeout_no_receipt", close_on_fence=False)
    await session.run(user_input="please record my complaint")
    assert guard.lost and not closed.is_set()
    replies = [item.text_content for item in session.history.items if getattr(item, "role", None) == "assistant"]
    assert replies == [], "no reply may be generated once authority has ended"
    await guard.stop()
    await session.aclose()


@pytest.mark.asyncio
async def test_a_definite_rejection_goes_back_to_the_model_without_ending_the_call(tmp_path):
    api, session, guard, closed, _spool = await start_call(tmp_path, [tool_call("toolu_A", "follow up on nothing"), text("That could not be recorded.")], "reject")
    result = session.run(user_input="please record my complaint")
    await result
    assert not guard.lost and guard.active
    assert not closed.is_set()
    assert len(api.tool_posts) == 1
    outputs = [item for item in session.history.items if getattr(item, "type", None) == "function_call_output"]
    assert outputs and outputs[0].is_error
    # The call's own intent is remembered, so finishing the call releases exactly it.
    assert guard.writer.tool_intents == {api.tool_posts[0]["invocationId"]}
    await guard.stop()
    await session.aclose()


@pytest.mark.asyncio
async def test_a_call_at_its_request_limit_tells_the_model_to_stop_recording(tmp_path):
    api, session, guard, closed, _spool = await start_call(tmp_path, [tool_call("toolu_A", "one more complaint"), text("Staff will follow up.")], "limit")
    await session.run(user_input="please record one more complaint")
    assert not guard.lost and not closed.is_set()
    outputs = [item for item in session.history.items if getattr(item, "type", None) == "function_call_output"]
    assert outputs and outputs[0].is_error
    assert outputs[0].output.startswith("No more requests can be recorded on this call")
    await guard.stop()
    await session.aclose()


@pytest.mark.asyncio
async def test_no_new_request_can_follow_an_uncertain_one(tmp_path):
    api, session, guard, closed, _spool = await start_call(tmp_path, [tool_call("toolu_A", "milk was spoiled"), text("ok")], "timeout_no_receipt")
    session.run(user_input="please record my complaint")
    await wait_until(lambda: guard.lost, timeout=5)
    fake_ctx = type("Ctx", (), {"function_call": type("Call", (), {"call_id": "toolu_B"})()})()
    with pytest.raises(ToolError):
        await session.current_agent.create_business_request({"request": {"description": "same complaint, reworded"}}, fake_ctx)
    assert len(api.tool_posts) == 1
