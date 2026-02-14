"""User endpoints."""

from fastapi import APIRouter, HTTPException

from models.database import NeonHTTPClient

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/{user_id}")
async def get_user(user_id: str):
    """Get a user by ID."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            "SELECT id, name, email, phone, poke_id, created_at FROM users WHERE id = $1::uuid",
            [user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="User not found")
        return rows[0]
    finally:
        await db.close()
