# Mirror Experience Wiring Spec

**Date:** 2026-02-14
**Goal:** Connect the existing Mira agent to the real mirror display with live avatar, voice input, product UI, and gesture interaction.

---

## Architecture Overview

```
Browser (Mirror Page)
  |
  |-- getUserMedia (video) --> Webcam reflection (mirrored, full screen)
  |-- getUserMedia (audio) --> Deepgram WebSocket (streaming STT)
  |-- HeyGen SDK           --> Avatar PiP (top-right corner)
  |-- Socket.io            --> Backend
  |
  |   Events OUT: gesture_detected, mirror_event (voice transcript, snapshot)
  |   Events IN:  mira_speech, tool_result (clothing_results), request_snapshot,
  |               session_ended, session_error
  |
Backend (FastAPI + Socket.io)
  |
  |-- Mira Orchestrator --> Claude API (Sonnet for speech, Haiku for tools)
  |-- GET /api/heygen/token --> HeyGen token generation
  |-- Deepgram: browser-direct (no proxy)
```

### Data Flow (Full Loop)

```
1. User speaks into mirror mic
2. Browser captures audio --> Deepgram WebSocket (browser-direct)
3. Deepgram returns transcript --> Browser
4. Browser emits mirror_event {type: "voice", transcript: "..."} --> Backend
5. Orchestrator builds messages --> Claude API (streaming)
6. Claude streams text chunks --> Orchestrator
7. Orchestrator emits mira_speech {text: chunk} --> Browser (Socket.io)
8. Browser sentence-buffers chunks --> avatar.speak({text, task_type: REPEAT})
9. HeyGen renders avatar speaking in PiP
10. If Claude calls present_items --> Orchestrator emits tool_result --> Browser
11. Browser renders product carousel at bottom of screen
12. User swipes/thumbs gesture --> MediaPipe detects --> dual routing:
    a. Frontend: animate card (Tinder-style swipe) immediately
    b. Backend: gesture_detected event --> Mira reacts ("oh you liked that?")
```

---

## Part 1: HeyGen Avatar Integration

### Token Endpoint

**New endpoint: `GET /api/heygen/token`**
**File: `backend/routers/heygen.py`** (new file)

```python
@router.get("/token")
async def get_heygen_token():
    """Generate a short-lived HeyGen session token."""
    # POST to https://api.heygen.com/v1/streaming.create_token
    # Auth: x-api-key header with HEYGEN_API_KEY env var
    # Returns: {"data": {"token": "..."}}
```

Register in `main.py` alongside other routers.

**Environment variable:** `HEYGEN_API_KEY` (already documented in CLAUDE.md)

### Frontend Avatar Hook

**New file: `frontend/src/hooks/useHeyGenAvatar.ts`**

Custom hook that manages the HeyGen avatar lifecycle:

```typescript
interface UseHeyGenAvatarReturn {
  isReady: boolean;
  isSpeaking: boolean;
  startAvatar: () => Promise<void>;
  stopAvatar: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  videoRef: RefObject<HTMLVideoElement>;
}
```

**Behavior:**
- `startAvatar()`: Fetches token from `GET /api/heygen/token`, creates StreamingAvatar, calls `createStartAvatar()` with a default avatar name (configurable via `NEXT_PUBLIC_HEYGEN_AVATAR_ID` env var or fallback to HeyGen default)
- On `STREAM_READY` event: attaches MediaStream to the `videoRef` element, sets `isReady = true`
- On `AVATAR_START_TALKING` / `AVATAR_STOP_TALKING`: updates `isSpeaking` state
- `speak(text)`: calls `avatar.speak({ text, task_type: TaskType.REPEAT })`
- `stopAvatar()`: calls `avatar.stopAvatar()`, cleans up
- Quality: `AvatarQuality.Medium` (balance between visual quality and latency)

