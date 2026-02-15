"""Tests for voice interruption — flag setting, stream break, and history integrity.

Covers: interrupt() method, _call_claude stream loop break, stub assistant message
handling, and conversation history validity after interrupts (both with and without
partial text).
"""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.orchestrator import MiraOrchestrator, SessionState


# --- Helpers (matching test_history_integrity.py patterns) ---


def _make_orchestrator() -> MiraOrchestrator:
    """Create an orchestrator with mocked Socket.io."""
    return MiraOrchestrator(socket_io=AsyncMock())


def _make_session(history: list | None = None) -> SessionState:
    """Create a session with optional pre-populated conversation history."""
    session = SessionState(user_id="test-user")
    session.conversation_history = list(history) if history else []
    session.system_prompt = "You are a test assistant."
    return session


def _make_text_block(text="Hello"):
    return SimpleNamespace(type="text", text=text)


def _make_stream_event(text: str):
    """Create a content_block_delta event with text."""
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(text=text),
    )


def _make_final_message(content_blocks):
    return SimpleNamespace(content=content_blocks, stop_reason="end_turn")


@asynccontextmanager
async def _mock_stream(events, final_message):
    """Async context manager mimicking client.messages.stream().

    Yields a stream object with an async iterator over events and
    a get_final_message() method.
    """
    class FakeStream:
        def __init__(self):
            self._events = list(events)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._events:
                raise StopAsyncIteration
            event = self._events.pop(0)
            # Yield to let event loop process interrupts
            await asyncio.sleep(0)
            return event

        async def get_final_message(self):
            return final_message

    yield FakeStream()


@asynccontextmanager
async def _mock_stream_with_sync(events, final_message, event_processed: asyncio.Event | None = None):
    """Mock stream that signals after each event is yielded.

    Used for deterministic interrupt testing — caller waits for event_processed
    before setting the interrupt flag, guaranteeing the flag is set between events.
    """
    class FakeStream:
        def __init__(self):
            self._events = list(events)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._events:
                raise StopAsyncIteration
            event = self._events.pop(0)
            await asyncio.sleep(0)
            if event_processed:
                event_processed.set()
                # Give the interrupt setter a chance to run
                await asyncio.sleep(0)
            return event

        async def get_final_message(self):
            return final_message

    yield FakeStream()


# --- interrupt() method tests ---


@pytest.mark.asyncio
async def test_interrupt_sets_flag():
    """interrupt() sets _interrupted=True on the target session."""
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    assert session._interrupted is False
    await orch.interrupt("test-user")
    assert session._interrupted is True


@pytest.mark.asyncio
async def test_interrupt_no_session():
    """interrupt() for non-existent user is a silent no-op."""
    orch = _make_orchestrator()
    # No sessions exist — should not raise
    await orch.interrupt("nonexistent-user")


@pytest.mark.asyncio
async def test_interrupt_flag_cleared_after_handling():
    """_interrupted flag is reset to False after the stream loop handles it."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
    ])
    orch.sessions["test-user"] = session

    # Pre-set the interrupted flag (simulating interrupt() being called)
    session._interrupted = True

    events = [_make_stream_event("Partial ")]
    final = _make_final_message([_make_text_block("Partial response")])

    with patch.object(
        orch.client.messages, "stream",
        return_value=_mock_stream(events, final),
    ):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock):
            await orch._call_claude(session)

    assert session._interrupted is False


# --- Stream break + history tests ---


@pytest.mark.asyncio
async def test_interrupted_with_text_keeps_stub():
    """When interrupted after some text was streamed, a stub assistant message is added."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Tell me about jackets"},
    ])
    orch.sessions["test-user"] = session

    # Custom stream that sets interrupt between the first and second event.
    # The first event processes normally (text collected), then on the second
    # __anext__ call the interrupt flag is set BEFORE returning the event.
    # When _call_claude checks _interrupted at the top of the loop body for
    # the second event, it finds True and breaks.
    @asynccontextmanager
    async def interrupt_between_events():
        class InterruptingStream:
            def __init__(self):
                self._call_count = 0

            def __aiter__(self):
                return self

            async def __anext__(self):
                self._call_count += 1
                if self._call_count == 1:
                    return _make_stream_event("Sure, let me tell you about ")
                elif self._call_count == 2:
                    # Set interrupt BEFORE returning — the loop body will
                    # check _interrupted and break before processing this event
                    session._interrupted = True
                    return _make_stream_event("some amazing jackets...")
                raise StopAsyncIteration

            async def get_final_message(self):
                return _make_final_message([_make_text_block("Full response")])

        yield InterruptingStream()

    with patch.object(
        orch.client.messages, "stream",
        return_value=interrupt_between_events(),
    ):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock):
            await orch._call_claude(session)

    # History should end with the stub assistant message
    assert len(session.conversation_history) == 2
    assert session.conversation_history[0]["role"] == "user"
    assert session.conversation_history[1]["role"] == "assistant"
    assert session.conversation_history[1]["content"][0]["type"] == "text"
    # The stub should contain the text from the first event only
    stub_text = session.conversation_history[1]["content"][0]["text"]
    assert "Sure" in stub_text


