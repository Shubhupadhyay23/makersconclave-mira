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
from typing import Dict, Optional
from uuid import uuid4

import anthropic
from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from agent.prompts import build_system_prompt, build_recommendation_prompt, get_mira_system_prompt
from agent.tools import TOOL_DEFINITIONS, execute_tool
from agent.memory import (
    load_user_profile,
    load_user_purchases,
    load_past_sessions,
    load_purchase_statistics,
    save_session_summary,
    get_user_oauth_token,
    refresh_calendar_events,
)
from models.database import NeonHTTPClient
from services.user_data_service import (
    get_user_profile_and_purchases,
    is_new_user,
    save_outfits_to_database,
)

load_dotenv()

SONNET_MODEL = "claude-sonnet-4-5-20250929"
HAIKU_MODEL = "claude-haiku-4-5-20251001"
SILENCE_TIMEOUT_SECONDS = 5
EVENT_BATCH_WINDOW_MS = 200
SOFT_API_LIMIT = 20

# Initialize Anthropic client for recommendation pipeline
anthropic_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


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
    is_processing: bool = False
    user_context: dict = field(default_factory=dict)
    system_prompt: str = ""
    _last_shown_item: dict | None = None
    _event_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _snapshot_future: asyncio.Future | None = None
    _photo_taken: bool = False
    _interrupted: bool = False


