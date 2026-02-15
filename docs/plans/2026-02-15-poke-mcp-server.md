# Poke MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a minimal MCP server to main that lets Poke access mirror session history by phone number, with full product details for liked items.

**Architecture:** Self-contained FastMCP server in `backend/mcp_server/` that connects directly to Neon Postgres via asyncpg. Two tools: `get_past_sessions` (read) and `save_session` (write). No changes to existing backend code.

**Tech Stack:** FastMCP, asyncpg, Python 3.11+, pytest + pytest-asyncio

---

### Task 1: Add fastmcp dependency

**Files:**
- Modify: `backend/requirements.txt`

**Step 1: Add fastmcp to requirements.txt**

Add `fastmcp` to the end of `backend/requirements.txt` (before the trailing newline):

```
fastmcp
```

**Step 2: Install dependencies**

Run: `cd backend && pip install fastmcp`

**Step 3: Commit**

```bash
git add backend/requirements.txt
git commit -m "feat: add fastmcp dependency for Poke MCP server"
```

---

### Task 2: Create MCP server with get_past_sessions tool

**Files:**
- Create: `backend/mcp_server/__init__.py`
- Create: `backend/mcp_server/server.py`

**Step 1: Write the failing test**

Create `backend/mcp_server/tests/__init__.py` (empty) and `backend/mcp_server/tests/test_sessions.py`:

```python
"""Tests for the Poke MCP server session tools."""

import json
from unittest.mock import AsyncMock, patch

import pytest

# We'll import after creating the module
from mcp_server.server import mcp


@pytest.fixture
def mock_pool():
    """Mock asyncpg pool for DB queries."""
    pool = AsyncMock()
    conn = AsyncMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


@pytest.mark.asyncio
async def test_get_past_sessions_returns_liked_items_with_product_details(mock_pool):
    """get_past_sessions returns sessions with liked items including full product details."""
    pool, conn = mock_pool

    # Mock user lookup
    conn.fetchrow.return_value = {"id": "user-uuid-1"}

    # Mock sessions query
    conn.fetch.side_effect = [
        # Sessions
        [
            {
                "id": "session-1",
                "started_at": "2026-02-14T10:00:00Z",
                "ended_at": "2026-02-14T10:30:00Z",
                "status": "completed",
            }
        ],
        # Session outfits (liked + summary) for session-1
        [
            {
                "reaction": "liked",
                "outfit_data": json.dumps({}),
                "clothing_items": ["item-uuid-1", "item-uuid-2"],
            },
            {
                "reaction": "summary",
                "outfit_data": json.dumps({"summary": "Great session"}),
                "clothing_items": [],
            },
        ],
        # Clothing items for the liked outfit
        [
            {
                "id": "item-uuid-1",
                "name": "Navy Blazer",
                "brand": "Zara",
                "price": 89.99,
                "image_url": "https://example.com/blazer.jpg",
                "buy_url": "https://example.com/blazer",
                "category": "jackets",
            },
            {
                "id": "item-uuid-2",
                "name": "White Sneakers",
                "brand": "Nike",
                "price": 120.00,
                "image_url": "https://example.com/sneakers.jpg",
                "buy_url": "https://example.com/sneakers",
                "category": "shoes",
            },
        ],
    ]

    from mcp_server.server import _get_past_sessions

    result = await _get_past_sessions(pool, phone="+15551234567")

    assert len(result["sessions"]) == 1
    session = result["sessions"][0]
    assert session["session_id"] == "session-1"
    assert session["status"] == "completed"
    assert session["summary"] == "Great session"
    assert len(session["liked_items"]) == 2
    assert session["liked_items"][0]["name"] == "Navy Blazer"
    assert session["liked_items"][0]["brand"] == "Zara"
    assert session["liked_items"][0]["price"] == 89.99
    assert session["liked_items"][0]["image_url"] == "https://example.com/blazer.jpg"
    assert session["liked_items"][0]["buy_url"] == "https://example.com/blazer"


@pytest.mark.asyncio
async def test_get_past_sessions_user_not_found(mock_pool):
    """Returns error when phone number doesn't match any user."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = None

    from mcp_server.server import _get_past_sessions

    result = await _get_past_sessions(pool, phone="+15559999999")

    assert "error" in result
    assert "No user found" in result["error"]


@pytest.mark.asyncio
async def test_get_past_sessions_no_sessions(mock_pool):
    """Returns empty sessions list when user has no history."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = {"id": "user-uuid-1"}
    conn.fetch.return_value = []

    from mcp_server.server import _get_past_sessions

    result = await _get_past_sessions(pool, phone="+15551234567")

    assert result["sessions"] == []
    assert "error" not in result
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest mcp_server/tests/test_sessions.py -v`
Expected: FAIL — `mcp_server.server` doesn't exist yet

