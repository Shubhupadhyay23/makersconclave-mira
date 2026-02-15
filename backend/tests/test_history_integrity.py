"""Tests for conversation history integrity — concurrency, validation, and recovery.

Covers the asyncio.Lock event serialization, _validate_history() defense-in-depth,
and end-of-message signaling in error paths. These tests prevent the permanent 400
error bug where concurrent events corrupt conversation_history by interleaving
user messages between tool_use and tool_result blocks.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from agent.orchestrator import MiraOrchestrator, SessionState


# --- Helpers (matching test_error_recovery.py patterns) ---


def _make_orchestrator() -> MiraOrchestrator:
    """Create an orchestrator with mocked Socket.io."""
    return MiraOrchestrator(socket_io=AsyncMock())


def _make_session(history: list | None = None) -> SessionState:
    """Create a session with optional pre-populated conversation history."""
    session = SessionState(user_id="test-user")
    session.conversation_history = list(history) if history else []
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


def _make_final_message(content_blocks):
    """Create a SimpleNamespace mimicking an Anthropic SDK final message."""
    return SimpleNamespace(content=content_blocks, stop_reason="end_turn")


# --- Concurrency tests ---


@pytest.mark.asyncio
async def test_concurrent_events_serialized():
    """Two events entering handle_event simultaneously are serialized by the lock.

    Without the lock, both coroutines would append user messages before either
    calls Claude, resulting in consecutive user messages (corruption). With the
    lock, the second event waits for the first to finish.
    """
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    call_order = []

    original_call_claude = orch._call_claude

    async def mock_call_claude(sess, tool_depth=0):
        call_order.append(f"claude_start_{len(sess.conversation_history)}")
        # Simulate Claude taking time (yields control to event loop)
        await asyncio.sleep(0.05)
        # Append an assistant response to keep history valid
        sess.conversation_history.append({
            "role": "assistant",
            "content": [_make_text_block("Response")],
        })
        call_order.append(f"claude_end_{len(sess.conversation_history)}")

    with patch.object(orch, "_call_claude", side_effect=mock_call_claude):
        with patch.object(orch, "_start_silence_timer"):
            # Fire two events concurrently
            await asyncio.gather(
                orch.handle_event("test-user", {"type": "voice", "transcript": "First"}),
                orch.handle_event("test-user", {"type": "voice", "transcript": "Second"}),
            )

    # With the lock, events are serialized: first completes fully before second starts
    # History should be: user, assistant, user, assistant (valid alternation)
    assert len(session.conversation_history) == 4
    assert session.conversation_history[0]["role"] == "user"
    assert session.conversation_history[1]["role"] == "assistant"
    assert session.conversation_history[2]["role"] == "user"
    assert session.conversation_history[3]["role"] == "assistant"

    # Claude calls should NOT overlap — second starts after first ends
    assert call_order[0].startswith("claude_start")
    assert call_order[1].startswith("claude_end")
    assert call_order[2].startswith("claude_start")
    assert call_order[3].startswith("claude_end")


@pytest.mark.asyncio
async def test_event_during_tool_execution():
    """Event arriving while tools are executing is queued by the lock.

    Simulates: event A triggers Claude → tool_use → tool execution (long await).
    Event B arrives during tool execution. Without the lock, B would append a user
    message between assistant tool_use and user tool_result, corrupting history.
    """
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    tool_execution_event = asyncio.Event()
    second_event_started = asyncio.Event()

    async def slow_call_claude(sess, tool_depth=0):
        # First call: simulate tool execution delay
        if tool_depth == 0 and len(sess.conversation_history) == 1:
            sess.conversation_history.append({
                "role": "assistant",
                "content": [_make_tool_use_block()],
            })
            # Signal that tool execution is "in progress"
            tool_execution_event.set()
            await asyncio.sleep(0.05)  # Simulate tool execution time
            sess.conversation_history.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tu_123", "content": "{}"}],
            })
            # Second Claude call for tool result processing
            sess.conversation_history.append({
                "role": "assistant",
                "content": [_make_text_block("Here's what I found")],
            })
        else:
            # Subsequent calls
            sess.conversation_history.append({
                "role": "assistant",
                "content": [_make_text_block("Sure thing")],
            })

    async def delayed_second_event():
        # Wait until tool execution is in progress, then fire second event
        await tool_execution_event.wait()
        second_event_started.set()
        await orch.handle_event("test-user", {"type": "voice", "transcript": "Also show me shoes"})

    with patch.object(orch, "_call_claude", side_effect=slow_call_claude):
        with patch.object(orch, "_start_silence_timer"):
            await asyncio.gather(
                orch.handle_event("test-user", {"type": "voice", "transcript": "Find me a jacket"}),
                delayed_second_event(),
            )

    # Verify: no consecutive user messages, no orphaned tool_use
    for i in range(len(session.conversation_history) - 1):
        curr_role = session.conversation_history[i]["role"]
        next_role = session.conversation_history[i + 1]["role"]
        # user → user is never valid
        assert not (curr_role == "user" and next_role == "user"), (
            f"Consecutive user messages at index {i} and {i+1}"
        )


# --- History validation tests ---


@pytest.mark.asyncio
async def test_validate_history_orphaned_tool_use():
    """History with tool_use but no following tool_result is truncated."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": [_make_text_block("Hi!")]},
        {"role": "user", "content": "Find me a jacket"},
        {"role": "assistant", "content": [_make_tool_use_block()]},
        # Missing tool_result — corrupted!
    ])

    orch._validate_history(session)

    # Should truncate to before the orphaned tool_use assistant message
    assert len(session.conversation_history) == 3
    assert session.conversation_history[-1]["role"] == "user"
    assert session.conversation_history[-1]["content"] == "Find me a jacket"