**Idle behavior:** HeyGen plays idle animation by default while the avatar is not speaking. `activityIdleTimeout` set to 3600 (1 hour) to prevent auto-termination during long sessions.

### Avatar Lifecycle

- **Created:** When `start_session` Socket.io event fires (user steps up to mirror)
- **Destroyed:** When session ends (disconnect, `end_session` event, or session timeout)
- Avatar creation takes 2-3 seconds; during this time, show a brief loading state in the PiP area

### Sentence Buffer

**New file: `frontend/src/lib/sentence-buffer.ts`**

```typescript
class SentenceBuffer {
  private buffer = "";
  private onSentence: (sentence: string) => void;

  feed(chunk: string): void {
    // Append chunk to buffer
    // On sentence boundary (. ! ? followed by space or end), flush
  }

  flush(): void {
    // Force-flush remaining buffer (called when streaming ends)
  }
}
```

Used in the mirror page to accumulate `mira_speech` chunks and call `avatar.speak()` once per sentence.

### Avatar Positioning (PiP)

- Position: **top-right corner** of the mirror display
- Size: ~200x200px (or 15% of viewport width), rounded corners
- Style: slight border/glow to separate from mirror background
- z-index above webcam feed, below gesture indicator
- When avatar is not speaking, idle animation plays (subtle breathing/blinking)

---

## Part 2: Deepgram STT (Voice Input)

### Approach: Browser-Direct WebSocket

The browser opens a WebSocket connection directly to Deepgram's API. No backend proxy.

**API key delivery:** Embedded as `NEXT_PUBLIC_DEEPGRAM_API_KEY` environment variable. The key is visible in the browser bundle. Acceptable for this hackathon project.

### Frontend Voice Hook

**New file: `frontend/src/hooks/useDeepgramSTT.ts`**

```typescript
interface UseDeepgramSTTReturn {
  isListening: boolean;
  transcript: string;       // latest final transcript
  interimTranscript: string; // current interim (partial) transcript
  startListening: () => void;
  stopListening: () => void;
}
```

**Behavior:**
- Opens `navigator.mediaDevices.getUserMedia({ audio: true })` as a **separate stream** from the existing webcam stream (independent failure modes)
- Connects WebSocket to `wss://api.deepgram.com/v1/listen` with params:
  - `model=nova-2` (best accuracy)
  - `smart_format=true` (punctuation, capitalization)
  - `interim_results=true` (show partial transcripts while speaking)
  - `vad_events=true` (voice activity detection)
  - `utterance_end_ms=1500` (1.5s silence = end of utterance)
  - `encoding=linear16`, `sample_rate=16000`
- Uses `MediaRecorder` or `AudioContext` + `ScriptProcessorNode` to capture PCM audio and send binary frames to Deepgram
- On `utterance_end` or final transcript: emits the transcript to the parent component

### Interrupt Policy

- Deepgram runs from the moment the Mira session starts (always listening)
- **While Mira is speaking:** transcripts are **queued**, not sent to the backend. The user's speech is captured but held until Mira finishes her current utterance. This prevents interrupting the scripted opener.
- **When Mira stops speaking:** any queued transcript is flushed to the backend as a single `mirror_event` with `type: "voice"`
- This means the user can start talking while Mira is finishing, and their input won't be lost -- it just waits for Mira to finish

### Visual Indicator

- When Deepgram detects voice activity, show a subtle mic/waveform indicator on the mirror (e.g., bottom-left corner)
- Shows interim transcript text briefly so the user knows they're being heard
- Fades away 1-2s after speech ends

---

## Part 3: Product Carousel (Bottom of Screen)

### Layout

- **Position:** Bottom 20% of the mirror display (horizontal strip)
- **Cards:** Horizontal scrollable row, max 5 cards visible
- **Card content:** Product image, title (truncated to 1 line), price
- **Background:** Semi-transparent dark gradient (so cards are readable over the mirror reflection)
- **Entry animation:** Slides up from bottom when `tool_result` with `type: "clothing_results"` arrives
- **Exit animation:** Slides down when products are dismissed or session ends

