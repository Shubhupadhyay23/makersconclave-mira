# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mirrorless is an AI-powered smart mirror (hackathon project). Users onboard via phone (Google OAuth), their purchase history is scraped from Gmail, and AI stylist "Mira" gives personalized outfit recommendations overlaid on their body in real-time via a two-way mirror display. Full spec in `SPEC.md`.

## Build & Run Commands

### Frontend (Next.js 15 + React 19 + TypeScript)
```bash
cd frontend
npm install
npm run dev          # Dev server on :3000
npm run build        # Production build (also type-checks)
npm run lint         # ESLint
npm run test         # Vitest (single run)
npm run test:watch   # Vitest (watch mode)
```

### Backend (Python 3.11+ / FastAPI)
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload        # Dev server on :8000
pytest                           # All tests
pytest tests/test_auth.py -v     # Single test file
pytest tests/test_auth.py::test_upsert_creates_new_user  # Single test
```

### Deploy
```bash
vercel --prod          # Frontend to Vercel
# Backend deploys via Render dashboard
```

## Architecture

- **Frontend (Next.js on Vercel)**: Two apps in one — mirror display (full-screen Chrome on TV) and phone UI (onboarding + dashboard)
- **Backend (FastAPI on Render)**: Agent orchestrator, Gmail scraping, Serper shopping API, MCP server
- **Database**: Neon Postgres (7 tables, cascade deletes on user). Schema in `backend/migrations/001_initial_schema.sql`
- **Real-time**: Socket.io connecting mirror display, phone, and backend

### Data flow
```
Phone → POST /auth/google → Backend exchanges code with Google → upserts user in Neon
Phone → POST /queue/join → Backend assigns position → Phone polls GET /queue/status every 5s
Mirror → MediaPipe (pose+gestures) → Socket.io → Backend → Claude API → Socket.io → Mirror overlay
```

### Database access pattern
Backend uses `NeonHTTPClient` (in `models/database.py`) — a thin wrapper around Neon's serverless HTTP API on port 443. Each endpoint creates a client, uses it, closes it. Production alternative: asyncpg pool (port 5432 + SSL). All queries use `$1, $2` parameterized placeholders.

## Key Technical Decisions

- **AI Agent**: Custom event-driven orchestrator in `backend/agent/orchestrator.py` calling Claude API directly (NOT Claude Agents SDK). Events (voice, gestures, pose) are batched and sent to Claude Haiku 4.5.
- **Google OAuth**: Authorization code flow via `google.accounts.oauth2.initCodeClient` with `"postmessage"` redirect URI. Scopes include `gmail.readonly` and `calendar.readonly` for scraping.
- **No JWT/sessions**: `user_id` (UUID) is the session identifier, stored in React state.
- **Gesture detection**: MediaPipe Hands in browser → `gesture-classifier.ts` (swipe detection via 5-point wrist tracking window, 800ms cooldown, 0.6 confidence threshold)
- **Clothing data**: Serper.dev Shopping API (`POST https://google.serper.dev/shopping`)
- **Voice pipeline**: Deepgram streaming STT (input) → HeyGen LiveAvatar API (output)
- **Frontend styling**: Inline styles (no CSS framework)

## API Endpoints (Backend)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/google` | Exchange Google OAuth code → upsert user |
| POST | `/auth/profile` | Update user name + phone |
| POST | `/queue/join` | Idempotent queue join, returns position |
| GET | `/queue/status/{user_id}` | Poll queue position + total_ahead |
| GET | `/users/{user_id}` | Fetch user profile |
| GET | `/health` | Health check |

## Environment Variables

### Frontend `.env.local`
- `NEXT_PUBLIC_API_URL` — Backend REST URL (e.g. `http://localhost:8000`)
- `NEXT_PUBLIC_SOCKET_URL` — Backend WebSocket URL
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID` — Google OAuth client ID

### Backend `.env`
- `DATABASE_URL` — Neon Postgres connection string
- `ANTHROPIC_API_KEY` — Claude API key
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth
- `SERPER_API_KEY` — Serper.dev shopping API key
- `DEEPGRAM_API_KEY` — Deepgram STT key
- `HEYGEN_API_KEY` — HeyGen avatar API key

## Conventions

- Frontend: TypeScript strict mode, path alias `@/*` → `./src/*`
- Backend: Python 3.11+, Pydantic models in `models/schemas.py`
- Socket.io events: snake_case (`gesture_detected`, `outfit_changed`, `session_started`)
- All Claude API calls go through `backend/agent/orchestrator.py` — never from frontend
- Mira's personality prompt lives in `backend/agent/prompts.py`
- Database migrations: raw SQL in `backend/migrations/`
- Tests run against live Neon (no mocks) — test fixtures create and delete their own data
- Frontend tests use Vitest + jsdom + @testing-library/react