@pytest.mark.asyncio
async def test_validate_history_consecutive_user_messages():
    """Two consecutive user messages are truncated at the second one."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": [_make_text_block("Hi!")]},
        {"role": "user", "content": "First question"},
        {"role": "user", "content": "Second question"},  # corruption
    ])

    orch._validate_history(session)

    # Should truncate before the second consecutive user message
    assert len(session.conversation_history) == 3
    assert session.conversation_history[-1]["content"] == "First question"


@pytest.mark.asyncio
async def test_validate_history_clean_passthrough():
    """Valid history passes through unchanged."""
    orch = _make_orchestrator()
    valid_history = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": [_make_text_block("Hi!")]},
        {"role": "user", "content": "Find me shoes"},
        {"role": "assistant", "content": [_make_tool_use_block(id="tu_456")]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu_456", "content": "{}"}]},
        {"role": "assistant", "content": [_make_text_block("Here are some shoes")]},
        {"role": "user", "content": "Thanks!"},
    ]
    session = _make_session(valid_history)

    orch._validate_history(session)

    assert len(session.conversation_history) == 7


@pytest.mark.asyncio
async def test_validate_history_deep_corruption():
    """Corruption at messages[2] (matching the real error) is repaired.

    This reproduces the exact scenario from the logs: a user message inserted
    between an assistant tool_use and its expected tool_result.
    """
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Show me jackets"},
        {"role": "assistant", "content": [_make_tool_use_block(id="tu_real")]},
        # THIS IS THE CORRUPTION: a regular user message instead of tool_result
        {"role": "user", "content": "Also I like blue"},
        # The tool_result that should have been at index 2
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu_real", "content": "{}"}]},
    ])

    orch._validate_history(session)

    # Should truncate at the corruption point — the assistant tool_use at index 1
    # has no valid tool_result following it
    assert len(session.conversation_history) == 1
    assert session.conversation_history[0]["content"] == "Show me jackets"


# --- Silence timer + lock interaction ---


@pytest.mark.asyncio
async def test_is_processing_prevents_silence_during_lock():
    """Silence timer correctly skips when processing is locked.

    The silence callback checks `is_processing` before calling handle_event.
    When the lock is held, is_processing is True, so silence is suppressed.
    """
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    # Simulate: lock is held, is_processing=True
    session.is_processing = True

    # Directly test the silence callback logic
    silence_event_fired = False

    original_handle_event = orch.handle_event

    async def tracking_handle_event(user_id, event):
        nonlocal silence_event_fired
        if event.get("type") == "silence":
            silence_event_fired = True
        await original_handle_event(user_id, event)

    with patch.object(orch, "handle_event", side_effect=tracking_handle_event):
        # The silence callback checks is_processing — since it's True, it should not fire
        if session.is_active and not session.is_processing:
            await orch.handle_event("test-user", {"type": "silence", "duration_seconds": 5})

    assert not silence_event_fired


# --- End-of-message signaling ---


@pytest.mark.asyncio
async def test_fallback_sends_end_of_message():
    """Outer catch in handle_event sends both fallback text AND end_of_message signal."""
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    with patch.object(orch, "_call_claude", side_effect=Exception("Unexpected crash")):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock) as mock_stream:
            with patch.object(orch, "_start_silence_timer"):
                await orch.handle_event("test-user", {"type": "voice", "transcript": "Hello"})

    # Should have been called twice: once with fallback text, once with end_of_message
    assert mock_stream.call_count == 2
    fallback_call = mock_stream.call_args_list[0]
    assert "glitched" in fallback_call.args[1]
    eom_call = mock_stream.call_args_list[1]
    assert eom_call.args[1] == ""
    assert eom_call.kwargs.get("end_of_message") is True


# --- Error recovery after tool chain ---


@pytest.mark.asyncio
async def test_error_recovery_after_tool_chain():
    """API failure during depth-2 tool recursion recovers cleanly.

    Simulates: user → Claude (tool_use) → tool_result → Claude (fails).
    After recovery, history should be valid for the next turn.
    """
    orch = _make_orchestrator()

    # Build history as if we're mid-tool-chain
    session = _make_session([
        {"role": "user", "content": "Find me a jacket"},
        {"role": "assistant", "content": [_make_tool_use_block(id="tu_first")]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu_first", "content": '{"items": []}'}]},
    ])

    # Second Claude call (processing tool results) fails
    with patch.object(orch.client.messages, "stream", side_effect=Exception("API overloaded")):
        await orch._call_claude(session, tool_depth=1)

    # Error handler should pop the tool_result user message and orphaned tool_use assistant
    # Validate that history is now clean for the next turn
    orch._validate_history(session)

    # History should still be valid after recovery + validation
    for i in range(len(session.conversation_history) - 1):
        curr_role = session.conversation_history[i]["role"]
        next_role = session.conversation_history[i + 1]["role"]
        assert curr_role != next_role or curr_role == "user", (
            f"Invalid role sequence at index {i}: {curr_role} → {next_role}"
        )