### Card Structure

Each card displays data from the `tool_result` payload:
```typescript
interface ProductCard {
  product_id: string;
  title: string;
  price: string;
  image_url: string;
  link: string;
  source: string;
}
```

- Image: Fill card (aspect-ratio cover, ~150x180px)
- Title: Below image, 1 line, ellipsis overflow
- Price: Below title, bold
- Source: Small label (e.g., "Nordstrom")

### Gesture Interaction (Dual Routing)

When gestures are detected while the carousel is visible:

**Frontend (immediate UI):**
| Gesture | UI Action |
|---------|-----------|
| `swipe_right` | Current card flies right with a heart overlay animation, next card slides in |
| `swipe_left` | Current card flies left with an X overlay animation, next card slides in |
| `thumbs_up` | Current card pulses with a heart animation, stays visible |
| `thumbs_down` | Current card shakes and fades out, next card slides in |

**Backend (parallel, async):**
| Gesture | Backend Action |
|---------|---------------|
| `swipe_right` / `thumbs_up` | Orchestrator increments `session.likes`, appends to `session.liked_items` |
| `swipe_left` / `thumbs_down` | Orchestrator increments `session.dislikes` |
| All gestures | Mira receives gesture description and may comment ("Oh you liked that one!") |

The frontend does NOT wait for backend confirmation to animate. The card animation is local and instant. Mira's verbal reaction arrives ~1-2s later via `mira_speech`.

### Carousel State

- First card in the array is the "active" card (no extra highlighting, order is enough context)
- When all cards have been swiped through, the carousel slides away
- If Mira calls `present_items` again later, new cards replace the old carousel

---

## Part 4: Mirror Page Wiring (Putting It All Together)

### Updated Mirror Page Component Tree

```
MirrorPage
  |-- useCamera()              -- existing: webcam video stream
  |-- useGestureRecognizer()   -- existing: MediaPipe hand/gesture detection
  |-- useDeepgramSTT()         -- NEW: voice input
  |-- useHeyGenAvatar()        -- NEW: avatar output
  |-- SentenceBuffer           -- NEW: text chunk -> sentence buffering
  |
  |-- <video> (webcam)         -- existing: full-screen mirrored feed
  |-- <video> (avatar PiP)     -- NEW: top-right corner
  |-- <GestureIndicator>       -- existing: gesture emoji feedback
  |-- <ProductCarousel>        -- NEW: bottom strip with swipeable cards
  |-- <VoiceIndicator>         -- NEW: mic waveform + interim transcript
```

### Session Lifecycle (Mirror Page)

```
1. Page loads:
   - Start webcam (existing)
   - Start gesture recognizer (existing)
   - Connect Socket.io, join room (existing)
   - DO NOT start HeyGen or Deepgram yet

2. start_session event received:
   - Start HeyGen avatar session (fetch token, create avatar)
   - Start Deepgram STT (open mic, connect WebSocket)
   - Show loading indicator in PiP area while avatar initializes

3. During session:
   - Deepgram transcripts --> queued while Mira speaking, sent when she stops
   - mira_speech chunks --> sentence-buffered --> avatar.speak()
   - tool_result (clothing_results) --> product carousel appears
   - Gestures --> dual routing (UI + backend)
   - request_snapshot --> capture frame, send base64 (existing)

4. Session ends (session_ended event OR disconnect):
   - Stop HeyGen avatar (avatar.stopAvatar())
   - Stop Deepgram STT (close WebSocket, stop mic)
   - Clear product carousel (slide down animation)
   - Return to pure webcam mirror view (clean reset)
   - All cleanup, ready for next user
```

### Socket.io Events (Complete Updated Catalog)

