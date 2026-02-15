import asyncio
import json
import os
import uuid
from uuid import UUID

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from starlette.middleware.cors import CORSMiddleware
import socketio

from routers import auth, queue, users, tts, admin
from scraper.routes import router as scraper_router
from judges.routes import router as judges_router
from agent.orchestrator import MiraOrchestrator, generate_outfit_recommendations, update_outfit_reaction, _outfits_to_display_payloads
from models.database import get_neon_client
from models.schemas import OnboardingQuestionnaireResponse, OutfitReactionUpdate
from services.user_data_service import save_onboarding_data
from services.serper_search import build_brand_queries, fetch_clothing_batch
from services.gemini_flatlay import generate_flat_lays_batch

load_dotenv()

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# Map socket IDs to user IDs for disconnect cleanup
_sid_to_user: dict[str, str] = {}

# Create FastAPI app
app = FastAPI(title="Mirrorless API", version="0.1.0")

# CORS on FastAPI only — Socket.io handles its own CORS via cors_allowed_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(queue.router)
app.include_router(users.router)
app.include_router(scraper_router)
app.include_router(judges_router)
app.include_router(tts.router)
app.include_router(admin.router)

# Make sio and Mira accessible to routes
app.state.sio = sio
mira = MiraOrchestrator(socket_io=sio)
app.state.mira = mira


@app.get("/health")
async def health():
    return {"status": "ok"}



# --- REST API endpoints for recommendations ---


@app.post("/api/sessions/{session_id}/recommendations")
async def create_outfit_recommendations(session_id: str):
    """
    Generate recommendations for active session.

    1. Verify session exists and is active
    2. Get user_id from session
    3. Call generate_outfit_recommendations()
    4. Handle new user case (return needs_onboarding)
    5. Return results
    """
    db = await get_neon_client()

    try:
        # Get session info
        print(f"[API] Recommendations requested for session: {session_id}")
        session_query = "SELECT * FROM sessions WHERE id = $1::uuid AND status = 'active'"
        session_rows = await db.execute(session_query, [session_id])

        if not session_rows:
            raise HTTPException(status_code=404, detail="Active session not found")

        session = session_rows[0]
        user_id = str(session["user_id"])

        # Generate recommendations
        result = await generate_outfit_recommendations(user_id, session_id, db)

        # Also emit to mirror display via socket so ClothingCanvas picks it up
        if result.get("status") == "success" and result.get("data"):
            payloads = _outfits_to_display_payloads(result["data"].get("outfits", []))
            for payload in payloads:
                await sio.emit("tool_result", payload, room=user_id)

        return result

    finally:
        await db.close()


@app.patch("/api/outfits/{outfit_id}/reaction")
async def update_outfit_reaction_endpoint(
    outfit_id: str, body: OutfitReactionUpdate
):
    """
    Record user reaction (liked/disliked/skipped).
    """
    db = await get_neon_client()

    try:
        result = await update_outfit_reaction(db, outfit_id, body.reaction)
        return result

    finally:
        await db.close()


