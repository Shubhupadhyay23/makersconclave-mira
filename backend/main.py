from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
import socketio

from routers import auth, queue, users
from scraper.routes import router as scraper_router
from agent.orchestrator import MiraOrchestrator

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=[])

app = FastAPI(title="Mirrorless API", version="0.1.0")

app.include_router(auth.router)
app.include_router(queue.router)
app.include_router(users.router)
app.include_router(scraper_router)

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
        print(f"[socket] {sid} joined room {user_id}")


@sio.event
async def disconnect(sid):
    print(f"[socket] Client disconnected: {sid}")


@sio.event
async def start_session(sid, data):
    """Start a Mira session for a user."""
    user_id = data.get("user_id")
    if not user_id:
        return
    print(f"[mira] Starting session for user {user_id}")
    await mira.start_session(user_id)


@sio.event
async def mirror_event(sid, data):
    """Handle events from the mirror (voice, gesture, pose, snapshot)."""
    user_id = data.get("user_id")
    event = data.get("event", {})
    if not user_id or not event:
        return
    await mira.handle_event(user_id, event)


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


# Wrap FastAPI with Socket.io, then wrap everything with CORS
_asgi_app = socketio.ASGIApp(sio, other_asgi_app=app)
socket_app = CORSMiddleware(
    _asgi_app,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