class MiraOrchestrator:
    """Event-driven orchestrator for the Mira AI stylist agent."""

    def __init__(self, socket_io=None):
        self.client = anthropic.AsyncAnthropic(
            auth_token=os.getenv("ANTHROPIC_AUTH_TOKEN"),
            default_headers={"anthropic-beta": "oauth-2025-04-20"},
            default_query={"beta": "true"},
        )
        self.sio = socket_io
        self.sessions: dict[str, SessionState] = {}
        self._silence_tasks: dict[str, asyncio.Task] = {}

    async def interrupt(self, user_id: str) -> None:
        """Request interruption of the current Claude stream for a user.

        Sets a flag that the stream loop checks each iteration. No lock needed —
        this runs outside _event_lock so it can fire while _call_claude holds it.
        """
        session = self.sessions.get(user_id)
        if session:
            session._interrupted = True
            print(f"[mira] Interrupt requested for {user_id}")

    async def start_session(self, user_id: str) -> SessionState:
        """Initialize a new Mira session for a user."""
        # End any existing session to prevent orphaned timers
        if user_id in self.sessions:
            await self.end_session(user_id)

        session = SessionState(user_id=user_id)
        self.sessions[user_id] = session

        # Load user data from DB in parallel — fall back to empty defaults if any fail
        profile = {}
        purchases = []
        past_sessions = []
        oauth_token = None
        purchase_stats = {}
        db = NeonHTTPClient()
        try:
            profile, purchases, past_sessions, oauth_token, purchase_stats = await asyncio.gather(
                load_user_profile(db, user_id),
                load_user_purchases(db, user_id),
                load_past_sessions(db, user_id),
                get_user_oauth_token(db, user_id),
                load_purchase_statistics(db, user_id),
            )
        except Exception as e:
            print(f"[mira] Failed to load user data for {user_id}, using defaults: {e}")
        finally:
            await db.close()

        # Phase 2: Refresh calendar events from Google API (needs oauth_token from phase 1)
        calendar_events = []
        if oauth_token:
            db = NeonHTTPClient()
            try:
                calendar_events = await refresh_calendar_events(db, user_id, oauth_token)
                print(f"[mira] Loaded {len(calendar_events)} calendar events for {user_id}")
            except Exception as e:
                print(f"[mira] Calendar refresh failed for {user_id}, continuing without: {e}")
            finally:
                await db.close()

        # Store on session for tool access
        session.user_context = {
            "profile": profile,
            "purchases": purchases,
            "past_sessions": past_sessions,
            "oauth_token": oauth_token,
            "purchase_stats": purchase_stats,
            "calendar_events": calendar_events,
        }

        # Build system prompt with all user data
        session.system_prompt = build_system_prompt(
            user_profile=profile,
            purchases=purchases,
            purchase_stats=purchase_stats,
            calendar_events=calendar_events,
            session_history=past_sessions,
            session_state={
                "items_shown": 0,
                "likes": 0,
                "dislikes": 0,
                "api_calls": 0,
            },
        )

        # Emit system prompt for debugging
        if self.sio:
            await self.sio.emit(
                "debug_system_prompt",
                {"prompt": session.system_prompt},
                room=user_id,
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
            print(f"[mira] Failed to insert session record for {user_id}: {e}")

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
            print(f"[mira] handle_event: no active session for {user_id}, ignoring event {event.get('type', '?')}")
            return

        # If a take_photo Future is pending and this is a snapshot, resolve it
        # immediately and return — do NOT acquire the event lock (the lock is
        # already held by _handle_take_photo's caller chain, so acquiring it
        # here would deadlock).
        if (
            event.get("type") == "snapshot"
            and session._snapshot_future is not None
            and not session._snapshot_future.done()
        ):
            image_data = event.get("image_base64", "")
            session._snapshot_future.set_result(image_data)
            print(f"[mira] take_photo: resolved snapshot Future for {user_id}")
            return

        # Block all new events once graceful shutdown has started
        if session.wrapping_up:
            print(f"[mira] Session wrapping up for {user_id}, ignoring event {event.get('type', '?')}")
            return

        async with session._event_lock:
            session.is_processing = True
            try:
                # Only restart the silence timer on real user input — not on
                # silence events themselves, which would create a feedback loop
                # (silence → Mira speaks → new timer → silence → repeat).
                if event.get("type") != "silence":
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
                    purchase_stats=session.user_context.get("purchase_stats"),
                    calendar_events=session.user_context.get("calendar_events"),
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
                    await self._stream_text(user_id, "Hmm, my brain glitched for a second. What were we talking about?")
                    await self._stream_text(user_id, "", end_of_message=True)
            finally:
                session.is_processing = False

    def _select_model(self, session: SessionState) -> tuple[str, int]:
        """Select the right model and max_tokens for this turn."""
        return SONNET_MODEL, 2048

    def _validate_history(self, session: SessionState) -> None:
        """Validate conversation history and truncate to last valid point if corrupted.

        Checks:
        1. Alternating user → assistant → user roles (tool_result messages are user role)
        2. Every assistant message with tool_use blocks is immediately followed by a
           user message with matching tool_result blocks

        If corruption is found, truncates history to the last valid position and logs
        a warning. This is defense-in-depth — the event lock should prevent corruption,
        but edge cases or future bugs could still cause issues.
        """
        history = session.conversation_history
        if not history:
            return

        valid_up_to = 0  # exclusive — history[:valid_up_to] is valid

        i = 0
        while i < len(history):
            msg = history[i]
            role = msg.get("role")

            # First message must be from user
            if i == 0 and role != "user":
                print(f"[mira] History validation: first message is {role}, expected user — truncating")
                break

            # Check alternating roles (user and assistant)
            if i > 0:
                prev_role = history[i - 1].get("role")
                # After user, expect assistant; after assistant, expect user
                if prev_role == role and role != "user":
                    # Two consecutive assistant messages — corruption
                    print(f"[mira] History validation: consecutive {role} messages at index {i} — truncating")
                    break
                if prev_role == "user" and role == "user":
                    # Two consecutive user messages — corruption (unless first is tool_result)
                    # A tool_result user message followed by a regular user message is invalid
                    print(f"[mira] History validation: consecutive user messages at index {i} — truncating")
                    break

            # If this is an assistant message with tool_use, verify next message has tool_results
            if role == "assistant":
                content = msg.get("content", [])
                has_tool_use = False
                if isinstance(content, list):
                    has_tool_use = any(
                        (getattr(block, "type", None) == "tool_use")
                        or (isinstance(block, dict) and block.get("type") == "tool_use")
                        for block in content
                    )

                if has_tool_use:
                    # Must be followed by a user message with tool_result blocks
                    if i + 1 >= len(history):
                        print(f"[mira] History validation: tool_use at index {i} with no following tool_result — truncating")
                        break
                    next_msg = history[i + 1]
                    if next_msg.get("role") != "user":
                        print(f"[mira] History validation: tool_use at index {i} followed by {next_msg.get('role')} — truncating")
                        break
                    next_content = next_msg.get("content", [])
                    has_tool_result = isinstance(next_content, list) and any(
                        isinstance(block, dict) and block.get("type") == "tool_result"
                        for block in next_content
                    )
                    if not has_tool_result:
                        print(f"[mira] History validation: tool_use at index {i} followed by user message without tool_result — truncating")
                        break

            # Check for empty text content blocks in assistant messages
            if role == "assistant":
                content = msg.get("content", [])
                if not isinstance(content, list):
                    content = []
                has_empty_text = any(
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and not block.get("text", "").strip()
                    for block in content
                )
                if has_empty_text:
                    print(f"[mira] History validation: empty text block at index {i} — truncating")
                    break

            valid_up_to = i + 1
            i += 1

        if valid_up_to < len(history):
            removed = len(history) - valid_up_to
            session.conversation_history = history[:valid_up_to]
            print(f"[mira] History validation: removed {removed} messages, kept {valid_up_to} for {session.user_id}")

    def _compact_history(self, session: SessionState) -> None:
        """Compact older history entries to stay under the 200k token context limit.

        Base64 images (~50-100k tokens each) and large tool-result JSON are the
        main culprits. Strategy: keep the last KEEP_RECENT messages intact and
        replace images / truncate tool results in everything before that.
        """
        KEEP_RECENT = 8   # last ~4 turns untouched
        MAX_TOOL_RESULT_CHARS = 600  # truncate older tool result strings

        history = session.conversation_history
        if len(history) <= KEEP_RECENT:
            return

        compact_boundary = len(history) - KEEP_RECENT
        compacted_images = 0
        compacted_tool_results = 0

        for idx in range(compact_boundary):
            msg = history[idx]
            content = msg.get("content")
            if not isinstance(content, list):
                continue

            new_content = []
            for block in content:
                # --- dict blocks (user messages, tool_result) ---
                if isinstance(block, dict):
                    btype = block.get("type")

                    # Replace base64 images with a lightweight placeholder
                    if btype == "image":
                        new_content.append({
                            "type": "text",
                            "text": "[image removed — earlier in conversation]",
                        })
                        compacted_images += 1
                        continue

                    # Truncate large tool_result content strings
                    if btype == "tool_result":
                        rc = block.get("content", "")
                        if isinstance(rc, str) and len(rc) > MAX_TOOL_RESULT_CHARS:
                            block = {**block, "content": rc[:MAX_TOOL_RESULT_CHARS] + " ...[truncated]"}
                            compacted_tool_results += 1
                        # tool_result content can also be a list (take_photo returns list with image)
                        elif isinstance(rc, list):
                            new_rc = []
                            for sub in rc:
                                if isinstance(sub, dict) and sub.get("type") == "image":
                                    new_rc.append({"type": "text", "text": "[image removed — earlier in conversation]"})
                                    compacted_images += 1
                                else:
                                    new_rc.append(sub)
                            block = {**block, "content": new_rc}

                    new_content.append(block)
                    continue

                # --- SDK ContentBlock objects (assistant messages) ---
                if hasattr(block, "type") and block.type == "image":
                    new_content.append({
                        "type": "text",
                        "text": "[image removed — earlier in conversation]",
                    })
                    compacted_images += 1
                    continue

                new_content.append(block)

            history[idx]["content"] = new_content

        if compacted_images or compacted_tool_results:
            print(
                f"[mira] History compacted for {session.user_id}: "
                f"removed {compacted_images} images, truncated {compacted_tool_results} tool results "
                f"(kept last {KEEP_RECENT} messages intact)"
            )

    async def _call_claude(self, session: SessionState, tool_depth: int = 0) -> None:
        """Make a streaming Claude API call with tool use."""
        if session.wrapping_up:
            return

        if tool_depth >= 3:
            print(f"[mira] Tool depth limit reached ({tool_depth}) for {session.user_id}, stopping")
            return

        if session.api_calls >= SOFT_API_LIMIT:
            print(f"[mira] API limit reached for {session.user_id}, initiating graceful shutdown")
            if not session.wrapping_up:
                session.wrapping_up = True
                await self._graceful_shutdown(session)
            return

        # Defense-in-depth: validate history before sending to Claude
        self._validate_history(session)

        # Compact old images and tool results to stay under 200k token limit
        self._compact_history(session)

        session.api_calls += 1
        model, max_tokens = self._select_model(session)
        print(f"[mira] Using {model} (max_tokens={max_tokens}) for {session.user_id}")

        # Collect full response (streaming to frontend happens via callback)
        collected_text = ""
        tool_uses = []
        print(f"[mira] Calling Claude for {session.user_id} (turn #{session.api_calls})...")

        interrupted = False
        try:
            async with self.client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=session.system_prompt,
                messages=session.conversation_history,
                tools=TOOL_DEFINITIONS,
            ) as stream:
                async for event in stream:
                    if session._interrupted:
                        interrupted = True
                        break

                    if event.type == "content_block_delta":
                        if hasattr(event.delta, "text"):
                            collected_text += event.delta.text
                            # Stream each chunk to HeyGen / frontend
                            await self._stream_text(session.user_id, event.delta.text)

                    elif event.type == "content_block_stop":
                        pass

                if not interrupted:
                    # Get the final message for tool use blocks
                    final_message = await stream.get_final_message()

            if interrupted:
                stub = collected_text.strip()
                if stub:
                    # Partial response streamed — keep it as assistant message
                    session.conversation_history.append({
                        "role": "assistant",
                        "content": [{"type": "text", "text": stub}],
                    })
                else:
                    # No text streamed yet — remove the user message that
                    # triggered this call so history stays alternating.
                    # The user's actual transcript was already forwarded
                    # via the interrupt event.
                    if (
                        session.conversation_history
                        and session.conversation_history[-1]["role"] == "user"
                    ):
                        session.conversation_history.pop()
                await self._stream_text(session.user_id, "", end_of_message=True)
                session._interrupted = False
                print(f"[mira] Interrupted stream for {session.user_id}, stub len={len(stub)}")
                return

            # Signal end-of-message so frontend flushes the sentence buffer
            if collected_text:
                print(f"[mira] AGENT SAID: {collected_text}")
                await self._stream_text(session.user_id, "", end_of_message=True)
        except Exception as e:
            print(f"[mira] Claude API call failed for {session.user_id}: {e}")
            # Pop the last user message to keep conversation history consistent
            if session.conversation_history and session.conversation_history[-1]["role"] == "user":
                session.conversation_history.pop()
            # Also pop any orphaned assistant message with tool_use blocks
            # (prevents permanent 400 errors from unmatched tool_use/tool_result pairs)
            if (
                session.conversation_history
                and session.conversation_history[-1].get("role") == "assistant"
            ):
                last_content = session.conversation_history[-1].get("content", [])
                has_tool_use = any(
                    getattr(block, "type", None) == "tool_use"
                    or (isinstance(block, dict) and block.get("type") == "tool_use")
                    for block in (last_content if isinstance(last_content, list) else [])
                )
                if has_tool_use:
                    session.conversation_history.pop()
            # Emit a fallback message so the frontend user gets verbal feedback
            fallback = "Hmm, my brain glitched for a second. What were we talking about?"
            await self._stream_text(session.user_id, fallback)
            await self._stream_text(session.user_id, "", end_of_message=True)
            return

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
            await self._handle_tool_calls(session, tool_uses, tool_depth)

    async def _handle_tool_calls(self, session: SessionState, tool_uses: list, tool_depth: int = 0) -> None:
        """Execute tool calls and continue the conversation."""
        tool_results = []

        for tool_use in tool_uses:
            # Log tool call with truncated input for terminal visibility
            input_str = json.dumps(tool_use.input)
            if len(input_str) > 200:
                input_str = input_str[:200] + "..."
            print(f"[mira] Tool call: {tool_use.name}({input_str})")

            # take_photo is handled in the orchestrator (needs Socket.io + session state)
            if tool_use.name == "take_photo":
                result = await self._handle_take_photo(session)
                # Return image content blocks directly for Claude's tool_result
                tool_result_block = {
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": result,
                }
                tool_results.append(tool_result_block)
                continue

            try:
                result = await execute_tool(
                    tool_name=tool_use.name,
                    tool_input=tool_use.input,
                    user_context={
                        "user_id": session.user_id,
                        "session_id": session.session_id,
                        "oauth_token": session.user_context.get("oauth_token"),
                    },
                )
            except Exception as e:
                print(f"[mira] Tool {tool_use.name} failed: {e}")
                result = {"error": f"Tool execution failed: {str(e)}"}

            # Parallel broadcast: send results to frontend via Socket.io
            frontend_payload = result.pop("frontend_payload", None)
            if frontend_payload and self.sio:
                payload_items = frontend_payload.get("items", [])
                items_with_flat = sum(1 for i in payload_items if i.get("cleaned_image_url") or i.get("flat_image_url"))
                items_with_type = sum(1 for i in payload_items if i.get("type") in ("top", "bottom"))
                print(f"[mira] Emitting tool_result to room={session.user_id}: type={frontend_payload.get('type')} items={len(payload_items)} with_flat_lay={items_with_flat} with_type={items_with_type}")
                if items_with_flat == 0 and len(payload_items) > 0:
                    print(f"[mira] ⚠ No items have flat lay images — canvas overlay will be empty on frontend")
                await self.sio.emit(
                    "tool_result",
                    frontend_payload,
                    room=session.user_id,
                )

            # Track items shown (display_product count — search_clothing is invisible)
            if tool_use.name == "display_product" and result.get("items"):
                session.items_shown += len(result["items"])
                if result["items"]:
                    session._last_shown_item = result["items"][0]

            tool_result_block = {
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": json.dumps(result),
            }
            if "error" in result:
                tool_result_block["is_error"] = True
            tool_results.append(tool_result_block)

        # Add tool results to conversation and continue
        session.conversation_history.append({
            "role": "user",
            "content": tool_results,
        })

        # Continue the conversation — Claude needs to process tool results
        await self._call_claude(session, tool_depth=tool_depth + 1)

    async def _handle_take_photo(self, session: SessionState) -> list:
        """Handle the take_photo tool: request a snapshot from the mirror and return it.

        Returns a list of content blocks for the tool_result (text + image, or error text).
        Uses asyncio.Future to bridge the gap between the Socket.io request and
        the snapshot response arriving via handle_event().
        """
        if session._photo_taken:
            print(f"[mira] take_photo: already used for {session.user_id}")
            return [{"type": "text", "text": "Photo already taken this session. Proceed with styling."}]

        if not self.sio:
            print(f"[mira] take_photo: no Socket.io available")
            return [{"type": "text", "text": "Camera not available. Proceed based on their purchase history."}]

        # Create a Future that handle_event() will resolve when the snapshot arrives
        loop = asyncio.get_running_loop()
        session._snapshot_future = loop.create_future()

        # Ask the mirror to capture and send back a snapshot
        print(f"[mira] take_photo: requesting snapshot from mirror for {session.user_id}")
        await self.sio.emit("request_snapshot", {"user_id": session.user_id}, room=session.user_id)

        try:
            image_base64 = await asyncio.wait_for(session._snapshot_future, timeout=5.0)
        except asyncio.TimeoutError:
            print(f"[mira] take_photo: timeout waiting for snapshot from {session.user_id}")
            session._snapshot_future = None
            return [{"type": "text", "text": "Camera timed out. Proceed with styling based on their purchase history — skip the outfit check."}]
        finally:
            session._snapshot_future = None

        session._photo_taken = True
        print(f"[mira] take_photo: got snapshot for {session.user_id} ({len(image_base64)} chars)")

        return [
            {"type": "text", "text": "Here is the photo of the user at the mirror:"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": image_base64,
                },
            },
        ]

    async def end_session(self, user_id: str) -> dict | None:
        """End a session and save summary."""
        session = self.sessions.get(user_id)
        if not session:
            return None

        session.is_active = False
        self._cancel_silence_timer(user_id)

        # Generate session summary via Claude
        try:
            summary = await self._generate_summary(session)
        except Exception as e:
            print(f"[mira] Failed to generate summary for {user_id}: {e}")
            summary = "Session ended before summary could be generated."

        # Save to DB — wrapped in error handling so a DB failure
        # doesn't prevent the session_ended event from reaching the frontend
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
        except Exception as e:
            print(f"[mira] Failed to save session summary: {e}")
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
                    "user_name": session.user_context.get("profile", {}).get("name", ""),
                },
                room=user_id,
            )

        del self.sessions[user_id]
        return {"summary": summary, "liked_items": session.liked_items}

    async def _generate_summary(self, session: SessionState) -> str:
        """Ask Claude to generate a short session summary for memory."""
        response = await self.client.messages.create(
            model=HAIKU_MODEL,
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

    async def _graceful_shutdown(self, session: SessionState) -> None:
        """Gracefully end a session when the API limit is reached.

        Generates a warm closing speech, streams it via TTS, then ends the session.
        """
        user_id = session.user_id
        self._cancel_silence_timer(user_id)

        # Generate and stream the closing speech so the user hears a goodbye
        closing_speech = await self._generate_closing_speech(session)
        await self._stream_text(user_id, closing_speech)
        await self._stream_text(user_id, "", end_of_message=True)

        # Brief pause to let TTS start playing before session teardown
        await asyncio.sleep(0.5)

        # Guard: session may have been force-ended during the sleep
        if user_id not in self.sessions:
            print(f"[mira] Session already ended for {user_id} during graceful shutdown")
            return

        # End session — saves summary, emits session_ended with recap payload
        await self.end_session(user_id)

    async def _generate_closing_speech(self, session: SessionState) -> str:
        """Generate a warm, in-character closing message from Mira.

        Separate from _generate_summary() because the summary is a clinical DB
        record, while this is a spoken goodbye the user hears via TTS.
        """
        liked_names = [item.get("title", "an item") for item in session.liked_items[:5]]
        liked_str = ", ".join(liked_names) if liked_names else "the styles we explored"

        try:
            response = await self.client.messages.create(
                model=HAIKU_MODEL,
                max_tokens=200,
                system=(
                    "You are Mira, a warm and stylish AI fashion advisor wrapping up a session. "
                    "Give a brief closing recap (2-3 sentences). Mention their favorites, give a confidence boost, "
                    "and let them know their picks are saved to their phone. "
                    "Keep it conversational — no markdown, no lists."
                ),
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Session stats: {session.items_shown} items shown, "
                            f"{session.likes} liked, {session.dislikes} passed. "
                            f"Favorites: {liked_str}. Wrap up warmly."
                        ),
                    }
                ],
            )
            return response.content[0].text
        except Exception as e:
            print(f"[mira] Closing speech generation failed, using fallback: {e}")
            return "That was a great session! Your favorites are saved to your phone. See you next time!"

    def _event_to_message(self, event: dict) -> str | list:
        """Convert an event dict to a Claude user message."""
        event_type = event.get("type")

        if event_type == "voice":
            transcript = event.get("transcript", "")
            print(f"[mira] USER SAID: {transcript}")
            return transcript

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

    async def _stream_text(self, user_id: str, text_chunk: str, end_of_message: bool = False) -> None:
        """Stream a text chunk to the frontend.

        When end_of_message is True, emits is_chunk=false so the frontend's
        SentenceBuffer flushes any remaining text (the last sentence has no
        trailing delimiter to trigger a boundary).
        """
        if end_of_message:
            print(f"[mira] Stream end-of-message to {user_id}")
        if self.sio:
            await self.sio.emit(
                "mira_speech",
                {"text": text_chunk, "is_chunk": not end_of_message},
                room=user_id,
            )

    def _start_silence_timer(self, user_id: str) -> None:
        """Start or restart the silence detection timer."""
        self._cancel_silence_timer(user_id)

        async def _silence_callback():
            await asyncio.sleep(SILENCE_TIMEOUT_SECONDS)
            session = self.sessions.get(user_id)
            if session and session.is_active and not session.is_processing:
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