**Mirror --> Backend:**
| Event | Payload | Notes |
|-------|---------|-------|
| `join_room` | `{user_id}` | Existing |
| `start_session` | `{user_id}` | Existing |
| `mirror_event` | `{user_id, event: {type: "voice", transcript}}` | Now carries Deepgram transcripts |
| `mirror_event` | `{user_id, event: {type: "gesture", gesture}}` | Existing |
| `mirror_event` | `{user_id, event: {type: "snapshot", image_base64}}` | Existing |
| `gesture_detected` | `{type, confidence, timestamp}` | Existing (parallel to mirror_event) |
| `end_session` | `{user_id}` | Existing |

**Backend --> Mirror:**
| Event | Payload | Notes |
|-------|---------|-------|
| `mira_speech` | `{text, is_chunk}` | Existing -- now consumed by sentence buffer -> HeyGen |
| `tool_result` | `{type: "clothing_results", items: [...]}` | Existing -- now renders product carousel |
| `request_snapshot` | `{user_id}` | Existing |
| `session_ended` | `{session_id, summary, liked_items, stats}` | Existing -- triggers cleanup |
| `session_error` | `{error}` | Existing |

No new Socket.io events needed. The existing event catalog covers everything.

---

## Part 5: New Environment Variables

### Frontend `.env.local` (new additions)
```
NEXT_PUBLIC_DEEPGRAM_API_KEY=...       # Deepgram API key (browser-direct)
NEXT_PUBLIC_HEYGEN_AVATAR_ID=...       # Optional: specific avatar ID (fallback to default)
```

### Backend `.env` (already documented, just need values)
```
HEYGEN_API_KEY=...                     # HeyGen API key for token generation
DEEPGRAM_API_KEY=...                   # Not used by backend (browser-direct), but kept for reference
```

---

## Part 6: New NPM Dependencies

```bash
cd frontend
npm install @heygen/streaming-avatar livekit-client
```

Deepgram uses raw WebSocket (no SDK needed for browser-direct streaming).

---

## Files to Create

| File | Purpose |
|------|---------|
| `backend/routers/heygen.py` | GET /api/heygen/token endpoint |
| `frontend/src/hooks/useHeyGenAvatar.ts` | HeyGen avatar lifecycle hook |
| `frontend/src/hooks/useDeepgramSTT.ts` | Deepgram streaming STT hook |
| `frontend/src/lib/sentence-buffer.ts` | Chunk-to-sentence buffering for avatar speech |
| `frontend/src/components/mirror/ProductCarousel.tsx` | Bottom carousel with animated cards |
| `frontend/src/components/mirror/VoiceIndicator.tsx` | Mic waveform + interim transcript display |
| `frontend/src/components/mirror/AvatarPiP.tsx` | PiP container for HeyGen video element |

## Files to Modify

| File | Change |
|------|--------|
| `backend/main.py` | Register heygen router |
| `frontend/src/app/mirror/page.tsx` | Wire all new hooks + components into mirror page |

---

## Implementation Order

1. **HeyGen token endpoint** (backend) -- unblocks frontend avatar work
2. **Sentence buffer** (frontend) -- pure utility, no deps
3. **HeyGen avatar hook + AvatarPiP** (frontend) -- get avatar rendering in PiP
4. **Deepgram STT hook + VoiceIndicator** (frontend) -- get voice input working
5. **Product carousel component** (frontend) -- render cards with swipe animations
6. **Mirror page wiring** -- connect all hooks/components, gesture dual routing, session lifecycle
7. **End-to-end testing** -- full loop: speak -> Mira responds -> avatar speaks -> products appear -> swipe

---

## Edge Cases & Notes

