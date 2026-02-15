# Poke MCP Server — Spec

## Goal

Add a minimal MCP server to the `main` branch that lets **Poke** (external AI agent) access mirror session history. Poke identifies users by phone number and needs to read past shopping sessions (liked items with full product details) and write session summaries.

This is NOT a merge of the `poke` branch. It's a focused addition of only the MCP server with session tools, written fresh or adapted from `origin/poke`.

## Architecture

```
Poke (external AI) ──MCP protocol──▶ MCP Server (FastMCP) ──SQL──▶ Neon Postgres
```

- **No HTTP roundtrip** through FastAPI. The MCP server connects directly to Neon Postgres.
- **No changes** to `backend/main.py`, existing routers, or the Mira orchestrator.
- The mirror/backend creates sessions and session_outfits during live sessions. Poke reads them afterward via MCP.

## MCP Tools

### 1. `get_past_sessions(phone: str)` — Read

Looks up a user by phone number, returns their past mirror sessions with liked items and summaries.

**Input:**
- `phone` (str) — User's phone number (matches `users.phone`)

**Output:** List of sessions, each containing:
- `session_id` (uuid)
- `started_at` (datetime)
- `ended_at` (datetime, nullable)
- `status` ("active" | "completed" | "abandoned")
- `liked_items` — array of:
  - `id` (uuid) — clothing_items.id
  - `name` (str)
  - `brand` (str, nullable)
  - `price` (number, nullable)
  - `image_url` (str, nullable)
  - `buy_url` (str, nullable)
  - `category` (str, nullable)
- `summary` (str, nullable) — from session_outfits where reaction='summary', outfit_data content

**SQL flow:**
1. `SELECT id FROM users WHERE phone = $1`
2. `SELECT * FROM sessions WHERE user_id = $1 ORDER BY started_at DESC`
3. For each session: `SELECT * FROM session_outfits WHERE session_id = $1 AND reaction IN ('liked', 'summary')`
4. For liked outfits: resolve `clothing_items` UUIDs from the `clothing_items` array column → `SELECT * FROM clothing_items WHERE id = ANY($1)`

### 2. `save_session(phone: str, session_id: str, summary: str)` — Write

Poke adds a summary to an existing session. The session and outfits are already created by the mirror backend during the live session. Poke just writes metadata.

**Input:**
- `phone` (str) — User's phone number (for auth/validation)
- `session_id` (uuid str) — Existing session ID
- `summary` (str) — Poke's summary of the session

**Behavior:**
1. Verify user exists by phone and owns the session
2. Insert a `session_outfits` row with `reaction='summary'` and `outfit_data = {"summary": summary}`
3. If session status is 'active', optionally mark it 'completed' and set `ended_at`

**Output:** Confirmation with session_id.

## Database Access

- Direct connection to Neon Postgres using `DATABASE_URL` env var
- Use `asyncpg` for the connection (the MCP server runs as its own process, not inside FastAPI)
- No need for the dual-mode pattern since the MCP server will be deployed on Render (port 5432 accessible)

## File Structure

```
backend/
  mcp_server/
    __init__.py
    server.py          # FastMCP server with 2 tools + DB connection
    tests/
      __init__.py
      test_sessions.py # Adapted tests for get_past_sessions + save_session
  requirements.txt     # Add fastmcp dependency
```

## Dependencies

Add to `backend/requirements.txt`:
- `fastmcp` — FastMCP framework for MCP server

## What Does NOT Change

- `backend/main.py` — untouched
- `backend/agent/` — untouched (Mira orchestrator stays)
- `backend/routers/` — no new routers, no deletions
- Database schema — no new migrations (existing schema supports everything)
- Frontend — no changes
- No deployment config changes

## CLAUDE.md

Add a new section to the existing CLAUDE.md describing the Poke MCP server:
- What it is (MCP server for Poke to access session history)
- The 2 tools and their purpose
- How to run it locally
- That it connects directly to DB (not through FastAPI)

Keep all existing Mira documentation intact.

## Tests

Adapt relevant tests from `origin/poke:backend/mcp_server/tests/` for:
- `get_past_sessions` — user lookup by phone, session retrieval, liked items with full product details, summary inclusion, user-not-found handling
- `save_session` — summary insertion, session ownership validation, error cases

Tests should mock the database connection (don't require live Neon DB).

## Running the MCP Server

```bash
cd backend
python -m mcp_server.server
# or
fastmcp run mcp_server/server.py
```

Poke connects to the MCP server via stdio or SSE transport (whichever FastMCP supports and Poke expects).