@pytest.mark.asyncio
async def test_interrupted_empty_pops_user_message():
    """When interrupted before any text was streamed, the user message is popped."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Previous question"},
        {"role": "assistant", "content": [{"type": "text", "text": "Previous answer"}]},
        {"role": "user", "content": "New question"},
    ])
    orch.sessions["test-user"] = session

    # Set flag before any events arrive — interrupt fires immediately
    session._interrupted = True

    events = [_make_stream_event("This won't be seen")]
    final = _make_final_message([_make_text_block("Full response")])

    with patch.object(
        orch.client.messages, "stream",
        return_value=_mock_stream(events, final),
    ):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock):
            await orch._call_claude(session)

    # "New question" user message should be popped since no text was streamed
    assert len(session.conversation_history) == 2
    assert session.conversation_history[-1]["role"] == "assistant"
    assert session.conversation_history[-1]["content"][0]["text"] == "Previous answer"


@pytest.mark.asyncio
async def test_interrupt_sends_end_of_message():
    """Interrupt always sends an end-of-message signal to the frontend."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
    ])
    orch.sessions["test-user"] = session
    session._interrupted = True

    # Need at least one event so the loop body runs and checks _interrupted
    events = [_make_stream_event("Hi there")]
    final = _make_final_message([_make_text_block("Hi there")])

    with patch.object(
        orch.client.messages, "stream",
        return_value=_mock_stream(events, final),
    ):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock) as mock_stream:
            await orch._call_claude(session)

    # Should have sent end-of-message
    eom_calls = [
        c for c in mock_stream.call_args_list
        if c.kwargs.get("end_of_message") is True
    ]
    assert len(eom_calls) == 1


@pytest.mark.asyncio
async def test_interrupt_returns_early_skips_tools():
    """Interrupted stream returns early — tool processing is never reached."""
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Find me a jacket"},
    ])
    orch.sessions["test-user"] = session
    session._interrupted = True

    # Need at least one event so the loop body runs and checks _interrupted
    events = [_make_stream_event("Let me search")]
    final = _make_final_message([
        _make_text_block("Let me search"),
        SimpleNamespace(type="tool_use", id="tu_1", name="search_clothing", input={}),
    ])

    with patch.object(
        orch.client.messages, "stream",
        return_value=_mock_stream(events, final),
    ):
        with patch.object(orch, "_stream_text", new_callable=AsyncMock):
            with patch.object(orch, "_handle_tool_calls", new_callable=AsyncMock) as mock_tools:
                await orch._call_claude(session)

    # Tool handler should NOT have been called
    mock_tools.assert_not_called()


# --- History integrity after interrupt ---


@pytest.mark.asyncio
async def test_history_valid_after_interrupt_for_next_turn():
    """After an interrupt, the next event can append a user message and call Claude
    without hitting consecutive-user-message errors.

    Simulates the full flow: interrupt sets flag → _call_claude breaks →
    next handle_event appends user message → _call_claude succeeds.
    """
    orch = _make_orchestrator()
    session = _make_session()
    orch.sessions["test-user"] = session

    call_count = 0

    async def mock_call_claude(sess, tool_depth=0):
        nonlocal call_count
        call_count += 1

        if call_count == 1:
            # First call: simulate streaming some text, then getting interrupted
            sess.conversation_history.append({
                "role": "assistant",
                "content": [{"type": "text", "text": "Sure, let me—"}],
            })
        elif call_count == 2:
            # Second call: the new response after interrupt
            sess.conversation_history.append({
                "role": "assistant",
                "content": [{"type": "text", "text": "Of course! Here are shoes."}],
            })

    with patch.object(orch, "_call_claude", side_effect=mock_call_claude):
        with patch.object(orch, "_start_silence_timer"):
            # First event
            await orch.handle_event("test-user", {"type": "voice", "transcript": "Show me jackets"})

            # Second event (the interrupt transcript)
            await orch.handle_event("test-user", {"type": "voice", "transcript": "Actually show me shoes"})

    # Validate history: should alternate user/assistant correctly
    history = session.conversation_history
    assert len(history) == 4  # user, assistant, user, assistant
    for i in range(0, len(history), 2):
        assert history[i]["role"] == "user"
    for i in range(1, len(history), 2):
        assert history[i]["role"] == "assistant"


@pytest.mark.asyncio
async def test_validate_history_rejects_empty_stub():
    """_validate_history truncates empty text blocks in assistant messages.

    This catches the edge case where an interrupt adds an assistant stub with
    empty text — the validator should reject it to prevent Claude API errors.
    """
    orch = _make_orchestrator()
    session = _make_session([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": [{"type": "text", "text": ""}]},
        {"role": "user", "content": "World"},
    ])

    orch._validate_history(session)

    # The empty assistant message should be truncated
    assert len(session.conversation_history) == 1
    assert session.conversation_history[0]["content"] == "Hello"
