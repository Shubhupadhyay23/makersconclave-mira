"""Queue endpoints: join, status, skip, reorder, advance, start-session."""

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from models.database import NeonHTTPClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/queue", tags=["queue"])


class QueueJoinRequest(BaseModel):
    user_id: str


class ReorderRequest(BaseModel):
    user_ids: list[str]


class StartSessionRequest(BaseModel):
    user_id: str


async def get_queue_snapshot(db) -> dict:
    """Build a queue snapshot payload for socket emission."""
    active_rows = await db.execute(
        """
        SELECT q.user_id, u.name FROM queue q
        JOIN users u ON u.id = q.user_id
        WHERE q.status = 'active'
        ORDER BY q.position LIMIT 1
        """,
    )
    active_user = None
    if active_rows:
        active_user = {"id": str(active_rows[0]["user_id"]), "name": active_rows[0]["name"]}

    queue_rows = await db.execute(
        """
        SELECT q.id, q.user_id, u.name, q.position, q.status
        FROM queue q
        JOIN users u ON u.id = q.user_id
        WHERE q.status IN ('waiting', 'active')
        ORDER BY q.position
        """,
    )
    queue_list = [
        {
            "id": str(r["id"]),
            "user_id": str(r["user_id"]),
            "name": r["name"],
            "position": r["position"],
            "status": r["status"],
        }
        for r in (queue_rows or [])
    ]
    return {"active_user": active_user, "queue": queue_list}


async def _emit_queue_updated(request: Request, db):
    """Emit queue_updated event to the mirror room."""
    sio = request.app.state.sio
    snapshot = await get_queue_snapshot(db)
    await sio.emit("queue_updated", snapshot, room="mirror")