@app.post("/api/users/{user_id}/onboarding")
async def complete_onboarding(
    user_id: str, questionnaire: OnboardingQuestionnaireResponse
):
    """
    Save onboarding questionnaire to style_profiles table.
    Enables recommendations for new users without purchase history.
    """
    db = await get_neon_client()

    try:
        await save_onboarding_data(db, user_id, questionnaire.dict())
        return {"status": "success", "message": "Onboarding completed"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save onboarding: {e}")

    finally:
        await db.close()


# --- Test endpoint: recommendation pipeline ---


@app.post("/api/test/recommend")
async def test_recommend(body: dict):
    """
    Test endpoint combining Serper search → Claude Haiku outfit curation →
    Nano Banana flat lays → transparent overlay images.

    Expects: { brands: string[], gender: string, style_notes: string }
    Returns: { outfits: [{ outfit_name, voice, items: [{ id, category, imageUrl, name }] }] }
    """
    brands = body.get("brands", ["Nike", "Zara", "H&M"])
    gender = body.get("gender", "mens")
    style_notes = body.get("style_notes", "casual")

    serper_key = os.getenv("SERPER_API_KEY")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")

    if not serper_key:
        raise HTTPException(status_code=500, detail="SERPER_API_KEY not configured")
    if not anthropic_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")

    # Step 1: Serper search for tops + bottoms
    print(f"[test/recommend] Searching for {brands} ({gender}, {style_notes})")
    brand_queries = build_brand_queries(brands[:5], gender)

    tops_items, bottoms_items = await asyncio.gather(
        fetch_clothing_batch(brand_queries["tops"], serper_key, num_results_per_query=3),
        fetch_clothing_batch(brand_queries["bottoms"], serper_key, num_results_per_query=3),
    )

    # Limit to reasonable count before sending to Claude
    tops_items = tops_items[:15]
    bottoms_items = bottoms_items[:15]

    print(f"[test/recommend] Found {len(tops_items)} tops, {len(bottoms_items)} bottoms")

    if not tops_items and not bottoms_items:
        return {"outfits": []}

    # Step 2: Claude Haiku picks 2 outfits with Mira commentary
    tops_list = "\n".join(
        f"  T{i}: {t['title']} | {t['price']} | {t['source']} | pid:{t['product_id']} | img:{t['image_url']}"
        for i, t in enumerate(tops_items)
    )
    bottoms_list = "\n".join(
        f"  B{i}: {b['title']} | {b['price']} | {b['source']} | pid:{b['product_id']} | img:{b['image_url']}"
        for i, b in enumerate(bottoms_items)
    )

    claude_prompt = f"""You are Mira, an AI fashion stylist. Pick exactly 2 outfit combinations from the items below.
Style: {style_notes}. Gender: {gender}.

TOPS:
{tops_list}

BOTTOMS:
{bottoms_list}

For each outfit pick ONE top and ONE bottom that go well together. Write a short voice line (1-2 sentences) explaining why you picked it.

Reply ONLY with valid JSON (no markdown):
{{
  "outfits": [
    {{
      "outfit_name": "Name of outfit",
      "voice": "Your voice line",
      "top_index": 0,
      "bottom_index": 0
    }},
    {{
      "outfit_name": "Name of outfit 2",
      "voice": "Your voice line 2",
      "top_index": 1,
      "bottom_index": 1
    }}
  ]
}}"""

    client = AsyncAnthropic(
        api_key=anthropic_key,
        default_headers={"anthropic-beta": "oauth-2025-04-20"},
    )

    try:
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": claude_prompt}],
        )
        raw_text = response.content[0].text.strip()
        # Strip markdown fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        claude_picks = json.loads(raw_text)
    except Exception as e:
        print(f"[test/recommend] Claude failed: {e}")
        # Fallback: just pick first items
        claude_picks = {
            "outfits": [
                {"outfit_name": "Outfit 1", "voice": "Here's a great look!", "top_index": 0, "bottom_index": 0},
                {"outfit_name": "Outfit 2", "voice": "Try this combo too!", "top_index": min(1, len(tops_items) - 1), "bottom_index": min(1, len(bottoms_items) - 1)},
            ]
        }

    # Step 3: Collect selected items and generate Nano Banana flat lays
    selected_items = []
    outfit_map = []  # Track which items belong to which outfit

    for pick in claude_picks.get("outfits", [])[:2]:
        ti = pick.get("top_index", 0) % max(len(tops_items), 1)
        bi = pick.get("bottom_index", 0) % max(len(bottoms_items), 1)

        top = tops_items[ti] if tops_items else None
        bottom = bottoms_items[bi] if bottoms_items else None

        outfit_entry = {"name": pick.get("outfit_name", "Outfit"), "voice": pick.get("voice", ""), "top": top, "bottom": bottom}
        outfit_map.append(outfit_entry)

        if top and top not in selected_items:
            selected_items.append(top)
        if bottom and bottom not in selected_items:
            selected_items.append(bottom)

    # Generate flat lays for all selected items
    flatlay_input = [
        {"image_url": item["image_url"], "title": item["title"], "product_id": item["product_id"]}
        for item in selected_items
        if item.get("image_url") and item.get("product_id")
    ]

    flat_lay_map = {}
    if flatlay_input:
        try:
            flat_lay_map = await generate_flat_lays_batch(flatlay_input)
            print(f"[test/recommend] Generated {len(flat_lay_map)} flat lays")
        except Exception as e:
            print(f"[test/recommend] Flat lay generation failed: {e}")

    # Step 4: Build response in frontend-expected format
    result_outfits = []
    for entry in outfit_map:
        items = []
        if entry["top"]:
            pid = entry["top"]["product_id"]
            image_url = flat_lay_map.get(pid, entry["top"]["image_url"])
            items.append({
                "id": f"top-{uuid.uuid4().hex[:8]}",
                "category": "tops",
                "imageUrl": image_url,
                "name": entry["top"]["title"],
            })
        if entry["bottom"]:
            pid = entry["bottom"]["product_id"]
            image_url = flat_lay_map.get(pid, entry["bottom"]["image_url"])
            items.append({
                "id": f"bottom-{uuid.uuid4().hex[:8]}",
                "category": "bottoms",
                "imageUrl": image_url,
                "name": entry["bottom"]["title"],
            })

        result_outfits.append({
            "outfit_name": entry["name"],
            "voice": entry["voice"],
            "items": items,
        })

    print(f"[test/recommend] Returning {len(result_outfits)} outfits")
    return {"outfits": result_outfits}


