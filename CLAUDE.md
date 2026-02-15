# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mirrorless is an AI-powered smart mirror. Users onboard via phone (Google OAuth), their purchase history is scraped from Gmail, and AI stylist "Mira" gives personalized outfit recommendations overlaid on their body in real-time via a two-way mirror display.

## Architecture

- **Frontend (Next.js)**: Mirror display (full-screen Chrome on TV), phone UI (onboarding + dashboard), deployed on Vercel
- **Backend (Python FastAPI)**: Agent orchestrator, Gmail scraping, Serper.dev integration, MCP server, deployed on Render
- **Database**: Neon Postgres
- **Real-time**: Socket.io connecting mirror display, phone, and backend

## Key Technical Decisions

- **AI Agent**: Custom event-driven orchestrator calling Claude API directly (NOT Claude Agents SDK). Events (voice, gestures, pose) are batched and sent to Claude.
- **Claude Model**: Haiku 4.5 via Anthropic API with OAuth setup token + beta headers
- **Voice**: Deepgram streaming STT (input) → HeyGen LiveAvatar API (output, planned)
- **Body tracking**: MediaPipe BlazePose (pose) + MediaPipe Hands (gestures) in browser
- **Clothing overlay**: 2D affine transforms based on pose landmarks. Fallback: side-by-side display
- **Clothing data**: Serper.dev Google Shopping API (not SerpAPI)
- **Scraping strategy**: Fast parallel pass (~15s) for immediate agent context, background deep scrape async
- **Database connection**: Dual-mode setup - asyncpg pool (production on Render) or Neon serverless HTTP (local dev when port 5432 blocked)

## Build & Run Commands

### Frontend (Next.js)
```
cd frontend
npm install
npm run dev        # Development server
npm run build      # Production build
npm run lint       # ESLint
```

### Backend (Python FastAPI)
```
cd backend
pip install -r requirements.txt
uvicorn main:app --reload              # Development server
pytest                                 # Run all tests (must run from backend/)
pytest tests/test_database.py         # Single test file
python services/serper_search.py "mens jacket"  # CLI tool for testing Serper API
```

### Deploy
```
vercel --prod                           # Frontend to Vercel
# Backend deploys via Render dashboard or render.yaml
```

## Project Structure

```
frontend/           # Next.js app (mirror display + phone UI)
  src/
    app/
      mirror/       # Full-screen mirror display page
      phone/        # Phone onboarding + dashboard
    lib/            # Shared utilities, Socket.io client
backend/            # Python FastAPI
  main.py           # FastAPI app entry
  agent/            # Mira orchestrator, Claude API integration
    orchestrator.py # Event-driven agent orchestrator
    prompts.py      # Mira's personality prompt
  scraper/          # Gmail scraping, data extraction
  mcp/              # MCP server for Poke integration
  models/           # Pydantic models, DB schemas
    database.py     # Dual-mode DB connection (asyncpg + Neon HTTP)
    schemas.py      # Pydantic request/response models
  services/         # Serper.dev, Deepgram integrations
    serper_search.py  # Serper.dev Shopping API (CLI + library)
  migrations/       # Raw SQL migration files
    001_initial_schema.sql
  tests/            # Pytest test suite
```

## Environment Variables

### Frontend (.env.local)
- `NEXT_PUBLIC_SOCKET_URL` — Backend WebSocket URL
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID` — Google OAuth client ID

### Backend (.env)
- `DATABASE_URL` — Neon Postgres connection string (required)
- `SERPER_API_KEY` — Serper.dev API key (required, see .env.example)
- `ANTHROPIC_API_KEY` — Claude API key (required)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth (planned)
- `DEEPGRAM_API_KEY` — Deepgram STT key (planned)
- `HEYGEN_API_KEY` — HeyGen avatar API key (planned)

## Database Setup

The database uses Neon Postgres with a dual-mode connection strategy:
- **Production (Render)**: asyncpg connection pool via standard PostgreSQL port 5432
- **Local dev**: Neon serverless HTTP API when port 5432 is blocked (firewall/VPN)

### Running Migrations
Migrations are raw SQL files in `backend/migrations/`. Run them manually using:
```bash
psql $DATABASE_URL -f backend/migrations/001_initial_schema.sql
```

Or use the Neon SQL Editor in the dashboard.

## Current Implementation Status

**Completed**:
- Database schema and Neon Postgres integration
- Serper.dev Shopping API integration with CLI tool
- Basic FastAPI backend structure
- Next.js frontend scaffolding with mirror/phone page structure
- MediaPipe integration for body/hand tracking

**In Progress / Planned**:
- Gmail OAuth and scraping pipeline
- Mira agent orchestrator (event-driven Claude API calls)
- Socket.io real-time communication
- Clothing overlay rendering
- HeyGen voice avatar integration
- MCP server for Poke integration

## Conventions

- Frontend uses TypeScript, backend uses Python 3.11+
- Socket.io events use snake_case: `outfit_changed`, `gesture_detected`, `session_started`
- All Claude API calls go through `backend/agent/orchestrator.py` — never call Claude directly from frontend
- Mira's personality prompt lives in `backend/agent/prompts.py`
- Database migrations via raw SQL files in `backend/migrations/`
