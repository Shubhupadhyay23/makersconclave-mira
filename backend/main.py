from uuid import UUID

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
import socketio

from routers import auth, queue, users
from scraper.routes import router as scraper_router
from judges.routes import router as judges_router
from agent.orchestrator import MiraOrchestrator

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# Map socket IDs to user IDs for disconnect cleanup
_sid_to_user: dict[str, str] = {}

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

# Make sio and Mira accessible to routes
app.state.sio = sio
mira = MiraOrchestrator(socket_io=sio)
app.state.mira = mira


@app.get("/health")
async def health():
    return {"status": "ok"}


# --- Socket.io events ---


@sio.event
async def connect(sid, environ):
    print(f"[socket] Client connected: {sid}")


@sio.event
async def join_room(sid, data):
    """Client joins a user-specific room for targeted events."""
    user_id = data.get("user_id")
    if user_id:
        await sio.enter_room(sid, user_id)
        _sid_to_user[sid] = user_id
        print(f"[socket] {sid} joined room {user_id}")


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
        await sio.emit("session_error", {"error": f"Invalid user ID: must be a valid UUID"}, to=sid)
        return

    print(f"[mira] Starting session for user {user_id}")
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
    try:
        await mira.handle_event(user_id, event)
    except Exception as e:
        print(f"[mira] mirror_event failed for {user_id}: {e}")
        await sio.emit("session_error", {"error": f"Event processing failed: {e}"}, to=sid)


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


# Wrap FastAPI with Socket.io — no outer CORS wrapper needed
# (Socket.io has its own CORS via cors_allowed_origins, FastAPI has its own middleware)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)