# --- Socket.io events ---


@sio.event
async def connect(sid, environ):
    print(f"[socket] Client connected: {sid}")


@sio.event
async def join_room(sid, data):
    """Client joins a user-specific room for targeted events.

    Supports both mirror_id (mirror display) and user_id (phone/Poke).
    """
    user_id = data.get("user_id")
    mirror_id = data.get("mirror_id")
    room = mirror_id or user_id
    if room:
        await sio.enter_room(sid, room)
        _sid_to_user[sid] = room
        print(f"[socket] {sid} joined room {room}")


@sio.event
async def join_mirror_room(sid, data=None):
    """Mirror display joins the 'mirror' broadcast room."""
    await sio.enter_room(sid, "mirror")
    _sid_to_user[sid] = "mirror"
    print(f"[socket] {sid} joined mirror room")

    # Send current queue state so the mirror doesn't miss already-active users
    from routers.queue import get_queue_snapshot

    db = await get_neon_client()
    try:
        snapshot = await get_queue_snapshot(db)
        await sio.emit("queue_updated", snapshot, to=sid)
    except Exception as e:
        print(f"[socket] Failed to send queue snapshot to mirror: {e}")
    finally:
        await db.close()


@sio.event
async def disconnect(sid):
    print(f"[socket] Client disconnected: {sid}")
    user_id = _sid_to_user.pop(sid, None)
    if user_id and user_id in mira.sessions:
        try:
            await mira.end_session(user_id)
            print(f"[socket] Cleaned up session for {user_id}")
        except Exception as e:
            print(f"[socket] Failed to clean up session for {user_id}: {e}")


def _is_valid_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


@sio.event
async def start_session(sid, data):
    """Start a Mira session for a user."""
    user_id = data.get("user_id")
    if not user_id:
        return

    if not _is_valid_uuid(user_id):
        print(f"[mira] Invalid UUID from {sid}: {user_id}")
        await sio.emit(
            "session_error",
            {"error": "Invalid user ID: must be a valid UUID"},
            to=sid,
        )
        return

    print(f"[mira] Starting session for user {user_id}")
    # Notify frontend that session is active (starts avatar + STT)
    await sio.emit("session_active", {"user_id": user_id}, room=user_id)
    try:
        await mira.start_session(user_id)
    except Exception as e:
        print(f"[mira] start_session failed for {user_id}: {e}")
        await sio.emit("session_error", {"error": f"Failed to start session: {e}"}, to=sid)