**Step 3: Write the MCP server**

Create `backend/mcp_server/__init__.py` (empty file).

Create `backend/mcp_server/server.py`:

```python
"""Poke MCP server — exposes session history tools.

Poke (external AI agent) uses this to access mirror shopping session data.
Connects directly to Neon Postgres via asyncpg.

Run:
    cd backend && python -m mcp_server.server
"""

import json
import logging
import os

import asyncpg
from dotenv import load_dotenv
from fastmcp import FastMCP

load_dotenv()

log = logging.getLogger("mcp")
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)

DATABASE_URL = os.getenv("DATABASE_URL", "")

mcp = FastMCP(
    "Mirrorless Poke",
    instructions=(
        "You are connected to the Mirrorless smart mirror system. "
        "Use get_past_sessions to retrieve a user's shopping session history by phone number. "
        "Use save_session to add a summary to an existing session."
    ),
)

_pool: asyncpg.Pool | None = None


async def _get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5, ssl="require")
    return _pool


async def _get_past_sessions(pool: asyncpg.Pool, phone: str, limit: int = 10) -> dict:
    """Core logic for get_past_sessions, testable with a mock pool."""
    async with pool.acquire() as conn:
        # Look up user by phone
        user = await conn.fetchrow("SELECT id FROM users WHERE phone = $1", phone)
        if not user:
            return {"error": f"No user found with phone {phone}"}

        user_id = user["id"]

        # Get sessions
        sessions = await conn.fetch(
            """SELECT id, started_at, ended_at, status
               FROM sessions WHERE user_id = $1
               ORDER BY started_at DESC LIMIT $2""",
            user_id,
            limit,
        )

        result_sessions = []
        for s in sessions:
            # Get liked outfits + summaries for this session
            outfits = await conn.fetch(
                """SELECT reaction, outfit_data, clothing_items
                   FROM session_outfits
                   WHERE session_id = $1 AND reaction IN ('liked', 'summary')""",
                s["id"],
            )

            liked_items = []
            summary = None

            for o in outfits:
                if o["reaction"] == "summary":
                    data = json.loads(o["outfit_data"]) if isinstance(o["outfit_data"], str) else o["outfit_data"]
                    summary = data.get("summary")
                elif o["reaction"] == "liked" and o["clothing_items"]:
                    item_ids = o["clothing_items"]
                    items = await conn.fetch(
                        """SELECT id, name, brand, price, image_url, buy_url, category
                           FROM clothing_items WHERE id = ANY($1::uuid[])""",
                        item_ids,
                    )
                    for item in items:
                        liked_items.append({
                            "id": str(item["id"]),
                            "name": item["name"],
                            "brand": item["brand"],
                            "price": float(item["price"]) if item["price"] else None,
                            "image_url": item["image_url"],
                            "buy_url": item["buy_url"],
                            "category": item["category"],
                        })

            result_sessions.append({
                "session_id": str(s["id"]),
                "started_at": str(s["started_at"]),
                "ended_at": str(s["ended_at"]) if s["ended_at"] else None,
                "status": s["status"],
                "liked_items": liked_items,
                "summary": summary,
            })

        return {"sessions": result_sessions}


async def _save_session(pool: asyncpg.Pool, phone: str, session_id: str, summary: str) -> dict:
    """Core logic for save_session, testable with a mock pool."""
    async with pool.acquire() as conn:
        # Verify user owns the session
        user = await conn.fetchrow("SELECT id FROM users WHERE phone = $1", phone)
        if not user:
            return {"error": f"No user found with phone {phone}"}

        session = await conn.fetchrow(
            "SELECT id, status FROM sessions WHERE id = $1 AND user_id = $2",
            session_id,
            user["id"],
        )
        if not session:
            return {"error": f"Session {session_id} not found for this user"}

        # Insert summary as a session_outfit with reaction='summary'
        await conn.execute(
            """INSERT INTO session_outfits (session_id, outfit_data, reaction)
               VALUES ($1, $2, 'summary')""",
            session_id,
            json.dumps({"summary": summary}),
        )

        return {"ok": True, "session_id": str(session_id)}


@mcp.tool
async def get_past_sessions(phone: str, limit: int = 10) -> dict:
    """Retrieve a user's past mirror shopping sessions by phone number.

    Returns sessions with liked items (full product details) and summaries.

    Args:
        phone: User's phone number (e.g. "+15551234567").
        limit: Max sessions to return (default 10).
    """
    log.info("get_past_sessions | phone=%s limit=%d", phone, limit)
    pool = await _get_pool()
    result = await _get_past_sessions(pool, phone, limit)
    count = len(result.get("sessions", []))
    log.info("get_past_sessions returned %d sessions", count)
    return result


@mcp.tool
async def save_session(phone: str, session_id: str, summary: str) -> dict:
    """Save a summary to an existing mirror shopping session.

    The session must already exist (created by the mirror during the live session).
    Poke uses this to add its own recap of what happened.

    Args:
        phone: User's phone number (for ownership verification).
        session_id: UUID of the existing session.
        summary: Poke's summary of the session.
    """
    log.info("save_session | phone=%s session=%s", phone, session_id)
    pool = await _get_pool()
    result = await _save_session(pool, phone, session_id, summary)
    log.info("save_session result: %s", result)
    return result


if __name__ == "__main__":
    mcp.run()
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest mcp_server/tests/test_sessions.py -v`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add backend/mcp_server/
git commit -m "feat: add Poke MCP server with session history tools"
```

---

### Task 3: Add save_session tests

**Files:**
- Modify: `backend/mcp_server/tests/test_sessions.py`

**Step 1: Write the failing tests**

Append to `test_sessions.py`:

```python
@pytest.mark.asyncio
async def test_save_session_inserts_summary(mock_pool):
    """save_session inserts a session_outfit with reaction='summary'."""
    pool, conn = mock_pool
    conn.fetchrow.side_effect = [
        {"id": "user-uuid-1"},  # user lookup
        {"id": "session-1", "status": "completed"},  # session lookup
    ]

    from mcp_server.server import _save_session

    result = await _save_session(pool, phone="+15551234567", session_id="session-1", summary="Loved the blazer look")

    assert result["ok"] is True
    assert result["session_id"] == "session-1"
    conn.execute.assert_called_once()
    call_args = conn.execute.call_args
    assert "summary" in call_args[0][0]  # SQL contains 'summary'


