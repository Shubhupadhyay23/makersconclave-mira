# Poke MCP Integration Context

You are working on the **Poke integration** for Mirrorless — an AI-powered smart mirror. Poke (by Interaction Company) is an external AI assistant that replaces the old Mira orchestrator as the AI brain. We expose shopping tools via an MCP server that Poke connects to.

## Architecture

```
User texts Poke (iMessage/SMS/Telegram)
  → Poke calls our MCP tools
    → MCP server (FastMCP, port 8001) calls HTTP endpoints on backend
      → Backend (FastAPI, port 8000) emits Socket.io events
        → Mirror display updates (product cards / text overlay + TTS)
```

The MCP server is **stateless** — it bridges to the mirror via HTTP REST, not Socket.io directly.

## Worktree

All Poke code lives in the **poke worktree**: `/Users/johnathanmo/mirrorless/.worktrees/poke` (branch: `poke`). The main worktree (`AGENT` branch) has the old Mira code untouched.

## Key Files (in poke worktree)

| File | Purpose |
|------|---------|
| `backend/mcp_server/server.py` | FastMCP server with 5 tools + Poke instructions |
| `backend/mcp_server/shopping.py` | Serper API client (search_clothing logic) |
| `backend/mcp_server/mirror.py` | HTTP client for backend bridge (present_items, send_to_mirror, sessions) |
| `backend/mcp_server/requirements.txt` | fastmcp, uvicorn, httpx, python-dotenv |
| `backend/routers/mirror.py` | REST endpoints: HTTP → Socket.io bridge |
| `backend/main.py` | FastAPI app + Socket.io (mirror router added, old agent NOT imported) |
| `frontend/src/app/mirror/page.tsx` | Mirror display (mirror_id room join, mirror_text listener, TTS) |
| `backend/migrations/009_add_mirror_id_to_sessions.sql` | Already run on Neon |

## 5 MCP Tools

| Tool | What it does |
|------|-------------|
| `search_clothing` | Serper Shopping API → returns results to Poke only |
| `present_items` | Push 1-5 product cards to mirror display |
| `send_to_mirror` | Push text to mirror (+ TTS) |
| `get_past_sessions` | Query session history from Neon DB |
| `save_session` | Save session summary + reactions to Neon DB |

## Testing

**All 36 unit/integration tests pass:**
```bash
cd backend && python -m pytest mcp_server/tests/ tests/test_mirror_endpoint.py -v
```

**Local testing (3 terminals):**
```bash
# T1: Backend
cd backend && uvicorn main:socket_app --host 0.0.0.0 --port 8000 --reload

# T2: MCP server
cd backend && uvicorn mcp_server.server:app --host 0.0.0.0 --port 8001

# T3: Poke tunnel
poke login
poke tunnel http://localhost:8001/mcp --name "Mirrorless Shopping" --recipe
```

**Frontend mirror page:**
```
http://localhost:3000/mirror?mirror_id=MIRROR-A1
```

**Quick curl tests (with backend running):**
```bash
# Present items on mirror
curl -X POST http://localhost:8000/api/mirror/present \
  -H "Content-Type: application/json" \
  -d '{"mirror_id":"MIRROR-A1","items":[{"title":"Test Shoe","price":"$99","image_url":"https://via.placeholder.com/300","link":"https://example.com","source":"TestStore"}]}'

# Send text to mirror
curl -X POST http://localhost:8000/api/mirror/text \
  -H "Content-Type: application/json" \
  -d '{"mirror_id":"MIRROR-A1","text":"Looking great! Check out these picks."}'

# Check mirror connection status
curl http://localhost:8000/api/mirror/status/MIRROR-A1
```

## Known Gotchas

- Package naming: `mcp_server/` NOT `mcp/` — the name `mcp` shadows the `mcp` PyPI package
- FastMCP `@mcp.tool` wraps into `FunctionTool` — not directly callable. Test via the extracted modules (`shopping.py`, `mirror.py`)
- FastMCP `Client.call_tool` returns `is_error` (snake_case), NOT `isError`
- Use `mcp.http_app()` not `mcp.streamable_http_app()` (doesn't exist in v2.14.5)
- httpx Response mocking: `MagicMock` for responses (json/raise_for_status are sync), `AsyncMock` for client.post/get
- `sio.manager.get_participants` is a sync generator — use `for` not `async for`

## DB Migration

Migration 009 has already been run on Neon (project: `lingering-fire-16819645`):
- Added `mirror_id text` column to `sessions`
- Made `user_id` nullable (Poke sessions have no local user)
- Partial index on `mirror_id`

## Poke Recipe Setup

Use `poke tunnel` with `--recipe` flag to create a shareable recipe, or create manually at poke.com/kitchen:
- **Name**: Smart Mirror Stylist
- **Integration URL**: Your MCP server URL (local tunnel or deployed)
- **inputContext**: "Ask the user for their mirror ID — the code displayed on their smart mirror screen"
- **prefilledFirstText**: "Hey! I can help you find outfits and show them on your mirror. What's the code displayed on your mirror screen?"

## Environment Variables

MCP server needs: `SERPER_API_KEY`, `BACKEND_URL` (e.g. `http://localhost:8000`), `DATABASE_URL`
