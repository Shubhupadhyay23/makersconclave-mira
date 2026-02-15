"""Tests for _call_claude error recovery — orphaned tool_use cleanup.

When a Claude API call fails mid-conversation, the error handler must clean up
the conversation history so subsequent calls don't hit permanent 400 errors from
unmatched tool_use/tool_result pairs.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.orchestrator import MiraOrchestrator, SessionState


def _make_orchestrator() -> MiraOrchestrator:
    """Create an orchestrator with mocked Socket.io."""
    orch = MiraOrchestrator(socket_io=AsyncMock())
    return orch


def _make_session(history: list) -> SessionState:
    """Create a session with pre-populated conversation history."""
    session = SessionState(user_id="test-user")
    session.conversation_history = list(history)
    session.system_prompt = "You are a test assistant."
    return session


def _make_tool_use_block(**kwargs):
    """Create a SimpleNamespace mimicking an Anthropic SDK tool_use content block."""
    defaults = {"type": "tool_use", "id": "tu_123", "name": "search_clothing", "input": {}}
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _make_text_block(text="Hello"):
    """Create a SimpleNamespace mimicking an Anthropic SDK text content block."""
    return SimpleNamespace(type="text", text=text)


@pytest.mark.asyncio
async def test_api_failure_pops_user_message():
    """When the API fails, the last user message should be popped."""
    orch = _make_orchestrator()
    user_msg = {"role": "user", "content": "What should I wear?"}
    session = _make_session([user_msg])

    with patch.object(orch.client.messages, "stream", side_effect=Exception("API down")):
        await orch._call_claude(session)

    assert session.conversation_history == []


@pytest.mark.asyncio
async def test_api_failure_pops_orphaned_tool_use_assistant():
    """When the API fails after a tool cycle, both the user tool_results AND
    the assistant tool_use message should be popped to prevent 400 errors."""
    orch = _make_orchestrator()

    original_user_msg = {"role": "user", "content": "Find me a jacket"}
    assistant_with_tool_use = {
        "role": "assistant",
        "content": [_make_tool_use_block()],
    }
    user_tool_results = {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "tu_123", "content": "{}"}],
    }
    session = _make_session([original_user_msg, assistant_with_tool_use, user_tool_results])

    with patch.object(orch.client.messages, "stream", side_effect=Exception("API down")):
        await orch._call_claude(session)

    # Only the original user message should remain
    assert len(session.conversation_history) == 1
    assert session.conversation_history[0] is original_user_msg


@pytest.mark.asyncio
async def test_api_failure_preserves_text_only_assistant():
    """When the API fails, a text-only assistant message should NOT be popped —
    only assistant messages containing tool_use blocks are orphaned."""
    orch = _make_orchestrator()

    user_msg = {"role": "user", "content": "Hello"}
    assistant_text_only = {
        "role": "assistant",
        "content": [_make_text_block("Hey there!")],
    }
    user_msg2 = {"role": "user", "content": "What's in style?"}
    session = _make_session([user_msg, assistant_text_only, user_msg2])

    with patch.object(orch.client.messages, "stream", side_effect=Exception("API down")):
        await orch._call_claude(session)

    # user_msg2 popped, but assistant_text_only preserved (no tool_use blocks)
    assert len(session.conversation_history) == 2
    assert session.conversation_history[0] is user_msg
    assert session.conversation_history[1] is assistant_text_only


@pytest.mark.asyncio
async def test_fallback_message_streamed_on_failure():
    """When the API fails, a fallback voice message should be streamed
    so the user gets verbal feedback."""
    orch = _make_orchestrator()
    session = _make_session([{"role": "user", "content": "Hi"}])

    with patch.object(orch.client.messages, "stream", side_effect=Exception("API down")):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock) as mock_stream:
            await orch._call_claude(session)

    # Should have been called twice: once with fallback text, once with end_of_message
    assert mock_stream.call_count == 2
    fallback_call = mock_stream.call_args_list[0]
    assert "glitched" in fallback_call.args[1]
    eom_call = mock_stream.call_args_list[1]
    assert eom_call.args[1] == ""
    assert eom_call.kwargs.get("end_of_message") is True


@pytest.mark.asyncio
async def test_api_failure_handles_dict_tool_use_blocks():
    """The orphaned tool_use check should work with plain dict blocks
    (not just Anthropic SDK objects), since content can be either format."""
    orch = _make_orchestrator()

    original_user_msg = {"role": "user", "content": "Find me shoes"}
    assistant_with_dict_tool_use = {
        "role": "assistant",
        "content": [{"type": "tool_use", "id": "tu_456", "name": "search_clothing", "input": {}}],
    }
    user_tool_results = {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "tu_456", "content": "{}"}],
    }
    session = _make_session([original_user_msg, assistant_with_dict_tool_use, user_tool_results])

    with patch.object(orch.client.messages, "stream", side_effect=Exception("API down")):
        await orch._call_claude(session)

    # Both tool_results user msg and tool_use assistant msg should be popped
    assert len(session.conversation_history) == 1
    assert session.conversation_history[0] is original_user_msg