# --- Recommendation Pipeline (standalone functions for REST endpoints) ---


def _outfits_to_display_payloads(outfits: list) -> list[dict]:
    """Convert REST pipeline outfit format into display_product-style payloads.

    Matches the frontend_payload shape emitted by the _display_product tool,
    so the mirror's tool_result listener can handle both paths identically.
    Items without flat lay images are skipped (raw product photos look wrong on overlay).
    """
    payloads = []
    for outfit in outfits:
        items = []
        for oi in outfit.get("items", []):
            item = oi.get("item", {})
            if not item.get("cleaned_image_url") and not item.get("flat_image_url"):
                continue
            items.append({
                "title": item.get("title", ""),
                "price": item.get("price", ""),
                "image_url": item.get("image_url", ""),
                "product_id": item.get("product_id", ""),
                "type": oi.get("type", ""),
                "cleaned_image_url": item.get("cleaned_image_url"),
                "flat_image_url": item.get("flat_image_url"),
                "link": item.get("link", ""),
                "source": item.get("source", ""),
            })
        if items:
            payloads.append({
                "type": "display_product",
                "items": items,
                "outfit_name": outfit.get("outfit_name", ""),
            })
    return payloads


def _extract_json_from_text(text: str) -> Optional[dict]:
    """Extract JSON from text that may contain markdown code blocks."""
    try:
        if "```json" in text:
            json_start = text.find("```json") + 7
            json_end = text.find("```", json_start)
            return json.loads(text[json_start:json_end].strip())
        elif "```" in text:
            json_start = text.find("```") + 3
            json_end = text.find("```", json_start)
            return json.loads(text[json_start:json_end].strip())
        else:
            return json.loads(text.strip())
    except json.JSONDecodeError:
        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            return json.loads(text[start:end])
        except (json.JSONDecodeError, ValueError):
            return None


