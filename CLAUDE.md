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
- **Voice**: Deepgram streaming STT (input) → ElevenLabs streaming TTS via backend proxy `/api/tts/stream` (output)
- **Avatar**: ElevenLabs UI Orb (Three.js WebGL sphere) with context-aware positioning and emotion-based color gradients. 4 states: idle, listening, thinking, speaking.
- **Body tracking**: MediaPipe BlazePose (pose) + MediaPipe Hands (gestures) in browser
- **Clothing overlay**: 2D affine transforms based on pose landmarks. Fallback: side-by-side display
- **Clothing data**: Serper.dev Google Shopping API (not SerpAPI)
- **Scraping strategy**: Fast parallel pass (~15s) for immediate agent context, background deep scrape async
- **Database connection**: Dual-mode setup - asyncpg pool (production on Render) or Neon serverless HTTP (local dev when port 5432 blocked)

## Voice & TTS Pipeline

Mira's voice flows through a streaming pipeline from Claude's output to audio playback with Orb visualization:

1. **Claude streaming** (`backend/agent/orchestrator.py`): `_call_claude()` streams via Anthropic async API. Each `content_block_delta` is emitted as a `mira_speech` Socket.io event with `{text, is_chunk: true}`. An empty event with `is_chunk: false` signals end-of-message.

2. **Frontend accumulation** (`frontend/src/app/mirror/page.tsx`): Chunks accumulate in `responseAccumulatorRef` until end-of-message, then the full text is processed.

3. **Emotion parsing** (`frontend/src/lib/emotion-parser.ts`): Claude prefixes each response with `[emotion:X]` (neutral/proud/teasing). Parsed on frontend, tag stripped before TTS. Controls Orb color gradient.

4. **Streaming TTS** (`frontend/src/lib/streaming-tts.ts`): POSTs full text to backend `/api/tts/stream`. Uses `MediaSource` + `SourceBuffer` for low-latency chunked playback. `AudioContext` + `AnalyserNode` extracts real-time volume (0-1) for Orb visualization.

5. **Backend TTS proxy** (`backend/routers/tts.py`): Streams audio from ElevenLabs `/stream` endpoint with `eleven_multilingual_v2` model, voice ID `EXAVITQu4vr4xnSDxMaL` (Sarah). Returns chunked `audio/mpeg`.

6. **Orb avatar** (`frontend/src/hooks/useOrbAvatar.ts`): State machine (idle → listening → thinking → speaking → idle). Drives the ElevenLabs UI Orb component via `outputVolumeRef` and `colorsRef` (no React re-renders for 60fps updates).

**STT input** (`frontend/src/hooks/useDeepgramSTT.ts`): WebSocket connection to Deepgram, `nova-2` model, mic audio converted to Int16 PCM, `utterance_end_ms=1500`. Transcripts are queued while orb is speaking, sent when idle.

**Orb states**: `idle` (pale white, corner), `listening` (mic active), `thinking` (pulsing, centered), `speaking` (volume-reactive deformation, emotion-colored). 4 emotion palettes: idle (#F0F0F5), neutral (#F5E6A0), proud (#4A6FA5), teasing (#FFF3B0).

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
    lib/            # Shared utilities
      streaming-tts.ts     # Streaming TTS with MediaSource + volume extraction
      emotion-parser.ts    # Parse [emotion:X] tags from Claude responses
      socket.ts            # Socket.io client
    hooks/
      useOrbAvatar.ts      # Orb state machine + streaming TTS integration
      useDeepgramSTT.ts    # Deepgram STT WebSocket hook
      useCamera.ts         # Camera access hook
      useGestureRecognizer.ts # MediaPipe hand gesture hook
    components/
      ui/
        orb.tsx            # ElevenLabs Orb (Three.js WebGL, via shadcn registry)
    components/mirror/
      ProductCarousel.tsx  # Product recommendation display
      VoiceIndicator.tsx   # Interim transcript indicator
      ClothingCanvas.tsx   # Clothing overlay rendering
      PriceStrip.tsx       # Minimal price strip on mirror page
    __tests__/             # Vitest test suites
  public/                  # Static assets
backend/            # Python FastAPI
  main.py           # FastAPI app entry + Socket.io server
  agent/            # Mira orchestrator, Claude API integration
    orchestrator.py # Event-driven agent orchestrator
    prompts.py      # Mira's personality prompt
    tools.py        # Agent tool definitions
  routers/
    tts.py          # ElevenLabs TTS proxy endpoint
    auth.py         # Authentication routes
    queue.py        # Queue management routes
    users.py        # User routes
  scraper/          # Gmail scraping, data extraction
  mcp_server/       # MCP server for Poke integration (not mcp/ — avoids PyPI conflict)
  models/           # Pydantic models, DB schemas
    database.py     # Dual-mode DB connection (asyncpg + Neon HTTP)
    schemas.py      # Pydantic request/response models
  services/         # Serper.dev, Deepgram integrations
    serper_search.py  # Serper.dev Shopping API (CLI + library)
  migrations/       # Raw SQL migration files
    001_initial_schema.sql
  tests/            # Pytest test suite
jenny/              # Standalone Mira prototype (vanilla JS, archived reference)
  src/              # 9 JS modules (avatar, TTS, scripted responses, Gemini vision)
  assets/           # Memoji PNGs, loop videos, scripted videos
  bundle.py         # Self-contained HTML bundler
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
- `ELEVENLABS_API_KEY` — ElevenLabs TTS API key (required for voice output)
- `ELEVENLABS_VOICE_ID` — ElevenLabs voice ID (default: Sarah)

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
- FastAPI backend with Socket.io real-time communication
- Next.js frontend with mirror/phone page structure
- MediaPipe integration for body/hand tracking
- Mira agent orchestrator (event-driven Claude API calls via `agent/orchestrator.py`)
- ElevenLabs UI Orb avatar with streaming TTS and emotion-based color gradients
- ElevenLabs streaming TTS backend proxy (`backend/routers/tts.py`) with chunked audio
- Deepgram streaming STT (`useDeepgramSTT` hook)
- Emotion tag parsing (`[emotion:X]` prefix from Claude responses)
- Mirror UI components: Orb, ProductCarousel, VoiceIndicator
- MCP server for Poke integration (`backend/mcp_server/`)

**In Progress / Planned**:
- Gmail OAuth and scraping pipeline
- Clothing overlay rendering
- Microphone volume input to Orb (manualInput from Deepgram audio)

## Conventions

- Frontend uses TypeScript, backend uses Python 3.11+
- Socket.io events use snake_case: `outfit_changed`, `gesture_detected`, `session_started`
- All Claude API calls go through `backend/agent/orchestrator.py` — never call Claude directly from frontend
- Mira's personality prompt lives in `backend/agent/prompts.py`
- Database migrations via raw SQL files in `backend/migrations/`