@router.post("/join")
async def join_queue(body: QueueJoinRequest, request: Request):
    """Add user to queue or return existing entry."""
    db = NeonHTTPClient()
    try:
        # Check if user already has a waiting/active queue entry
        existing = await db.execute(
            """
            SELECT id, position, status FROM queue
            WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
            """,
            [body.user_id],
        )
        if existing:
            row = existing[0]
            total_ahead = await db.fetchval(
                """
                SELECT COUNT(*) FROM queue
                WHERE status = 'waiting' AND position < $1
                """,
                [row["position"]],
            )
            # Emit so the mirror learns about the active user even on re-join
            await _emit_queue_updated(request, db)
            return {
                "queue_id": row["id"],
                "position": row["position"],
                "status": row["status"],
                "total_ahead": total_ahead,
            }

        # Calculate next position
        max_pos = await db.fetchval(
            "SELECT COALESCE(MAX(position), 0) FROM queue WHERE status IN ('waiting', 'active')"
        )
        next_position = int(max_pos) + 1

        rows = await db.execute(
            """
            INSERT INTO queue (user_id, position)
            VALUES ($1::uuid, $2)
            ON CONFLICT (user_id) WHERE status IN ('waiting', 'active') DO NOTHING
            RETURNING id, position, status
            """,
            [body.user_id, next_position],
        )
        if not rows:
            # Race condition: another request inserted between our SELECT and INSERT.
            # Fetch the existing entry instead.
            existing = await db.execute(
                """
                SELECT id, position, status FROM queue
                WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
                """,
                [body.user_id],
            )
            if existing:
                row = existing[0]
                await _emit_queue_updated(request, db)
                return {
                    "queue_id": row["id"],
                    "position": row["position"],
                    "status": row["status"],
                    "total_ahead": 0,
                }
            raise HTTPException(status_code=500, detail="Failed to join queue")
        row = rows[0]
        total_ahead = await db.fetchval(
            """
            SELECT COUNT(*) FROM queue
            WHERE status = 'waiting' AND position < $1
            """,
            [row["position"]],
        )

        # Auto-activate the first waiting user if no one is currently active
        active_count = await db.fetchval(
            "SELECT COUNT(*) FROM queue WHERE status = 'active'"
        )
        if int(active_count) == 0:
            activated = await db.execute(
                """
                UPDATE queue SET status = 'active'
                WHERE id = (
                    SELECT id FROM queue
                    WHERE status = 'waiting'
                    ORDER BY position ASC
                    LIMIT 1
                )
                RETURNING id
                """,
            )
            if activated and str(activated[0]["id"]) == str(row["id"]):
                row["status"] = "active"

        await _emit_queue_updated(request, db)

        return {
            "queue_id": row["id"],
            "position": row["position"],
            "status": row["status"],
            "total_ahead": total_ahead,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to join queue for user %s", body.user_id)
        raise HTTPException(status_code=500, detail=f"Failed to join queue: {exc}")
    finally:
        await db.close()


@router.get("/status/{user_id}")
async def queue_status(user_id: str):
    """Get current queue status for a user."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            SELECT id, position, status FROM queue
            WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
            ORDER BY joined_at DESC LIMIT 1
            """,
            [user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="No queue entry found")

        row = rows[0]
        total_ahead = await db.fetchval(
            """
            SELECT COUNT(*) FROM queue
            WHERE status = 'waiting' AND position < $1
            """,
            [row["position"]],
        )
        return {
            "queue_id": row["id"],
            "position": row["position"],
            "status": row["status"],
            "total_ahead": total_ahead,
        }
    finally:
        await db.close()


@router.post("/leave/{user_id}")
async def leave_queue(user_id: str, request: Request):
    """User voluntarily leaves the queue."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            UPDATE queue SET status = 'completed'
            WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
            RETURNING id, status
            """,
            [user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="No queue entry found")

        await _try_advance_next(db)
        await _emit_queue_updated(request, db)

        return {"status": "left"}
    finally:
        await db.close()


@router.post("/skip/{user_id}")
async def skip_queue_user(user_id: str, request: Request):
    """Skip a user in the queue (mark as completed)."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            UPDATE queue SET status = 'completed'
            WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
            RETURNING id
            """,
            [user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="No active queue entry for user")

        # If this was the active user, advance the next one
        await _try_advance_next(db)
        await _emit_queue_updated(request, db)

        return {"status": "skipped"}
    finally:
        await db.close()


@router.patch("/reorder")
async def reorder_queue(body: ReorderRequest, request: Request):
    """Reorder queue by providing user_ids in desired order."""
    db = NeonHTTPClient()
    try:
        for idx, uid in enumerate(body.user_ids):
            await db.execute(
                """
                UPDATE queue SET position = $1
                WHERE user_id = $2::uuid AND status IN ('waiting', 'active')
                """,
                [idx + 1, uid],
            )
        await _emit_queue_updated(request, db)
        return {"status": "reordered"}
    finally:
        await db.close()


@router.post("/advance")
async def advance_queue(request: Request):
    """Mark current active user as completed and advance the next one."""
    db = NeonHTTPClient()
    try:
        # Complete the current active user
        await db.execute(
            "UPDATE queue SET status = 'completed' WHERE status = 'active'"
        )
        result = await _try_advance_next(db)
        await _emit_queue_updated(request, db)

        return result
    finally:
        await db.close()


@router.post("/start-session")
async def start_session_for_user(body: StartSessionRequest, request: Request):
    """Start a mirror session for the active queue user.

    Emits start_session socket event to trigger the orchestrator.
    """
    sio = request.app.state.sio
    await sio.emit("start_session", {"user_id": body.user_id}, room="mirror")
    # Also emit to the user's room so their phone knows
    await sio.emit("session_starting", {"user_id": body.user_id}, room=body.user_id)
    return {"status": "started"}


async def _try_advance_next(db) -> dict:
    """Promote the next waiting user to active. Returns status + active user info."""
    next_rows = await db.execute(
        """
        UPDATE queue SET status = 'active'
        WHERE id = (
            SELECT id FROM queue
            WHERE status = 'waiting'
            ORDER BY position ASC
            LIMIT 1
        )
        RETURNING user_id
        """,
    )
    if next_rows:
        uid = str(next_rows[0]["user_id"])
        name_rows = await db.execute(
            "SELECT name FROM users WHERE id = $1::uuid", [uid]
        )
        name = name_rows[0]["name"] if name_rows else "Unknown"
        return {"status": "advanced", "active_user": {"id": uid, "name": name}}
    return {"status": "empty"}
