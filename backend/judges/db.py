"""Database operations for the judges/organizers directory."""

import json
from datetime import datetime, timezone


async def seed_judges(db, judges_list: list[dict]) -> int:
    """Bulk insert judges/organizers with ON CONFLICT DO NOTHING (idempotent).

    Each entry in judges_list should have 'name' and 'role'.
    Returns the number of rows inserted.
    """
    inserted = 0
    for j in judges_list:
        rows = await db.execute(
            "INSERT INTO judges (name, role) "
            "VALUES ($1, $2) "
            "ON CONFLICT (lower(name), role) DO NOTHING "
            "RETURNING id",
            [j["name"], j.get("role", "judge")],
        )
        if rows:
            inserted += 1
    return inserted


async def get_pending_judges(db) -> list[dict]:
    """Fetch judges with scrape_status = 'pending'."""
    rows = await db.execute(
        "SELECT id, name, role FROM judges "
        "WHERE scrape_status = 'pending' "
        "ORDER BY created_at"
    )
    return rows or []


async def update_judge_data(db, judge_id: str, data: dict) -> None:
    """Update a judge with scraped data and set status to 'scraped'."""
    await db.execute(
        "UPDATE judges SET "
        "title = $1, organization = $2, bio = $3, photo_url = $4, "
        "linkedin_url = $5, twitter_url = $6, website_url = $7, "
        "source_urls = $8::jsonb, scrape_status = 'scraped', "
        "scraped_at = now(), updated_at = now() "
        "WHERE id = $9",
        [
            data.get("title"),
            data.get("organization"),
            data.get("bio"),
            data.get("photo_url"),
            data.get("linkedin_url"),
            data.get("twitter_url"),
            data.get("website_url"),
            json.dumps(data.get("source_urls", [])),
            judge_id,
        ],
    )


async def mark_judge_failed(db, judge_id: str, error: str) -> None:
    """Set scrape_status to 'failed' with an error message."""
    await db.execute(
        "UPDATE judges SET scrape_status = 'failed', "
        "scrape_error = $1, updated_at = now() "
        "WHERE id = $2",
        [error, judge_id],
    )


async def get_all_judges(db, role: str | None = None) -> list[dict]:
    """List all judges, optionally filtered by role."""
    if role:
        rows = await db.execute(
            "SELECT * FROM judges WHERE role = $1 ORDER BY name",
            [role],
        )
    else:
        rows = await db.execute(
            "SELECT * FROM judges ORDER BY name"
        )
    return rows or []


async def get_judge_by_id(db, judge_id: str) -> dict | None:
    """Fetch a single judge by UUID."""
    rows = await db.execute(
        "SELECT * FROM judges WHERE id = $1",
        [judge_id],
    )
    return rows[0] if rows else None


async def manual_update_judge(db, judge_id: str, updates: dict) -> None:
    """Apply manual corrections to a judge record.

    Sets scrape_status to 'manual' to indicate human-edited data.
    Only updates fields that are present in the updates dict.
    """
    allowed_fields = [
        "name", "role", "title", "organization", "bio",
        "photo_url", "linkedin_url", "twitter_url", "website_url",
    ]
    set_clauses = []
    params = []
    idx = 1
    for field in allowed_fields:
        if field in updates:
            set_clauses.append(f"{field} = ${idx}")
            params.append(updates[field])
            idx += 1
    if not set_clauses:
        return
    set_clauses.append(f"scrape_status = 'manual'")
    set_clauses.append(f"updated_at = now()")
    params.append(judge_id)
    query = f"UPDATE judges SET {', '.join(set_clauses)} WHERE id = ${idx}"
    await db.execute(query, params)
