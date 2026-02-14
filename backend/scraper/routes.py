"""FastAPI routes for the scraping pipeline."""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from models.database import get_neon_client
from scraper.gmail_auth import exchange_auth_code
from scraper.pipeline import fast_scrape
from scraper.profile_builder import build_style_profile
from scraper.brand_scanner import scan_brand_frequency
from scraper.db import (
    store_purchases, store_style_profile, get_user_token, store_user_token,
    get_last_scraped_at, set_last_scraped_at, get_all_purchases,
)
from scraper.socket_events import emit_purchase_found, emit_scrape_progress, emit_scrape_complete

router = APIRouter(prefix="/api/scrape", tags=["scraping"])


class AuthRequest(BaseModel):
    user_id: str
    auth_code: str
    redirect_uri: str


class ScrapeRequest(BaseModel):
    user_id: str


@router.post("/auth")
async def exchange_token(req: AuthRequest):
    """Exchange Google OAuth auth code for tokens and store them."""
    try:
        token_data = exchange_auth_code(req.auth_code, req.redirect_uri)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth exchange failed: {e}")

    db = await get_neon_client()
    try:
        await store_user_token(db, req.user_id, token_data)
    finally:
        await db.close()

    return {"status": "ok"}


@router.post("/start")
async def start_scrape(req: ScrapeRequest, request: Request):
    """Kick off streaming scrape in background. Results arrive via Socket.io."""
    db = await get_neon_client()
    try:
        token_data = await get_user_token(db, req.user_id)
        if not token_data:
            raise HTTPException(status_code=400, detail="No OAuth token for user. Complete /auth first.")
    finally:
        await db.close()

    sio = request.app.state.sio
    asyncio.create_task(_background_scrape(req.user_id, token_data, sio))

    return {"status": "started"}


async def _background_scrape(user_id: str, token_data: dict, sio):
    """Run scrape in background, streaming results via Socket.io.

    Incremental: if the user has been scraped before, only fetches emails
    newer than last_scraped_at. Profile is always rebuilt from ALL purchases.
    """
    db = await get_neon_client()
    try:
        await emit_scrape_progress(sio, user_id, 0, [], "searching")

        # Check for previous scrape timestamp
        last_scraped = await get_last_scraped_at(db, user_id)

        total_count = [0]  # mutable counter for closure

        async def on_email(email, purchases):
            total_count[0] += len(purchases)
            # Store each batch immediately
            await store_purchases(db, user_id, purchases)
            # Stream to frontend
            await emit_purchase_found(
                sio, user_id,
                email_subject=email.get("subject", ""),
                purchases=purchases,
                total_so_far=total_count[0],
            )

        result = await fast_scrape(token_data, on_email=on_email, since=last_scraped)

        # Mark scrape timestamp before profile rebuild
        await set_last_scraped_at(db, user_id)

        # Rebuild profile from ALL purchases (old + new) for full accuracy
        all_purchases = await get_all_purchases(db, user_id)
        profile = build_style_profile(all_purchases, result.brand_freq)

        # Store final profile
        await store_style_profile(db, user_id, profile)

        # Emit completion with profile
        await emit_scrape_complete(sio, user_id, profile)

    except Exception as e:
        print(f"[scrape] Error for user {user_id}: {e}")
        await emit_scrape_progress(sio, user_id, 0, [], "error")
    finally:
        await db.close()
