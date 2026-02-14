"""Queue endpoints: join queue and check status."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.database import NeonHTTPClient

router = APIRouter(prefix="/queue", tags=["queue"])


class QueueJoinRequest(BaseModel):
    user_id: str


@router.post("/join")
async def join_queue(body: QueueJoinRequest):
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
            return {
                "queue_id": row["id"],
                "position": row["position"],
                "status": row["status"],
                "total_ahead": total_ahead,
            }

        # Calculate next position
        max_pos = await db.fetchval(
            "SELECT COALESCE(MAX(position), 0) FROM queue"
        )
        next_position = int(max_pos) + 1

        rows = await db.execute(
            """
            INSERT INTO queue (user_id, position)
            VALUES ($1::uuid, $2)
            RETURNING id, position, status
            """,
            [body.user_id, next_position],
        )
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
