"""Admin endpoints: queue management, session info, booth stats."""

from fastapi import APIRouter, Request

from models.database import NeonHTTPClient

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/queue")
async def get_admin_queue():
    """Full queue with user names and statuses."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            SELECT q.id, q.user_id, u.name, q.position, q.status, q.joined_at
            FROM queue q
            JOIN users u ON u.id = q.user_id
            WHERE q.status IN ('waiting', 'active')
            ORDER BY q.position
            """,
        )
        return [
            {
                "id": str(r["id"]),
                "user_id": str(r["user_id"]),
                "name": r["name"],
                "position": r["position"],
                "status": r["status"],
                "joined_at": str(r["joined_at"]) if r.get("joined_at") else None,
            }
            for r in (rows or [])
        ]
    finally:
        await db.close()


@router.get("/session")
async def get_admin_session():
    """Current active session info."""
    db = NeonHTTPClient()
    try:
        # Find the active queue user
        active_rows = await db.execute(
            """
            SELECT q.user_id, u.name, u.email
            FROM queue q
            JOIN users u ON u.id = q.user_id
            WHERE q.status = 'active'
            LIMIT 1
            """,
        )
        if not active_rows:
            return None

        user_id = str(active_rows[0]["user_id"])

        # Find active session for this user
        session_rows = await db.execute(
            """
            SELECT id FROM sessions
            WHERE user_id = $1::uuid AND status = 'active'
            ORDER BY started_at DESC LIMIT 1
            """,
            [user_id],
        )

        session_id = None
        api_calls = 0
        if session_rows:
            session_id = str(session_rows[0]["id"])
            api_calls = 0  # tracked in-memory by orchestrator, not persisted to DB

        # Count items shown/liked for this session
        items_shown = 0
        items_liked = 0
        if session_id:
            shown_val = await db.fetchval(
                "SELECT COUNT(*) FROM session_outfits WHERE session_id = $1::uuid",
                [session_id],
            )
            items_shown = int(shown_val) if shown_val else 0

            liked_val = await db.fetchval(
                "SELECT COUNT(*) FROM session_outfits WHERE session_id = $1::uuid AND reaction = 'liked'",
                [session_id],
            )
            items_liked = int(liked_val) if liked_val else 0

        return {
            "user_id": user_id,
            "name": active_rows[0]["name"],
            "session_id": session_id,
            "api_calls": api_calls,
            "items_shown": items_shown,
            "items_liked": items_liked,
        }
    finally:
        await db.close()


@router.get("/stats")
async def get_booth_stats():
    """Booth stats: total users today, avg session length, items shown/liked."""
    db = NeonHTTPClient()
    try:
        total_today = await db.fetchval(
            """
            SELECT COUNT(DISTINCT user_id) FROM queue
            WHERE joined_at::date = CURRENT_DATE
            """,
        )

        avg_seconds = await db.fetchval(
            """
            SELECT COALESCE(
                AVG(EXTRACT(EPOCH FROM (ended_at - started_at))), 0
            )
            FROM sessions
            WHERE started_at::date = CURRENT_DATE AND status = 'completed'
            """,
        )

        total_shown = await db.fetchval(
            """
            SELECT COUNT(*) FROM session_outfits oi
            JOIN sessions s ON s.id = oi.session_id
            WHERE s.started_at::date = CURRENT_DATE
            """,
        )

        total_liked = await db.fetchval(
            """
            SELECT COUNT(*) FROM session_outfits oi
            JOIN sessions s ON s.id = oi.session_id
            WHERE s.started_at::date = CURRENT_DATE AND oi.reaction = 'liked'
            """,
        )

        return {
            "total_users_today": int(total_today) if total_today else 0,
            "avg_session_seconds": float(avg_seconds) if avg_seconds else 0,
            "total_items_shown": int(total_shown) if total_shown else 0,
            "total_items_liked": int(total_liked) if total_liked else 0,
        }
    finally:
        await db.close()


@router.post("/force-end")
async def force_end_session(request: Request):
    """Force-end the current active session."""
    sio = request.app.state.sio
    db = NeonHTTPClient()
    try:
        active_rows = await db.execute(
            """
            SELECT q.user_id FROM queue q
            WHERE q.status = 'active' LIMIT 1
            """,
        )
        if not active_rows:
            return {"status": "no_active_session"}

        user_id = str(active_rows[0]["user_id"])
        await sio.emit("session_force_end", {"user_id": user_id}, room="mirror")
        await sio.emit("session_force_end", {"user_id": user_id}, room=user_id)

        return {"status": "force_ended", "user_id": user_id}
    finally:
        await db.close()