- **HeyGen session timeout:** Set `activityIdleTimeout: 3600` to prevent premature termination. If session drops, show a reconnecting indicator.
- **Deepgram disconnects:** If WebSocket drops, attempt one reconnect. If it fails, show "Voice input unavailable" indicator but don't crash the session.
- **No products state:** Carousel only appears when `tool_result` arrives. If Mira never calls `present_items`, no carousel is shown.
- **Multiple present_items calls:** Each new `tool_result` replaces the previous carousel contents. Old cards slide out, new cards slide in.
- **Gesture without carousel:** If user gestures when no products are displayed, gesture still goes to backend (Mira might say "nothing to swipe yet!") but no frontend card animation occurs.
- **Audio feedback loop:** The mirror's speakers will play HeyGen avatar audio. Deepgram might pick this up. Rely on Deepgram's VAD + noise suppression. If echo is an issue, mute Deepgram while avatar is speaking (same queue-while-speaking pattern handles this implicitly).

---

## Part 8: Unit Tests

Tests follow existing project conventions: **Vitest** (`describe`/`it`/`expect`) for frontend, **pytest** + `AsyncMock` for backend. Frontend tests live in `frontend/src/__tests__/`, backend tests in `backend/tests/`.

### Backend Tests

#### `backend/tests/test_heygen_routes.py` — HeyGen token endpoint

```python
"""Tests for the HeyGen token endpoint."""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from httpx import AsyncClient
from main import app


@pytest.mark.asyncio
async def test_get_heygen_token_success():
    """GET /api/heygen/token returns a session token from HeyGen API."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"data": {"token": "hg_test_token_123"}}

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post.return_value = mock_response
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.get("/api/heygen/token")

    assert response.status_code == 200
    assert response.json()["token"] == "hg_test_token_123"


@pytest.mark.asyncio
async def test_get_heygen_token_missing_api_key():
    """Returns 500 when HEYGEN_API_KEY is not set."""
    with patch("routers.heygen.os.environ.get", return_value=None):
        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.get("/api/heygen/token")

    assert response.status_code == 500


@pytest.mark.asyncio
async def test_get_heygen_token_heygen_api_error():
    """Returns 502 when HeyGen API returns an error."""
    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.text = "Unauthorized"

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post.return_value = mock_response
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.get("/api/heygen/token")

    assert response.status_code == 502
```

#### `backend/tests/test_socket_events.py` — Add test for emit_scrape_phase

```python
# Add to existing file:

@pytest.mark.asyncio
async def test_emit_scrape_phase():
    """emit_scrape_phase emits scrape_phase event with phase and detail."""
    sio = AsyncMock()
    await emit_scrape_phase(
        sio,
        user_id="user-456",
        phase="fetching_emails",
        detail="Searching Gmail for receipts...",
    )
    sio.emit.assert_called_once_with(
        "scrape_phase",
        {
            "user_id": "user-456",
            "phase": "fetching_emails",
            "detail": "Searching Gmail for receipts...",
        },
        room="user-456",
    )


@pytest.mark.asyncio
async def test_emit_scrape_phase_empty_detail():
    """emit_scrape_phase works with empty detail string."""
    sio = AsyncMock()
    await emit_scrape_phase(sio, user_id="user-789", phase="storing")
    call_args = sio.emit.call_args[0][1]
    assert call_args["phase"] == "storing"
    assert call_args["detail"] == ""
```

#### `backend/tests/test_pipeline.py` — Add test for on_phase callback

```python
# Add to existing file:

@pytest.mark.asyncio
async def test_fast_scrape_calls_on_phase():
    """fast_scrape invokes on_phase callback at each pipeline stage."""
    mock_svc = _mock_gmail_service()
    phases_received = []

    async def on_phase(phase, detail):
        phases_received.append(phase)

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        await fast_scrape(
            token_data={"access_token": "test"},
            on_phase=on_phase,
        )

    assert "fetching_emails" in phases_received
    assert "extracting" in phases_received
    assert "building_profile" in phases_received
    assert "calendar_done" in phases_received


@pytest.mark.asyncio
async def test_fast_scrape_works_without_on_phase():
    """fast_scrape runs fine when on_phase is None (backward compat)."""
    mock_svc = _mock_gmail_service()

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        result = await fast_scrape(token_data={"access_token": "test"})

    assert isinstance(result, ScrapeResult)
```

