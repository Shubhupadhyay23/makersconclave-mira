"""LiveAvatar session token endpoint.

Calls the LiveAvatar API (api.liveavatar.com) to create a short-lived
session token that the frontend SDK uses to connect via LiveKit.
"""

import os
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/heygen", tags=["heygen"])

LIVEAVATAR_API_URL = "https://api.liveavatar.com"

# Sandbox avatar (Wayne) — free dev testing, 1-min sessions
SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"


class TokenRequest(BaseModel):
    is_sandbox: Optional[bool] = False


@router.post("/token")
async def create_liveavatar_token(body: TokenRequest = TokenRequest()):
    """Create a LiveAvatar session token.

    Returns session_token + session_id for the frontend SDK to connect.
    Uses LITE mode (we control speech via repeat(), no HeyGen LLM).
    Sandbox mode uses a fixed avatar (Wayne) for free dev testing.
    """
    api_key = os.environ.get("HEYGEN_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="HEYGEN_API_KEY not configured")

    avatar_id = os.environ.get("LIVEAVATAR_AVATAR_ID")
    if not avatar_id and not body.is_sandbox:
        raise HTTPException(
            status_code=500,
            detail="LIVEAVATAR_AVATAR_ID not configured (use sandbox mode for testing)",
        )

    if body.is_sandbox:
        avatar_id = SANDBOX_AVATAR_ID

    payload: dict = {
        "mode": "LITE",
        "avatar_id": avatar_id,
        "is_sandbox": bool(body.is_sandbox),
    }

    # Optional voice/context overrides via avatar_persona
    voice_id = os.environ.get("LIVEAVATAR_VOICE_ID")
    context_id = os.environ.get("LIVEAVATAR_CONTEXT_ID")
    if voice_id or context_id:
        persona: dict = {"language": "en"}
        if voice_id:
            persona["voice_id"] = voice_id
        if context_id:
            persona["context_id"] = context_id
        payload["avatar_persona"] = persona

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{LIVEAVATAR_API_URL}/v1/sessions/token",
            headers={"X-API-KEY": api_key},
            json=payload,
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"LiveAvatar API error ({resp.status_code}): {resp.text}",
        )

    result = resp.json()
    data = result.get("data", {})
    if not data or "session_token" not in data:
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected LiveAvatar response: {resp.text}",
        )

    return {
        "session_token": data["session_token"],
        "session_id": data["session_id"],
    }
