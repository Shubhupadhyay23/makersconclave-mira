from uuid import UUID

from fastapi import FastAPI, HTTPException
from starlette.middleware.cors import CORSMiddleware
import socketio

from routers import auth, queue, users, tts
from scraper.routes import router as scraper_router
from judges.routes import router as judges_router
from agent.orchestrator import MiraOrchestrator, generate_outfit_recommendations, update_outfit_reaction, _outfits_to_display_payloads
from models.database import get_neon_client
from models.schemas import OnboardingQuestionnaireResponse, OutfitReactionUpdate
from services.user_data_service import save_onboarding_data

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
async def photo_response(sid, data):
    """Handle photo responses from the mirror (bypasses handle_event to avoid deadlock)."""
    user_id = data.get("user_id")
    image_base64 = data.get("image_base64")
    if not user_id or not image_base64:
        return
    resolved = mira.resolve_photo(user_id, image_base64)
    if not resolved:
        print(f"[socket] photo_response: no pending request for {user_id}")


@sio.event
async def end_session(sid, data):
    """End a Mira session."""
    user_id = data.get("user_id")
    if not user_id:
        return
    print(f"[mira] Ending session for user {user_id}")
    result = await mira.end_session(user_id)
    if result:
        await sio.emit("session_recap", result, room=user_id)


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