async def generate_outfit_recommendations(
    user_id: str, session_id: str, db: NeonHTTPClient
) -> Dict:
    """
    Orchestrate the full recommendation flow.

    1. Fetch user data (profile + purchases + top brands)
    2. Handle new users (check if needs onboarding)
    3. Call Serper directly to fetch clothing items
    4. Send user context + clothing items to Claude in a single call
    5. Parse final JSON response
    6. Generate flat lay images + save to DB in parallel
    7. Return results
    """
    from agent.tools import execute_give_recommendation, _select_diverse_items
    from services.serper_cache import serper_cache

    start_time = time.time()

    try:
        # Step 1: Fetch user data
        user_data = await get_user_profile_and_purchases(db, user_id)
        if not user_data:
            return create_error_response("user_not_found", "Unknown User")

        # Step 2: Check if new user needs onboarding
        if await is_new_user(db, user_id):
            return {
                "status": "needs_onboarding",
                "message": "User needs to complete onboarding questionnaire",
            }

        # Step 3: Call Serper directly (no Claude tool loop)
        top_brands = user_data.get("top_brands", [])
        style_profile = user_data.get("style_profile")
        gender = "mens"
        if style_profile:
            gender = style_profile.get("gender", "mens")

        tool_input = {"brands": top_brands[:5] if top_brands else [], "gender": gender}
        print(f"[Mira] Fetching clothing from Serper (brands={tool_input['brands']}, gender={gender})")
        clothing_text = await execute_give_recommendation(tool_input, session_id)

        if clothing_text.startswith("Error:") or clothing_text.startswith("No clothing"):
            return create_error_response("no_results", user_data["user"]["name"])

        # Step 4: Single Claude call with clothing items already in the prompt
        cached_items = serper_cache.get(session_id) or []
        tops = [i for i in cached_items if i.get("clothing_category") == "top"]
        bottoms = [i for i in cached_items if i.get("clothing_category") == "bottom"]
        limited_items = _select_diverse_items(tops, 10) + _select_diverse_items(bottoms, 10)

        system_prompt = get_mira_system_prompt()
        user_prompt = build_recommendation_prompt(user_data, limited_items)

        # Step 4b: Pre-generate flat lays for ALL candidate items in parallel with Claude
        async def _pregenerate_flat_lays():
            """Generate flat lays for all candidate items while Claude thinks."""
            try:
                from services.gemini_flatlay import generate_flat_lays_batch
                items_for_flatlay = [
                    {"image_url": i["image_url"], "title": i["title"], "product_id": i["product_id"]}
                    for i in limited_items if i.get("image_url") and i.get("product_id")
                ]
                if items_for_flatlay:
                    print(f"[Mira] Generating flat lay images for {len(items_for_flatlay)} items...")
                    return await generate_flat_lays_batch(items_for_flatlay)
            except ImportError:
                print("[Mira] Gemini flat lay service not available, skipping")
            except Exception as e:
                print(f"[Mira] Flat lay generation failed (non-fatal): {e}")
            return {}

        # Run Claude + flat lays in parallel
        claude_response, flat_lay_map = await asyncio.gather(
            anthropic_client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=6144,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            ),
            _pregenerate_flat_lays(),
        )

        # Extract JSON from Claude response
        recommendations = None
        for block in claude_response.content:
            if hasattr(block, "text"):
                recommendations = _extract_json_from_text(block.text)
                break

        if not recommendations:
            return create_error_response("api_error", user_data["user"]["name"])

        # Step 5: Map flat lays to selected outfit items + save to DB
        outfits = recommendations.get("outfits", [])

        # Attach flat lay images as both flat_image_url and cleaned_image_url
        for outfit in outfits:
            for outfit_item in outfit.get("items", []):
                item = outfit_item.get("item", {})
                pid = item.get("product_id", "")
                if pid in flat_lay_map:
                    item["flat_image_url"] = flat_lay_map[pid]
                    item["cleaned_image_url"] = flat_lay_map[pid]

        outfit_ids = await save_outfits_to_database(db, session_id, outfits)

        # Attach database IDs to each outfit in the response
        for outfit in outfits:
            name = outfit.get("outfit_name", "")
            if name in outfit_ids:
                outfit["id"] = outfit_ids[name]

        # Step 6: Return results
        generation_time_ms = int((time.time() - start_time) * 1000)

        return {
            "status": "success",
            "data": recommendations,
            "generation_time_ms": generation_time_ms,
        }

    except Exception as e:
        print(f"Error generating recommendations: {e}")
        return create_error_response("api_error", "there")