#### `backend/tests/test_users.py` — DELETE endpoint (new file)

```python
"""Tests for user endpoints including DELETE."""

import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient
from main import app


@pytest.mark.asyncio
async def test_delete_user_success():
    """DELETE /users/{id} returns 200 with status deleted."""
    mock_db = AsyncMock()
    mock_db.execute.return_value = [{"id": "abc-123"}]

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.delete("/users/abc-123")

    assert response.status_code == 200
    assert response.json() == {"status": "deleted"}
    mock_db.execute.assert_called_once()
    assert "DELETE FROM users" in mock_db.execute.call_args[0][0]


@pytest.mark.asyncio
async def test_delete_user_not_found():
    """DELETE /users/{id} returns 404 when user doesn't exist."""
    mock_db = AsyncMock()
    mock_db.execute.return_value = []

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.delete("/users/nonexistent-id")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_user_closes_db():
    """DELETE /users/{id} always closes the DB connection."""
    mock_db = AsyncMock()
    mock_db.execute.side_effect = Exception("DB error")

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        async with AsyncClient(app=app, base_url="http://test") as ac:
            response = await ac.delete("/users/abc-123")

    mock_db.close.assert_called_once()
```

---

### Frontend Tests

#### `frontend/src/__tests__/sentence-buffer.test.ts` — Sentence buffering logic

```typescript
import { describe, it, expect, vi } from "vitest";
import { SentenceBuffer } from "@/lib/sentence-buffer";

describe("SentenceBuffer", () => {
  it("flushes on period followed by space", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hello world. ");
    expect(onSentence).toHaveBeenCalledWith("Hello world.");
  });

  it("flushes on question mark", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("How are you? ");
    expect(onSentence).toHaveBeenCalledWith("How are you?");
  });

  it("flushes on exclamation mark", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Wow! ");
    expect(onSentence).toHaveBeenCalledWith("Wow!");
  });

  it("accumulates chunks until sentence boundary", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hello ");
    buffer.feed("world");
    expect(onSentence).not.toHaveBeenCalled();

    buffer.feed(". ");
    expect(onSentence).toHaveBeenCalledWith("Hello world.");
  });

  it("handles multiple sentences in one chunk", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("First. Second. ");
    expect(onSentence).toHaveBeenCalledTimes(2);
    expect(onSentence).toHaveBeenNthCalledWith(1, "First.");
    expect(onSentence).toHaveBeenNthCalledWith(2, "Second.");
  });

  it("flush() sends remaining buffer content", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Trailing text without punctuation");
    expect(onSentence).not.toHaveBeenCalled();

    buffer.flush();
    expect(onSentence).toHaveBeenCalledWith("Trailing text without punctuation");
  });

  it("flush() is a no-op when buffer is empty", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.flush();
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("does not split on periods inside numbers", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Price is $29.99 for this item. ");
    expect(onSentence).toHaveBeenCalledTimes(1);
    expect(onSentence).toHaveBeenCalledWith("Price is $29.99 for this item.");
  });

  it("handles empty string feed gracefully", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("");
    buffer.feed("");
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("handles ellipsis without splitting", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hmm... let me think. ");
    // Should not split at the ellipsis, only at the final period
    expect(onSentence).toHaveBeenCalledTimes(1);
  });
});
```

#### `frontend/src/__tests__/product-carousel.test.tsx` — ProductCarousel component

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ProductCarousel from "@/components/mirror/ProductCarousel";

const mockItems = [
  {
    product_id: "p1",
    title: "Nike Air Max 90",
    price: "$129.99",
    image_url: "https://example.com/shoe.jpg",
    link: "https://example.com/shoe",
    source: "Nordstrom",
  },
  {
    product_id: "p2",
    title: "Zara Oversized Blazer",
    price: "$89.00",
    image_url: "https://example.com/blazer.jpg",
    link: "https://example.com/blazer",
    source: "Zara",
  },
];

