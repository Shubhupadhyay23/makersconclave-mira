"""Poke MCP server for Mirrorless session data.

Exposes two tools for the Poke AI agent:
  - get_past_sessions: Retrieve a user's past mirror sessions with liked items
  - save_session: Save a summary for a completed session

Connects directly to Neon Postgres via asyncpg (not through FastAPI).
"""

from __future__ import annotations

import json
import logging
import os
import uuid

import asyncpg
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("mcp")
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)

DATABASE_URL = os.getenv("DATABASE_URL", "")

# ---------------------------------------------------------------------------
# Connection pool (lazy singleton)
# ---------------------------------------------------------------------------

_pool: asyncpg.Pool | None = None


async def _get_pool() -> asyncpg.Pool:
    """Return (or create) the asyncpg connection pool."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=5,
            ssl="require",
        )
    return _pool


# ---------------------------------------------------------------------------
# Core logic (testable with mock pool)
# ---------------------------------------------------------------------------


async def _get_past_sessions(pool, phone: str, limit: int = 10) -> dict:
    """Look up a user by phone and return their past sessions with outfits."""
    async with pool.acquire() as conn:
        # Find user by phone
        user = await conn.fetchrow(
            "SELECT id, phone FROM users WHERE phone = $1", phone
        )
        if user is None:
            return {"ok": False, "error": f"User with phone {phone} not found"}

        user_id = user["id"]

        # Fetch sessions ordered by most recent
        sessions = await conn.fetch(
            "SELECT id, started_at, ended_at, status "
            "FROM sessions WHERE user_id = $1 "
            "ORDER BY started_at DESC LIMIT $2",
            user_id,
            limit,
        )

        if not sessions:
            return {"ok": True, "sessions": []}

        result_sessions = []
        for session in sessions:
            session_id = session["id"]

            # Fetch outfits for this session (liked + summary only)
            outfits = await conn.fetch(
                "SELECT id, reaction, outfit_data, clothing_items "
                "FROM session_outfits WHERE session_id = $1 "
                "AND reaction IN ('liked', 'summary')",
                session_id,
            )

            liked_items = []
            summary = None

            for o in outfits:
                if o["reaction"] == "liked":
                    # Resolve clothing_items UUIDs to full product details
                    item_ids = o["clothing_items"] or []
                    if item_ids:
                        rows = await conn.fetch(
                            "SELECT id, name, brand, price, image_url, buy_url, category "
                            "FROM clothing_items WHERE id = ANY($1::uuid[])",
                            item_ids,
                        )
                        for r in rows:
                            liked_items.append(
                                {
                                    "id": str(r["id"]),
                                    "name": r["name"],
                                    "brand": r["brand"],
                                    "price": float(r["price"]) if r["price"] is not None else None,
                                    "image_url": r["image_url"],
                                    "buy_url": r["buy_url"],
                                    "category": r["category"],
                                }
                            )

                elif o["reaction"] == "summary":
                    data = (
                        o["outfit_data"]
                        if isinstance(o["outfit_data"], dict)
                        else json.loads(o["outfit_data"])
                    )
                    summary = data.get("summary")

            result_sessions.append(
                {
                    "session_id": str(session_id),
                    "started_at": str(session["started_at"]),
                    "ended_at": str(session["ended_at"]) if session["ended_at"] else None,
                    "status": session["status"],
                    "liked_items": liked_items,
                    "summary": summary,
                }
            )

        return {"ok": True, "sessions": result_sessions}


async def _save_session(pool, phone: str, session_id: str, summary: str) -> dict:
    """Save a summary for a session, verifying ownership."""
    async with pool.acquire() as conn:
        # Find user by phone
        user = await conn.fetchrow(
            "SELECT id, phone FROM users WHERE phone = $1", phone
        )
        if user is None:
            return {"ok": False, "error": f"User with phone {phone} not found"}

        user_id = user["id"]

        # Parse and verify session exists
        try:
            sid = uuid.UUID(session_id)
        except ValueError:
            return {"ok": False, "error": f"Invalid session_id: {session_id}"}

        session = await conn.fetchrow(
            "SELECT id, user_id FROM sessions WHERE id = $1", sid
        )
        if session is None:
            return {"ok": False, "error": f"Session {session_id} not found"}

        if session["user_id"] != user_id:
            return {
                "ok": False,
                "error": f"Session {session_id} does not belong to this user",
            }

        # Insert summary outfit
        outfit_data = json.dumps({"summary": summary})
        await conn.execute(
            "INSERT INTO session_outfits (session_id, outfit_data, reaction) "
            "VALUES ($1, $2::jsonb, 'summary')",
            sid,
            outfit_data,
        )

        return {"ok": True, "session_id": session_id}


# ---------------------------------------------------------------------------
# MCP server setup (deferred import to avoid local mcp/ package conflict)
# ---------------------------------------------------------------------------


def _create_mcp_server():
    """Create and configure the FastMCP server with tool registrations.

    The fastmcp import is deferred here because the backend has a local
    ``mcp/`` package that shadows the PyPI ``mcp`` package at import time.
    This function should only be called at runtime (not during tests).
    """
    from fastmcp import FastMCP

    server = FastMCP(
        "Mirrorless Poke",
        instructions=(
            "MCP server for the Mirrorless smart mirror. "
            "Use get_past_sessions to look up a user's past sessions by phone number. "
            "Use save_session to save a summary for a completed session."
        ),
    )

    @server.tool()
    async def get_past_sessions(phone: str, limit: int = 10) -> dict:
        """Retrieve a user's past mirror sessions by phone number.

        Returns sessions with liked outfits (including full product details)
        and session summaries, ordered by most recent first.

        Args:
            phone: The user's phone number (e.g. "+15551234567")
            limit: Maximum number of sessions to return (default 10)
        """
        log.info("get_past_sessions | phone=%s limit=%d", phone, limit)
        pool = await _get_pool()
        result = await _get_past_sessions(pool, phone, limit)
        count = len(result.get("sessions", []))
        log.info("get_past_sessions returned %d sessions", count)
        return result

    @server.tool()
    async def save_session(phone: str, session_id: str, summary: str) -> dict:
        """Save a summary for a completed mirror session.

        Verifies the session belongs to the user identified by phone number,
        then stores the summary text.

        Args:
            phone: The user's phone number (e.g. "+15551234567")
            session_id: UUID of the session to save the summary for
            summary: The session summary text
        """
        log.info("save_session | phone=%s session=%s", phone, session_id)
        pool = await _get_pool()
        result = await _save_session(pool, phone, session_id, summary)
        log.info("save_session result: %s", result)
        return result

    return server


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp = _create_mcp_server()
    mcp.run()
