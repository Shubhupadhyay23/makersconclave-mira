"""Database operations for the scraping pipeline."""

import json
from datetime import datetime, timezone


async def store_purchases(db, user_id: str, purchases: list[dict]) -> None:
    """Insert parsed purchases into the purchases table.

    Uses ON CONFLICT to skip duplicates (same user + email + item).
    """
    for p in purchases:
        receipt_text = p.get("receipt_text")
        if receipt_text and len(receipt_text) > 500:
            receipt_text = receipt_text[:500]
        await db.execute(
            "INSERT INTO purchases "
            "(user_id, brand, item_name, category, price, date, source_email_id, "
            "merchant, order_status, tracking_number, receipt_text) "
            "VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11) "
            "ON CONFLICT (user_id, COALESCE(source_email_id, ''), item_name) DO NOTHING",
            [
                user_id,
                p["brand"],
                p["item_name"],
                p.get("category"),
                p.get("price"),
                p.get("date"),
                p.get("source_email_id"),
                p.get("merchant"),
                p.get("order_status"),
                p.get("tracking_number"),
                receipt_text,
            ],
        )


async def store_style_profile(db, user_id: str, profile: dict) -> None:
    """Upsert a style profile for the user."""
    await db.execute(
        "INSERT INTO style_profiles (user_id, brands, price_range, style_tags, narrative_summary) "
        "VALUES ($1, $2, $3::jsonb, $4, $5) "
        "ON CONFLICT (user_id) DO UPDATE SET "
        "brands = EXCLUDED.brands, "
        "price_range = EXCLUDED.price_range, "
        "style_tags = EXCLUDED.style_tags, "
        "narrative_summary = EXCLUDED.narrative_summary",
        [
            user_id,
            "{" + ",".join(profile["brands"]) + "}" if profile["brands"] else "{}",
            json.dumps(profile["price_range"]),
            "{" + ",".join(profile["style_tags"]) + "}" if profile["style_tags"] else "{}",
            profile.get("narrative_summary"),
        ],
    )


async def get_user_token(db, user_id: str) -> dict | None:
    """Fetch the Google OAuth token for a user."""
    rows = await db.execute(
        "SELECT google_oauth_token FROM users WHERE id = $1",
        [user_id],
    )
    if rows and rows[0].get("google_oauth_token"):
        token = rows[0]["google_oauth_token"]
        return token if isinstance(token, dict) else json.loads(token)
    return None


async def store_user_token(db, user_id: str, token_data: dict) -> None:
    """Store Google OAuth token for a user."""
    await db.execute(
        "UPDATE users SET google_oauth_token = $1::jsonb WHERE id = $2",
        [json.dumps(token_data), user_id],
    )


async def get_last_scraped_at(db, user_id: str) -> datetime | None:
    """Fetch the last scrape timestamp for a user."""
    rows = await db.execute(
        "SELECT last_scraped_at FROM users WHERE id = $1",
        [user_id],
    )
    if rows and rows[0].get("last_scraped_at"):
        val = rows[0]["last_scraped_at"]
        if isinstance(val, datetime):
            return val
        return datetime.fromisoformat(val)
    return None


async def set_last_scraped_at(db, user_id: str) -> None:
    """Set the last scrape timestamp to now."""
    await db.execute(
        "UPDATE users SET last_scraped_at = now() WHERE id = $1",
        [user_id],
    )


async def get_all_purchases(db, user_id: str) -> list[dict]:
    """Fetch all purchases for a user (for profile rebuilding after incremental scrape)."""
    rows = await db.execute(
        "SELECT brand, item_name, category, price, date, merchant, order_status "
        "FROM purchases WHERE user_id = $1",
        [user_id],
    )
    return rows or []