@pytest.mark.asyncio
async def test_save_session_wrong_user(mock_pool):
    """save_session rejects if session doesn't belong to user."""
    pool, conn = mock_pool
    conn.fetchrow.side_effect = [
        {"id": "user-uuid-1"},  # user lookup
        None,  # session not found for this user
    ]

    from mcp_server.server import _save_session

    result = await _save_session(pool, phone="+15551234567", session_id="session-999", summary="test")

    assert "error" in result
    assert "not found" in result["error"]


@pytest.mark.asyncio
async def test_save_session_user_not_found(mock_pool):
    """save_session rejects if phone doesn't match a user."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = None

    from mcp_server.server import _save_session

    result = await _save_session(pool, phone="+15559999999", session_id="session-1", summary="test")

    assert "error" in result
    assert "No user found" in result["error"]
```

**Step 2: Run tests**

Run: `cd backend && python -m pytest mcp_server/tests/test_sessions.py -v`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add backend/mcp_server/tests/test_sessions.py
git commit -m "test: add save_session tests for Poke MCP server"
```

---

### Task 4: Add MCP protocol integration test

**Files:**
- Create: `backend/mcp_server/tests/test_integration.py`

**Step 1: Write integration test**

```python
"""Integration test — verify MCP protocol tool discovery."""

import pytest
from fastmcp import Client

from mcp_server.server import mcp


@pytest.mark.asyncio
async def test_mcp_server_lists_both_tools():
    """MCP client discovers exactly the 2 session tools."""
    async with Client(mcp) as client:
        tools = await client.list_tools()
        tool_names = {t.name for t in tools}
        assert tool_names == {"get_past_sessions", "save_session"}


@pytest.mark.asyncio
async def test_tool_schemas_have_phone_param():
    """Both tools require a phone parameter."""
    async with Client(mcp) as client:
        tools = await client.list_tools()
        for tool in tools:
            schema = tool.inputSchema
            assert "phone" in schema.get("properties", {}), f"{tool.name} missing phone param"
            assert "phone" in schema.get("required", []), f"{tool.name} phone should be required"
```

**Step 2: Run integration tests**

Run: `cd backend && python -m pytest mcp_server/tests/test_integration.py -v`
Expected: All 2 tests PASS

**Step 3: Commit**

```bash
git add backend/mcp_server/tests/test_integration.py
git commit -m "test: add MCP protocol integration tests"
```

---

### Task 5: Update CLAUDE.md with Poke MCP section

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add Poke MCP section**

Add the following section after the "Voice & TTS Pipeline" section and before "Build & Run Commands":

```markdown
## Poke MCP Server

Poke (external AI agent) accesses mirror session data via an MCP server in `backend/mcp_server/`.

**Architecture:** Poke → MCP protocol → FastMCP server → asyncpg → Neon Postgres (direct DB, not through FastAPI).

**Tools:**
- `get_past_sessions(phone, limit)` — Look up user by phone, return past sessions with liked items (full product details: name, brand, price, image_url, buy_url) and session summaries
- `save_session(phone, session_id, summary)` — Add a summary to an existing session (sessions are created by the mirror backend during live sessions)

**Running the MCP server:**
```
cd backend
python -m mcp_server.server    # stdio transport (default for Poke)
```

**Testing:**
```
cd backend
pytest mcp_server/tests/ -v
```
```

**Step 2: Update project structure in CLAUDE.md**

In the Project Structure section, update the `mcp_server/` entry to:

```
  mcp_server/       # Poke MCP server — session history tools (direct DB access)
    server.py       # FastMCP server: get_past_sessions + save_session
    tests/          # Pytest suite for session tools + MCP protocol
```

**Step 3: Update "Completed" status**

Change the line:
```
- MCP server for Poke integration (`backend/mcp_server/`)
```
To:
```
- Poke MCP server — session history tools for external AI agent (`backend/mcp_server/`)
```

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Poke MCP server section to CLAUDE.md"
```

---

### Task 6: Run full test suite and verify

**Step 1: Run MCP server tests**

Run: `cd backend && python -m pytest mcp_server/tests/ -v`
Expected: All 8 tests PASS

**Step 2: Run existing backend tests to confirm no regressions**

Run: `cd backend && python -m pytest tests/ -v`
Expected: Existing tests still pass (we didn't change any existing code)

**Step 3: Verify MCP server starts**

Run: `cd backend && timeout 3 python -c "from mcp_server.server import mcp; print('OK:', [t.name for t in mcp._tool_manager._tools.values()])" 2>/dev/null || true`
Expected: Prints tool names confirming server loads

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add fastmcp dep | `requirements.txt` |
| 2 | MCP server + get_past_sessions + tests | `mcp_server/server.py`, `mcp_server/tests/test_sessions.py` |
| 3 | save_session tests | `mcp_server/tests/test_sessions.py` |
| 4 | MCP protocol integration test | `mcp_server/tests/test_integration.py` |
| 5 | Update CLAUDE.md | `CLAUDE.md` |
| 6 | Verify everything works | — |

**Total new files:** 4 (`__init__.py` x2, `server.py`, 2 test files)
**Modified files:** 2 (`requirements.txt`, `CLAUDE.md`)
**Existing files changed:** 0 backend logic files
