"""FastAPI routes for the judges/organizers directory."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.database import get_neon_client
from judges.db import get_all_judges, get_judge_by_id, manual_update_judge

router = APIRouter(prefix="/api/judges", tags=["judges"])


class JudgeUpdateRequest(BaseModel):
    name: str | None = None
    role: str | None = None
    title: str | None = None
    organization: str | None = None
    bio: str | None = None
    photo_url: str | None = None
    linkedin_url: str | None = None
    twitter_url: str | None = None
    website_url: str | None = None


@router.get("/status")
async def scrape_status():
    """Get scrape progress counts."""
    db = await get_neon_client()
    try:
        rows = await db.execute(
            "SELECT scrape_status, COUNT(*) as count FROM judges GROUP BY scrape_status"
        )
        counts = {r["scrape_status"]: int(r["count"]) for r in rows}
        total = sum(counts.values())
        return {
            "total": total,
            "pending": counts.get("pending", 0),
            "scraped": counts.get("scraped", 0),
            "failed": counts.get("failed", 0),
            "manual": counts.get("manual", 0),
        }
    finally:
        await db.close()


@router.get("")
async def list_judges(role: str | None = None):
    """List all judges, optionally filtered by role."""
    db = await get_neon_client()
    try:
        judges = await get_all_judges(db, role=role)
        return {"judges": judges, "count": len(judges)}
    finally:
        await db.close()


@router.get("/{judge_id}")
async def get_judge(judge_id: str):
    """Get a single judge by UUID."""
    db = await get_neon_client()
    try:
        judge = await get_judge_by_id(db, judge_id)
        if not judge:
            raise HTTPException(status_code=404, detail="Judge not found")
        return judge
    finally:
        await db.close()


@router.put("/{judge_id}")
async def update_judge(judge_id: str, req: JudgeUpdateRequest):
    """Manually update/correct a judge record."""
    db = await get_neon_client()
    try:
        existing = await get_judge_by_id(db, judge_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Judge not found")
        updates = req.model_dump(exclude_none=True)
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")
        await manual_update_judge(db, judge_id, updates)
        return {"status": "updated", "judge_id": judge_id}
    finally:
        await db.close()
