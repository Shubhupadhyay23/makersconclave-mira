# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mirrorless is an AI-powered smart mirror. Users onboard via phone (Google OAuth), their purchase history is scraped from Gmail, and AI stylist "Mira" gives personalized outfit recommendations overlaid on their body in real-time via a two-way mirror display.

## Architecture

- **Frontend (Next.js)**: Mirror display (full-screen Chrome on TV), phone UI (onboarding + dashboard), admin dashboard, deployed on Vercel
- **Backend (Python FastAPI)**: Agent orchestrator, Gmail scraping, Serper.dev integration, MCP server, deployed on Render
- **Database**: Neon Postgres
- **Real-time**: Socket.io connecting mirror display, phone, and backend

## Key Technical Decisions

- **AI Agent**: Custom event-driven orchestrator calling Claude API directly (NOT Claude Agents SDK). Events (voice, gestures, pose) are batched and sent to Claude.
- **Claude Model**: Haiku 4.5 via Anthropic API with OAuth setup token + beta headers
- **Voice**: Deepgram streaming STT (input) → ElevenLabs streaming TTS via backend proxy `/api/tts/stream` (output)
- **Avatar**: MiraVideoAvatar — pre-recorded MP4 emotion loop videos (26 emotions with idle/talking variants). Fixed position top-right corner. Replaced the ElevenLabs Orb.
- **Body tracking**: MediaPipe BlazePose (pose) + MediaPipe Hands (gestures) in browser
- **Clothing overlay**: 2D affine transforms based on pose landmarks. Fallback: side-by-side display
- **Clothing data**: Serper.dev Google Shopping API (not SerpAPI)
- **Scraping strategy**: Fast parallel pass (~15s) for immediate agent context, background deep scrape async
- **Database connection**: Dual-mode setup - asyncpg pool (production on Render) or Neon serverless HTTP (local dev when port 5432 blocked)
- **Background removal**: rembg service for clothing flat lay images

## Mirror Kiosk Flow

The mirror display runs as a kiosk with three states:

1. **Attract**: QR code + "Mirrorless" branding. Shown when no one is in queue. Users scan QR to open phone UI.
2. **Waiting**: Shows "Up next: [name]" with Start Session and Skip buttons. 2-minute auto-skip timeout. Triggered by `queue_updated` Socket.io event when a user becomes active in queue.
3. **Session**: Active AI stylist session with video avatar, voice, gesture recognition, clothing overlay. Triggered by clicking "Start Session" at the mirror.