def create_error_response(error_type: str, user_name: str) -> Dict:
    """
    Generate in-character error messages from Mira.

    Types: "no_results", "new_user", "api_error", "no_brands", "user_not_found"
    """
    error_messages = {
        "no_results": {
            "status": "error",
            "error_type": "no_results",
            "message": f"Hey {user_name}! I tried searching for new pieces from your favorite brands, but I'm not finding much right now. This could be a temporary glitch with the shopping search. Want to try again in a minute?",
        },
        "new_user": {
            "status": "needs_onboarding",
            "message": f"Hi {user_name}! I'd love to help you pick out some outfits, but I don't know your style yet. Let's do a quick questionnaire so I can get to know your taste!",
        },
        "api_error": {
            "status": "error",
            "error_type": "api_error",
            "message": f"Oof, {user_name} — something went wrong on my end. Technical difficulties! Give me a sec and let's try again.",
        },
        "no_brands": {
            "status": "error",
            "error_type": "no_brands",
            "message": f"Hey {user_name}! I don't have any brands to search yet. Have you done any shopping recently, or want to tell me your favorite brands in the onboarding?",
        },
        "user_not_found": {
            "status": "error",
            "error_type": "user_not_found",
            "message": "I can't find your profile. Are you logged in?",
        },
    }

    return error_messages.get(error_type, error_messages["api_error"])


async def update_outfit_reaction(
    db: NeonHTTPClient, outfit_id: str, reaction: str
) -> Dict:
    """
    Update user reaction for an outfit.

    Args:
        db: Database client
        outfit_id: UUID of the outfit
        reaction: "liked", "disliked", or "skipped"
    """
    try:
        query = """
            UPDATE session_outfits
            SET reaction = $1
            WHERE id = $2
            RETURNING id
        """
        result = await db.execute(query, [reaction, outfit_id])

        if not result:
            return {"status": "error", "message": "Outfit not found"}

        return {"status": "success"}

    except Exception as e:
        print(f"Error updating outfit reaction: {e}")
        return {"status": "error", "message": "Failed to update reaction"}
