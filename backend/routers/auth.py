"""Auth endpoints: Google OAuth exchange and profile update."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.database import NeonHTTPClient
from services.auth import exchange_google_code, upsert_user

router = APIRouter(prefix="/auth", tags=["auth"])


class GoogleAuthRequest(BaseModel):
    code: str
    redirect_uri: str = "postmessage"


class ProfileUpdateRequest(BaseModel):
    user_id: str
    name: str
    phone: str


@router.post("/google")
async def google_login(body: GoogleAuthRequest):
    """Exchange a Google auth code for tokens, upsert user, return profile."""
    db = NeonHTTPClient()
    try:
        token_data = await exchange_google_code(body.code, body.redirect_uri)
        user = await upsert_user(db, token_data)
        return user
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        await db.close()


@router.post("/profile")
async def update_profile(body: ProfileUpdateRequest):
    """Update user name and phone number."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            UPDATE users SET name = $1, phone = $2
            WHERE id = $3::uuid
            RETURNING id, name, email, phone, poke_id
            """,
            [body.name, body.phone, body.user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="User not found")
        return rows[0]
    finally:
        await db.close()