@sio.event
async def mirror_event(sid, data):
    """Handle events from the mirror (voice, gesture, pose, snapshot)."""
    user_id = data.get("user_id")
    event = data.get("event", {})

    # Backward-compat: legacy frontend sends snapshot at top level instead of
    # nested under "event". Detect and wrap it so the orchestrator receives it.
    if not event and data.get("type") == "snapshot":
        event = {"type": "snapshot", "image_base64": data.get("image_base64", "")}

    if not user_id or not event:
        return
    event_type = event.get("type", "unknown")
    if event_type == "voice":
        print(f"[socket] mirror_event voice from {user_id}: {event.get('transcript', '')[:120]}")
    else:
        print(f"[socket] mirror_event {event_type} from {user_id}")
    try:
        await mira.handle_event(user_id, event)
    except Exception as e:
        print(f"[mira] mirror_event failed for {user_id}: {e}")
        await sio.emit("session_error", {"error": f"Event processing failed: {e}"}, to=sid)


@sio.event
async def interrupt(sid, data):
    """Interrupt Mira's current response so the user can speak."""
    user_id = data.get("user_id")
    if user_id:
        print(f"[socket] interrupt from {user_id}")
        await mira.interrupt(user_id)


@sio.event
async def end_session(sid, data):
    """End a Mira session and auto-advance the queue."""
    user_id = data.get("user_id")
    if not user_id:
        return
    print(f"[mira] Ending session for user {user_id}")
    result = await mira.end_session(user_id)
    if result:
        await sio.emit("session_recap", result, room=user_id)
        await sio.emit("session_ended", result, room=user_id)

    # Auto-advance queue: mark current active as completed, promote next
    await _auto_advance_queue(user_id)


async def _auto_advance_queue(user_id: str):
    """Complete the active queue user and advance the next one."""
    from routers.queue import _try_advance_next, get_queue_snapshot
    from models.database import NeonHTTPClient
    db = NeonHTTPClient()
    try:
        await db.execute(
            "UPDATE queue SET status = 'completed' WHERE user_id = $1::uuid AND status = 'active'",
            [user_id],
        )
        await _try_advance_next(db)
        snapshot = await get_queue_snapshot(db)
        await sio.emit("queue_updated", snapshot, room="mirror")
        print(f"[queue] Advanced queue. Active: {snapshot.get('active_user')}")
    finally:
        await db.close()


@sio.event
async def session_started(sid, data):
    """
    Auto-trigger recommendation generation when session starts via Socket.io.

    Expected data: {
        "session_id": "uuid",
        "user_id": "uuid"
    }
    """
    session_id = data.get("session_id")
    user_id = data.get("user_id")

    if not session_id or not user_id:
        await sio.emit("error", {"message": "Missing session_id or user_id"}, room=sid)
        return

    # Emit start event
    await sio.emit("outfit_generation_started", {"session_id": session_id}, room=sid)

    # Generate recommendations
    db = await get_neon_client()
    try:
        result = await generate_outfit_recommendations(user_id, session_id, db)

        # Emit as individual display_product payloads so the mirror's
        # tool_result → ClothingCanvas path handles them (not outfits_ready)
        if result.get("status") == "success" and result.get("data"):
            payloads = _outfits_to_display_payloads(result["data"].get("outfits", []))
            for payload in payloads:
                await sio.emit("tool_result", payload, room=sid)

    except Exception as e:
        await sio.emit(
            "error",
            {"message": f"Failed to generate recommendations: {str(e)}"},
            room=sid,
        )

    finally:
        await db.close()


# Wrap FastAPI with Socket.io — no outer CORS wrapper needed
# (Socket.io has its own CORS via cors_allowed_origins, FastAPI has its own middleware)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)
