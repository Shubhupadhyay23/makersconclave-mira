"""Mira — Event-driven AI agent orchestrator.

Receives events (voice, gestures, poses, silence) and orchestrates Claude API
calls with tool use. Streams responses to HeyGen for voice output and broadcasts
tool results to the frontend via Socket.io.
"""

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from uuid import uuid4

import anthropic
from dotenv import load_dotenv

from agent.prompts import build_system_prompt
from agent.tools import TOOL_DEFINITIONS, execute_tool
from agent.memory import (
    load_user_profile,
    load_user_purchases,
    load_past_sessions,
    save_session_summary,
    get_user_oauth_token,
)
from models.database import NeonHTTPClient

load_dotenv()

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
SILENCE_TIMEOUT_SECONDS = 5
EVENT_BATCH_WINDOW_MS = 200
SOFT_API_LIMIT = 20


@dataclass
class SessionState:
    """Tracks state for a single mirror session."""

    session_id: str = field(default_factory=lambda: str(uuid4()))
    user_id: str = ""
    api_calls: int = 0
    items_shown: int = 0
    likes: int = 0
    dislikes: int = 0
    liked_items: list = field(default_factory=list)
    conversation_history: list = field(default_factory=list)
    is_active: bool = True
    last_input_time: float = field(default_factory=time.time)
    wrapping_up: bool = False
    user_context: dict = field(default_factory=dict)
    system_prompt: str = ""
    _last_shown_item: dict | None = None


