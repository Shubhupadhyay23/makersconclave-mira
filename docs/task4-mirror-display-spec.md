# Task 4: Mirror Display — Detailed Spec

> Full-screen Chrome web app rendered behind a one-way mirror film on a 1080p TV.

## Physical Setup

- **Display**: 1920x1080 TV/monitor with one-way mirror film applied
- **Camera**: External USB webcam mounted on the TV/mirror frame
- **Background**: Pure black (#000) — only rendered elements show through the mirror film
- **Browser**: Full-screen Chrome (F11), no browser chrome visible

## Core Components

### 1. Webcam + MediaPipe BlazePose

- Webcam feed via `getUserMedia` — **not rendered on screen** (user sees their own reflection through the mirror film)
- MediaPipe BlazePose in **heavy mode** for best landmark accuracy
- Runs on **every frame** (~30fps), all data stays frontend-only
- 33 pose landmarks used to position clothing overlays
- Camera snapshots sent to backend **only when agent requests them** via Socket.io

### 2. Clothing Overlay (Full Image Warping)

- **Full body overlay**: tops, bottoms, shoes, accessories — all body regions
- Agent decides whether to show one piece or full outfit based on recommendation
- **Affine transforms** warp clothing images onto body keypoints:
  - Tops: shoulders (landmarks 11, 12) + hips (23, 24)
  - Bottoms: hips (23, 24) + ankles (27, 28)
  - Shoes: ankles (27, 28) + feet (29, 30, 31, 32)
  - Accessories: varies per type
- **Background removal**: Backend processes clothing images with `rembg` (Python), stores transparent PNGs, URL saved in `clothing_items.image_url`
- Overlay rendered on HTML Canvas layer on top of black background

### 3. Mira Avatar (HeyGen + Glassmorphism)

- **Source**: HeyGen LiveAvatar video stream
- **Styling**: Glassmorphism CSS — `backdrop-filter: blur()`, transparency, rounded container
- **Position**: Floats dynamically around screen edges, **collision-aware** — tracks overlay positions and moves to unoccupied space
- **Behavior**: Always visible during active session

### 4. Outfit Transitions

- **Shimmer/sparkle effect** when changing outfits (swipe gesture)
- Built with **CSS animations** (pure keyframe sparkles)
- Brief particle burst during transition, then new outfit fades in

### 5. Text UI

- **Default**: No text shown — purely visual (clothing overlay + avatar)
- **On request**: When user does thumbs-up or asks Mira, show info panel with item name, brand, price
- Semi-transparent floating labels

### 6. Idle Screen

- When no session is active: display a **QR code** (links to phone onboarding page)
- Black background with centered QR code — looks like a mirror with a floating QR code

### 7. Vision Snapshots

- **Agent-triggered only**: Backend sends Socket.io event requesting a snapshot
- Frontend captures current webcam frame, encodes as JPEG (quality 0.6-0.8), sends back via Socket.io
- Used by Claude Vision `analyze_current_outfit` tool

## Socket.io Events (Mirror-Specific)

### Listens To (from backend)
- `outfit_recommendation` — Render new clothing overlay
- `outfit_changed` — Transition to next/previous outfit
- `agent_response` — Mira speaking (avatar state update)
- `session_status` — Session start/end
- `request_snapshot` — Capture and send webcam frame
- `show_outfit_info` — Display text info panel for current outfit

### Emits (to backend)
- `gesture_detected` — Swipe/thumbs gesture (already implemented)
- `camera_snapshot` — Response to snapshot request
- `session_ready` — Mirror display is loaded and ready

## Layout (1920x1080)

```
┌──────────────────────────────────────────────┐
│                                              │
│          BLACK BACKGROUND                    │
│                                              │
│     ┌─────────────┐                          │
│     │  Clothing    │         ┌──────────┐    │
│     │  Overlay     │         │  Mira    │    │
│     │  (Canvas)    │         │  Avatar  │    │
│     │  positioned  │         │  (float) │    │
│     │  on body via │         └──────────┘    │
│     │  landmarks   │                          │
│     └─────────────┘                          │
│                                              │
│     [sparkle transition on outfit change]    │
│                                              │
│     [info panel appears on thumbs-up only]   │
│                                              │
└──────────────────────────────────────────────┘
```

## Technical Decisions

- **Canvas rendering**: Use HTML Canvas for clothing overlay (needed for affine transforms/warping)
- **CSS for avatar**: Glassmorphism via CSS `backdrop-filter` on avatar container
- **CSS for particles**: Pure CSS keyframe sparkle animations
- **Pose at 30fps**: Heavy mode BlazePose, no throttling, frontend-only
- **Image cache**: Backend processes with rembg, stores transparent PNG URL in DB
- **Target**: 1080p, external USB webcam