On socket connect, the mirror receives the current queue snapshot (so it doesn't miss events if opened late).

## Voice & TTS Pipeline

Mira's voice flows through a streaming pipeline from Claude's output to audio playback with video avatar:

1. **Claude streaming** (`backend/agent/orchestrator.py`): `_call_claude()` streams via Anthropic async API. Each `content_block_delta` is emitted as a `mira_speech` Socket.io event with `{text, is_chunk: true}`. An empty event with `is_chunk: false` signals end-of-message.

2. **Frontend accumulation** (`frontend/src/app/mirror/page.tsx`): Chunks accumulate in `responseAccumulatorRef` until end-of-message, then the full text is processed.

3. **Emotion parsing** (`frontend/src/lib/emotion-parser.ts`): Claude prefixes each response with `[emotion:X]`. Parsed on frontend, tag stripped before TTS. Falls back to `detectEmotionFromText()` keyword matching if no tag present. 13 emotion states supported (happy, sassy, proud, judgy, excited, etc.). Controls video avatar emotion loop.

4. **Streaming TTS** (`frontend/src/lib/streaming-tts.ts`): POSTs full text to backend `/api/tts/stream`. Uses `MediaSource` + `SourceBuffer` for low-latency chunked playback.

5. **Backend TTS proxy** (`backend/routers/tts.py`): Streams audio from ElevenLabs `/stream` endpoint with `eleven_multilingual_v2` model, voice ID `EXAVITQu4vr4xnSDxMaL` (Sarah). Returns chunked `audio/mpeg`.

6. **Video avatar** (`frontend/src/hooks/useMiraVideoAvatar.ts`): State machine (idle → listening → thinking → speaking → idle). Switches between idle and talking loop videos per emotion. Component at `frontend/src/components/ui/mira-video-avatar.tsx`.

**STT input** (`frontend/src/hooks/useDeepgramSTT.ts`): WebSocket connection to Deepgram, `nova-2` model, mic audio converted to Int16 PCM, `utterance_end_ms=1500`. Transcripts are queued while avatar is speaking, sent when idle.

## Phone Onboarding Flow

1. **Sign In**: Google OAuth + selfie capture + name entry
2. **Questionnaire**: Gender, favorite brands, style preferences, occasions, price range
3. **Queue**: Shows position, polls every 5s. Auto-activates if first in line.
4. **Idle**: "You're at the mirror!" with rotating tips while session is active
5. **Recap**: Session summary after session ends

## Queue System

- Backend queue endpoints at `backend/routers/queue.py`: join, status, skip, reorder, advance, start-session
- Auto-activation: first waiting user is promoted to active when no one else is active
- Partial unique index `uq_queue_user_active_waiting` prevents duplicate active/waiting entries per user
- `queue_updated` Socket.io event broadcasts to mirror room on every queue change
- Mirror receives queue snapshot on connect (handles late-join scenario)

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
      mirror/       # Full-screen mirror display page (kiosk: attract → waiting → session)
      phone/        # Phone onboarding (sign-in → questionnaire → queue → idle → recap)
      admin/        # Admin dashboard (queue management, session controls, stats)
      demo/         # Mira video avatar demo page
    lib/            # Shared utilities
      api.ts               # REST API client (auth, queue, admin, scrape)
      streaming-tts.ts     # Streaming TTS with MediaSource + volume extraction
      emotion-parser.ts    # Parse [emotion:X] tags + detectEmotionFromText fallback
      socket.ts            # Socket.io client
      map-clothing-items.ts # Map API items to ClothingItem type
    hooks/
      useMiraVideoAvatar.ts # Video avatar state machine + TTS integration
      useDeepgramSTT.ts    # Deepgram STT WebSocket hook
      useCamera.ts         # Camera access hook
      useGestureRecognizer.ts # MediaPipe hand gesture hook
      usePoseDetection.ts  # MediaPipe BlazePose hook
    components/
      ui/
        mira-video-avatar.tsx # Mira video avatar (emotion loop MP4s)
      phone/
        GoogleSignIn.tsx     # Google OAuth button
        SelfieCapture.tsx    # Selfie capture component
        QueueStatus.tsx      # Queue position + status polling
      mirror/
        GestureIndicator.tsx # Gesture visual feedback
        VoiceIndicator.tsx   # Interim transcript indicator
        ClothingCanvas.tsx   # Clothing overlay rendering
        PriceStrip.tsx       # Minimal price strip on mirror page
    __tests__/             # Vitest test suites
  public/
    avatar/loops/seamless/ # 26 emotion loop MP4s (idle + talking variants)
backend/            # Python FastAPI
  main.py           # FastAPI app entry + Socket.io server + queue auto-advance
  agent/            # Mira orchestrator, Claude API integration
    orchestrator.py # Event-driven agent orchestrator
    prompts.py      # Mira's personality prompt
    tools.py        # Agent tool definitions
  routers/
    tts.py          # ElevenLabs TTS proxy endpoint
    auth.py         # Authentication routes (Google OAuth, profile, selfie)
    queue.py        # Queue management routes (join, status, skip, reorder, advance)
    admin.py        # Admin dashboard routes (queue view, session info, stats, force-end)
    users.py        # User routes
  scraper/          # Gmail scraping, data extraction
  mcp_server/       # MCP server for Poke integration (not mcp/ — avoids PyPI conflict)
  models/           # Pydantic models, DB schemas
    database.py     # Dual-mode DB connection (asyncpg + Neon HTTP)
    schemas.py      # Pydantic request/response models
  services/         # Serper.dev, Deepgram integrations
    serper_search.py       # Serper.dev Shopping API (CLI + library)
    background_removal.py  # rembg background removal for flat lays
  migrations/       # Raw SQL migration files
    001_initial_schema.sql
    009_add_selfie_column.sql
  tests/            # Pytest test suite
jenny/              # Standalone Mira prototype (vanilla JS, archived reference)
```

## Environment Variables

### Frontend (.env.local)
- `NEXT_PUBLIC_SOCKET_URL` — Backend WebSocket URL
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID` — Google OAuth client ID
- `NEXT_PUBLIC_PHONE_URL` — Phone onboarding URL (for QR code on attract screen)

### Backend (.env)
- `DATABASE_URL` — Neon Postgres connection string (required)
- `SERPER_API_KEY` — Serper.dev API key (required, see .env.example)
- `ANTHROPIC_API_KEY` — Claude API key (required)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth
- `DEEPGRAM_API_KEY` — Deepgram STT key
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

Or use the Neon SQL Editor in the dashboard, or the Neon MCP `run_sql` tool.

## Current Implementation Status

**Completed**:
- Database schema and Neon Postgres integration
- Serper.dev Shopping API integration with CLI tool
- FastAPI backend with Socket.io real-time communication
- Next.js frontend with mirror/phone/admin page structure
- Mirror kiosk mode (attract → waiting → session)
- Phone onboarding flow (OAuth → questionnaire → queue → idle → recap)
- Queue system with auto-activation, skip, reorder, advance
- Admin dashboard (queue management, session controls, booth stats)
- MediaPipe integration for body/hand tracking
- Mira agent orchestrator (event-driven Claude API calls via `agent/orchestrator.py`)
- MiraVideoAvatar with 26 emotion loops (idle + talking variants)
- ElevenLabs streaming TTS backend proxy (`backend/routers/tts.py`) with chunked audio
- Deepgram streaming STT (`useDeepgramSTT` hook)
- Emotion parsing with `[emotion:X]` tags + `detectEmotionFromText` fallback
- Mirror UI components: VideoAvatar, ClothingCanvas, PriceStrip, VoiceIndicator, GestureIndicator
- MCP server for Poke integration (`backend/mcp_server/`)
- Selfie capture during onboarding
- rembg background removal for clothing flat lays
- Google OAuth sign-in

**In Progress / Planned**:
- Gmail OAuth and scraping pipeline
- Clothing overlay rendering improvements
- Calendar event integration for occasion-aware recommendations

## Conventions

- Frontend uses TypeScript, backend uses Python 3.11+
- Socket.io events use snake_case: `queue_updated`, `session_active`, `mira_speech`, `mirror_event`
- All Claude API calls go through `backend/agent/orchestrator.py` — never call Claude directly from frontend
- Mira's personality prompt lives in `backend/agent/prompts.py`
- Database migrations via raw SQL files in `backend/migrations/`
- Queue state is broadcast via `queue_updated` event to the `mirror` Socket.io room
- Admin force-end triggers `session_force_end` event, mirror handles cleanup
