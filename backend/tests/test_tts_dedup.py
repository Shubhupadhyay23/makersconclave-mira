"""Tests for TTS deduplication — fire-and-forget tool loop prevention + model selection.

Validates three fixes that prevent TTS audio cutoff:
1. _handle_tool_calls skips re-calling Claude after fire-and-forget tools
2. _select_model always returns Sonnet with 2048 max_tokens
3. Mixed tool batches (fire-and-forget + data-returning) still re-call Claude
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from agent.orchestrator import MiraOrchestrator, SessionState, SONNET_MODEL


def _make_orchestrator() -> MiraOrchestrator:
    """Create an orchestrator with mocked Socket.io."""
    return MiraOrchestrator(socket_io=AsyncMock())


def _make_session(history: list | None = None) -> SessionState:
    """Create a session with pre-populated conversation history."""
    session = SessionState(user_id="test-user")
    session.conversation_history = list(history) if history else []
    session.system_prompt = "You are a test assistant."
    return session


def _make_tool_use_block(**kwargs):
    """Create a SimpleNamespace mimicking an Anthropic SDK tool_use content block."""
    defaults = {"type": "tool_use", "id": "tu_001", "name": "search_clothing", "input": {}}
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


# ---------------------------------------------------------------------------
# Change 1: Fire-and-forget tools skip re-calling Claude
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_voice_skips_claude_recall():
    """send_voice_to_client is fire-and-forget — should NOT re-call Claude."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
        {
            "role": "assistant",
            "content": [
                SimpleNamespace(type="text", text="Hey there!"),
                _make_tool_use_block(id="tu_voice", name="send_voice_to_client", input={"text": "Hey there!"}),
            ],
        },
    ])

    tool_uses = [_make_tool_use_block(id="tu_voice", name="send_voice_to_client", input={"text": "Hey there!"})]

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, return_value={"sent": True}):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock) as mock_call:
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    mock_call.assert_not_called()


@pytest.mark.asyncio
async def test_data_returning_tool_triggers_claude_recall():
    """Tools like display_product return data Claude needs — should re-call Claude."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Show me jackets"},
        {
            "role": "assistant",
            "content": [_make_tool_use_block(id="tu_display", name="display_product")],
        },
    ])

    tool_uses = [_make_tool_use_block(id="tu_display", name="display_product", input={"items": []})]
    mock_result = {"items": [{"title": "Jacket", "price": "$50"}], "frontend_payload": {"type": "display_product", "items": []}}

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, return_value=mock_result):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock) as mock_call:
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    mock_call.assert_called_once_with(session, tool_depth=1)


@pytest.mark.asyncio
async def test_mixed_tools_still_recall_claude():
    """When fire-and-forget AND data-returning tools are called together,
    Claude must still be re-called (the data tool needs processing)."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Show me something"},
        {
            "role": "assistant",
            "content": [
                _make_tool_use_block(id="tu_voice", name="send_voice_to_client"),
                _make_tool_use_block(id="tu_display", name="display_product"),
            ],
        },
    ])

    tool_uses = [
        _make_tool_use_block(id="tu_voice", name="send_voice_to_client", input={"text": "Check this out"}),
        _make_tool_use_block(id="tu_display", name="display_product", input={"items": []}),
    ]

    async def mock_execute(tool_name, tool_input, user_context):
        if tool_name == "send_voice_to_client":
            return {"sent": True}
        return {"items": [], "frontend_payload": {"type": "display_product", "items": []}}

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, side_effect=mock_execute):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock) as mock_call:
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    mock_call.assert_called_once_with(session, tool_depth=1)


@pytest.mark.asyncio
async def test_tool_results_appended_even_when_skipping_recall():
    """Even when skipping the Claude re-call, tool results must still be
    appended to conversation history (keeps the tool_use/tool_result pairing valid)."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hi"},
        {
            "role": "assistant",
            "content": [_make_tool_use_block(id="tu_voice", name="send_voice_to_client")],
        },
    ])

    tool_uses = [_make_tool_use_block(id="tu_voice", name="send_voice_to_client", input={"text": "Hi!"})]

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, return_value={"sent": True}):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock):
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    # Tool result message should be the last entry in history
    last_msg = session.conversation_history[-1]
    assert last_msg["role"] == "user"
    assert isinstance(last_msg["content"], list)
    assert last_msg["content"][0]["type"] == "tool_result"
    assert last_msg["content"][0]["tool_use_id"] == "tu_voice"


# ---------------------------------------------------------------------------
# Change 2: _select_model always returns Sonnet with 2048 max_tokens
# ---------------------------------------------------------------------------


def test_select_model_returns_sonnet_for_conversational_turn():
    """Conversational turns should use Sonnet with 2048 tokens."""
    orch = _make_orchestrator()
    session = _make_session([{"role": "user", "content": "What should I wear?"}])

    model, max_tokens = orch._select_model(session)

    assert model == SONNET_MODEL
    assert max_tokens == 2048


def test_select_model_returns_sonnet_for_tool_result_turn():
    """Tool-result turns should ALSO use Sonnet (no more Haiku downgrade)."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Show me jackets"},
        {
            "role": "assistant",
            "content": [_make_tool_use_block()],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tu_001", "content": "{}"}],
        },
    ])

    model, max_tokens = orch._select_model(session)

    assert model == SONNET_MODEL
    assert max_tokens == 2048


def test_select_model_returns_sonnet_for_empty_history():
    """Empty history (session start) should use Sonnet."""
    orch = _make_orchestrator()
    session = _make_session([])

    model, max_tokens = orch._select_model(session)

    assert model == SONNET_MODEL
    assert max_tokens == 2048


# ---------------------------------------------------------------------------
# Change 3: Frontend payload emission still works for non-voice tools
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_frontend_payload_emitted_for_display_product():
    """display_product frontend_payload should still be emitted via Socket.io
    (only voice_message was removed from the frontend handler)."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Show me outfits"},
        {
            "role": "assistant",
            "content": [_make_tool_use_block(id="tu_dp", name="display_product")],
        },
    ])

    tool_uses = [_make_tool_use_block(id="tu_dp", name="display_product", input={"items": []})]
    payload = {"type": "display_product", "items": [{"title": "Jacket"}]}
    mock_result = {"items": [{"title": "Jacket"}], "frontend_payload": payload}

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, return_value=mock_result):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock):
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    orch.sio.emit.assert_called_once_with("tool_result", payload, room="test-user")


@pytest.mark.asyncio
async def test_voice_tool_frontend_payload_still_emitted():
    """send_voice_to_client may still emit a frontend_payload — the backend
    doesn't filter it. The dedup fix is on the frontend side (mirror/page.tsx
    ignores voice_message type)."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hi"},
        {
            "role": "assistant",
            "content": [_make_tool_use_block(id="tu_v", name="send_voice_to_client")],
        },
    ])

    tool_uses = [_make_tool_use_block(id="tu_v", name="send_voice_to_client", input={"text": "Hey!"})]
    payload = {"type": "voice_message", "text": "Hey!"}
    mock_result = {"sent": True, "frontend_payload": payload}

    with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock, return_value=mock_result):
        with patch.object(orch, "_call_claude", new_callable=AsyncMock):
            await orch._handle_tool_calls(session, tool_uses, tool_depth=0)

    # Backend still emits the payload — frontend just ignores voice_message type now
    orch.sio.emit.assert_called_once_with("tool_result", payload, room="test-user")
