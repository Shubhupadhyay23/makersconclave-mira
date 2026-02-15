# Merge Resolution Spec: Kiosk Mode + Video Avatar

## Context
Local `main` (13 commits ahead) has kiosk mode, onboarding flow, queue system, and admin dashboard.
Origin `main` (8 commits) has Vivian's MiraVideoAvatar (replacing Orb), rembg service, emotion loop videos, and test pipeline.

## Decisions

### Avatar System: **Video Avatar wins**
- Use `MiraVideoAvatar` component + `useMiraVideoAvatar` hook (Vivian's)
- Remove all Orb references (`@/components/ui/orb`, dynamic import, `useOrbAvatar`)
- 26 emotion loop MP4s with idle/talking variants stay
- No real-time audio reactivity needed — loop switching is sufficient

### Emotion Detection: **Keep fallback**
- Keep Vivian's `detectEmotionFromText()` in `emotion-parser.ts`
- Use `parseEmotionTag()` first, then `detectEmotionFromText()` as fallback when no `[emotion:X]` tag present
- This feeds the video avatar's richer emotion set (13 emotions vs Orb's 4)

### Kiosk Flow: **Local branch wins entirely**
- Keep attract → waiting → session state machine
- QR code attract screen, "Up next" waiting screen with Start Session button
- Mirror button triggers session start (not phone, not auto-start)
- `session_force_end` handler stays
- `handleSkipUser` callback stays
- `WaitingCountdown` component stays
- Vivian's standalone "Start Session" button overlay is removed (superseded by kiosk waiting state)

### Avatar Positioning: **Fixed position**
- Video avatar stays in a fixed corner position, no context-aware movement
- Remove the `orbStyle`/`avatarStyle` useMemo that changes position based on state

### Backend: **Keep both sides**
- Admin router + queue socket handlers (local)
- rembg background removal service (Vivian)
- Nano Banana test pipeline (Vivian)
- Wire everything together in main.py

## Files Affected
- `frontend/src/app/mirror/page.tsx` — main conflict file
- `frontend/src/lib/emotion-parser.ts` — keep Vivian's expanded version
- `backend/main.py` — merge both sides' additions
- New files from origin (no conflicts): `mira-video-avatar.tsx`, `useMiraVideoAvatar.ts`, demo pages, avatar loops
