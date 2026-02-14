from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import socketio

from routers import auth, queue, users
from scraper.routes import router as scraper_router

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

app = FastAPI(title="Mirrorless API", version="0.1.0")

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

# Make sio accessible to routes
app.state.sio = sio


@app.get("/health")
async def health():
    return {"status": "ok"}


@sio.event
async def connect(sid, environ):
    print(f"[socket] Client connected: {sid}")


@sio.event
async def join_room(sid, data):
    """Client joins a user-specific room for targeted events."""
    user_id = data.get("user_id")
    if user_id:
        sio.enter_room(sid, user_id)
        print(f"[socket] {sid} joined room {user_id}")


@sio.event
async def disconnect(sid):
    print(f"[socket] Client disconnected: {sid}")


# Wrap FastAPI with Socket.io ASGI app
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)