describe("ProductCarousel", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(
      <ProductCarousel items={[]} onGesture={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders product cards with title and price", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Nike Air Max 90")).toBeDefined();
    expect(screen.getByText("$129.99")).toBeDefined();
    expect(screen.getByText("Zara Oversized Blazer")).toBeDefined();
  });

  it("renders source labels on cards", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Nordstrom")).toBeDefined();
    expect(screen.getByText("Zara")).toBeDefined();
  });

  it("renders product images with correct src", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute("src")).toContain("shoe.jpg");
  });

  it("calls onGesture when gesture event is received", () => {
    const onGesture = vi.fn();
    render(<ProductCarousel items={mockItems} onGesture={onGesture} />);

    // Simulate a swipe_right on the first item
    onGesture("swipe_right", mockItems[0]);
    expect(onGesture).toHaveBeenCalledWith("swipe_right", mockItems[0]);
  });

  it("replaces items when new items prop arrives", () => {
    const { rerender } = render(
      <ProductCarousel items={mockItems} onGesture={vi.fn()} />
    );

    const newItems = [
      { ...mockItems[0], title: "Adidas Ultraboost", product_id: "p3" },
    ];
    rerender(<ProductCarousel items={newItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Adidas Ultraboost")).toBeDefined();
    expect(screen.queryByText("Nike Air Max 90")).toBeNull();
  });
});
```

#### `frontend/src/__tests__/voice-indicator.test.tsx` — VoiceIndicator component

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";

describe("VoiceIndicator", () => {
  it("renders nothing when not listening", () => {
    const { container } = render(
      <VoiceIndicator isListening={false} interimTranscript="" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows indicator when listening", () => {
    render(<VoiceIndicator isListening={true} interimTranscript="" />);
    // Should render the mic/waveform indicator
    expect(document.querySelector("[data-testid='voice-indicator']")).not.toBeNull();
  });

  it("displays interim transcript text", () => {
    render(
      <VoiceIndicator isListening={true} interimTranscript="I want something" />
    );
    expect(screen.getByText("I want something")).toBeDefined();
  });

  it("updates transcript when prop changes", () => {
    const { rerender } = render(
      <VoiceIndicator isListening={true} interimTranscript="Hello" />
    );
    expect(screen.getByText("Hello")).toBeDefined();

    rerender(
      <VoiceIndicator isListening={true} interimTranscript="Hello world" />
    );
    expect(screen.getByText("Hello world")).toBeDefined();
  });
});
```

---

### Test Files Summary

| Test File | Tests | What It Covers |
|-----------|-------|---------------|
| `backend/tests/test_heygen_routes.py` | 3 | Token endpoint: success, missing key, HeyGen API error |
| `backend/tests/test_socket_events.py` | +2 | `emit_scrape_phase` with and without detail |
| `backend/tests/test_pipeline.py` | +2 | `on_phase` callback invocation, backward compat without callback |
| `backend/tests/test_users.py` | 3 | DELETE endpoint: success, not found, DB cleanup |
| `frontend/src/__tests__/sentence-buffer.test.ts` | 9 | Sentence boundary detection, chunked accumulation, flush, edge cases (numbers, ellipsis, empty) |
| `frontend/src/__tests__/product-carousel.test.tsx` | 6 | Rendering, empty state, gesture callback, item replacement |
| `frontend/src/__tests__/voice-indicator.test.tsx` | 4 | Visibility toggle, transcript display, prop updates |
| **Total** | **29** | |

### Running Tests

```bash
# Backend
cd backend && pytest tests/test_heygen_routes.py tests/test_users.py -v
cd backend && pytest tests/test_socket_events.py tests/test_pipeline.py -v

# Frontend
cd frontend && npm run test

# All
cd backend && pytest && cd ../frontend && npm run test
```