class MiraOrchestrator:
    """Event-driven orchestrator for the Mira AI stylist agent."""

    def __init__(self, socket_io=None):
        self.client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
        self.sio = socket_io
        self.sessions: dict[str, SessionState] = {}
        self._silence_tasks: dict[str, asyncio.Task] = {}

    async def start_session(self, user_id: str) -> SessionState:
        """Initialize a new Mira session for a user."""
        session = SessionState(user_id=user_id)
        self.sessions[user_id] = session

        # Load user data from DB
        profile = {}
        purchases = []
        past_sessions = []
        oauth_token = None

        try:
            db = NeonHTTPClient()
            try:
                profile = await load_user_profile(db, user_id)
                purchases = await load_user_purchases(db, user_id)
                past_sessions = await load_past_sessions(db, user_id)
                oauth_token = await get_user_oauth_token(db, user_id)
            finally:
                await db.close()
        except Exception as e:
            print(f"[mira] Warning: Could not load user data from DB: {e}")
            # Continue with empty data — Mira will still work, just less personalized

        # Store on session for tool access
        session.user_context = {
            "profile": profile,
            "purchases": purchases,
            "past_sessions": past_sessions,
            "oauth_token": oauth_token,
        }

        # Build system prompt with all user data
        session.system_prompt = build_system_prompt(
            user_profile=profile,
            purchases=purchases,
            session_history=past_sessions,
            session_state={
                "items_shown": 0,
                "likes": 0,
                "dislikes": 0,
                "api_calls": 0,
            },
        )

        # Create the DB session record (best-effort)
        try:
            db = NeonHTTPClient()
            try:
                await db.execute(
                    "INSERT INTO sessions (id, user_id, started_at, status) "
                    "VALUES ($1, $2::uuid, now(), 'active')",
                    [session.session_id, user_id],
                )
            finally:
                await db.close()
        except Exception as e:
            print(f"[mira] Warning: Could not create session record: {e}")

        # Start silence detection
        self._start_silence_timer(user_id)

        # Trigger Mira's opening line
        await self.handle_event(user_id, {
            "type": "session_start",
            "message": "A new user just stepped up to the mirror. Introduce yourself and start the session.",
        })

        return session

    async def handle_event(self, user_id: str, event: dict) -> None:
        """Handle an incoming event and generate Mira's response.

        Events are: voice, gesture (swipe_right, swipe_left, thumbs_up, thumbs_down),
        pose, snapshot, silence, session_start.
        """
        session = self.sessions.get(user_id)
        if not session or not session.is_active:
            return

        session.last_input_time = time.time()
        self._start_silence_timer(user_id)

        # Track gesture outcomes
        gesture = event.get("gesture")

        if gesture in ("thumbs_up", "swipe_right"):
            session.likes += 1
            if session._last_shown_item:
                session.liked_items.append(session._last_shown_item)
        elif gesture in ("thumbs_down", "swipe_left"):
            session.dislikes += 1

        # Build user message from event
        user_message = self._event_to_message(event)
        session.conversation_history.append({
            "role": "user",
            "content": user_message,
        })

        # Update system prompt with current session state
        session.system_prompt = build_system_prompt(
            user_profile=session.user_context.get("profile", {}),
            purchases=session.user_context.get("purchases", []),
            session_history=session.user_context.get("past_sessions", []),
            session_state={
                "items_shown": session.items_shown,
                "likes": session.likes,
                "dislikes": session.dislikes,
                "api_calls": session.api_calls,
            },
        )

        # Call Claude
        try:
            await self._call_claude(session)
        except Exception as e:
            print(f"[mira] Error calling Claude: {e}")
            # Send error message in-character
            await self._stream_text(user_id, "Hmm, my brain glitched for a second. What were we talking about?")

    async def _call_claude(self, session: SessionState) -> None:
        """Make a streaming Claude API call with tool use."""
        session.api_calls += 1

        # Collect full response (streaming to HeyGen happens via callback)
        collected_text = ""
        tool_uses = []

        async with self.client.messages.stream(
            model=CLAUDE_MODEL,
            max_tokens=300,
            system=session.system_prompt,
            messages=session.conversation_history,
            tools=TOOL_DEFINITIONS,
        ) as stream:
            async for event in stream:
                if event.type == "content_block_delta":
                    if hasattr(event.delta, "text"):
                        collected_text += event.delta.text
                        # Stream each chunk to HeyGen / frontend
                        await self._stream_text(session.user_id, event.delta.text)

                elif event.type == "content_block_stop":
                    pass

            # Get the final message for tool use blocks
            final_message = await stream.get_final_message()

        # Process any tool use blocks
        for block in final_message.content:
            if block.type == "tool_use":
                tool_uses.append(block)

        # Add assistant message to history
        session.conversation_history.append({
            "role": "assistant",
            "content": final_message.content,
        })

        # Handle tool calls
        if tool_uses:
            await self._handle_tool_calls(session, tool_uses)

    async def _handle_tool_calls(self, session: SessionState, tool_uses: list) -> None:
        """Execute tool calls and continue the conversation."""
        tool_results = []

        for tool_use in tool_uses:
            result = await execute_tool(
                tool_name=tool_use.name,
                tool_input=tool_use.input,
                user_context={
                    "user_id": session.user_id,
                    "oauth_token": session.user_context.get("oauth_token"),
                },
            )

            # Parallel broadcast: send results to frontend via Socket.io
            frontend_payload = result.pop("frontend_payload", None)
            if frontend_payload and self.sio:
                await self.sio.emit(
                    "tool_result",
                    frontend_payload,
                    room=session.user_id,
                )

            # Track items shown
            if tool_use.name == "search_clothing" and result.get("results"):
                session.items_shown += len(result["results"])
                if result["results"]:
                    session._last_shown_item = result["results"][0]

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": json.dumps(result),
            })

        # Add tool results to conversation and continue
        session.conversation_history.append({
            "role": "user",
            "content": tool_results,
        })

        # Call Claude again to process tool results
        await self._call_claude(session)

    async def end_session(self, user_id: str) -> dict | None:
        """End a session and save summary."""
        session = self.sessions.get(user_id)
        if not session:
            return None

        session.is_active = False
        self._cancel_silence_timer(user_id)

        # Generate session summary via Claude
        summary = await self._generate_summary(session)

        # Save to DB
        db = NeonHTTPClient()
        try:
            await save_session_summary(
                db=db,
                session_id=session.session_id,
                summary=summary,
                liked_items=session.liked_items,
                reactions={
                    "likes": session.likes,
                    "dislikes": session.dislikes,
                    "items_shown": session.items_shown,
                },
            )
        finally:
            await db.close()

        # Emit session end to frontend
        if self.sio:
            await self.sio.emit(
                "session_ended",
                {
                    "session_id": session.session_id,
                    "summary": summary,
                    "liked_items": session.liked_items,
                    "stats": {
                        "items_shown": session.items_shown,
                        "likes": session.likes,
                        "dislikes": session.dislikes,
                    },
                },
                room=user_id,
            )

        del self.sessions[user_id]
        return {"summary": summary, "liked_items": session.liked_items}

    async def _generate_summary(self, session: SessionState) -> str:
        """Ask Claude to generate a short session summary for memory."""
        response = await self.client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=200,
            system="Summarize this styling session in 2-3 sentences for future reference. Include key style preferences discovered, items liked, and overall vibe.",
            messages=[
                {
                    "role": "user",
                    "content": f"Session had {session.items_shown} items shown, {session.likes} liked, {session.dislikes} disliked. Liked items: {json.dumps(session.liked_items[:5])}",
                }
            ],
        )
        return response.content[0].text

    def _event_to_message(self, event: dict) -> str | list:
        """Convert an event dict to a Claude user message."""
        event_type = event.get("type")

        if event_type == "voice":
            return event.get("transcript", "")

        elif event_type == "gesture":
            gesture = event.get("gesture", "unknown")
            gesture_descriptions = {
                "swipe_right": "The user swiped right (like/next).",
                "swipe_left": "The user swiped left (dislike/skip).",
                "thumbs_up": "The user gave a thumbs up (like this item).",
                "thumbs_down": "The user gave a thumbs down (dislike this item).",
            }
            return gesture_descriptions.get(gesture, f"The user made a {gesture} gesture.")

        elif event_type == "pose":
            return [
                {"type": "text", "text": "The user struck a new pose. Here's what they look like:"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": event.get("image_base64", ""),
                    },
                },
            ]

        elif event_type == "snapshot":
            return [
                {"type": "text", "text": "Here's a snapshot of the user at the mirror:"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": event.get("image_base64", ""),
                    },
                },
            ]

        elif event_type == "silence":
            duration = event.get("duration_seconds", SILENCE_TIMEOUT_SECONDS)
            return f"The user has been silent for {duration} seconds. Say something to keep the conversation going."

        elif event_type == "session_start":
            return event.get("message", "Start the session.")

        return str(event)

    async def _stream_text(self, user_id: str, text_chunk: str) -> None:
        """Stream a text chunk to the frontend and HeyGen."""
        if self.sio:
            await self.sio.emit(
                "mira_speech",
                {"text": text_chunk, "is_chunk": True},
                room=user_id,
            )

    def _start_silence_timer(self, user_id: str) -> None:
        """Start or restart the silence detection timer."""
        self._cancel_silence_timer(user_id)

        async def _silence_callback():
            await asyncio.sleep(SILENCE_TIMEOUT_SECONDS)
            session = self.sessions.get(user_id)
            if session and session.is_active:
                await self.handle_event(user_id, {
                    "type": "silence",
                    "duration_seconds": SILENCE_TIMEOUT_SECONDS,
                })

        self._silence_tasks[user_id] = asyncio.create_task(_silence_callback())

    def _cancel_silence_timer(self, user_id: str) -> None:
        """Cancel the silence timer for a user."""
        task = self._silence_tasks.pop(user_id, None)
        if task and not task.done():
            task.cancel()
