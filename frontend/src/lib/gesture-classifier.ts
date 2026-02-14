import type { DetectedGesture, SwipeState } from "@/types/gestures";

const SWIPE_THRESHOLD = 0.15; // Minimum x-displacement (normalized 0-1)
const SWIPE_WINDOW_MS = 500; // Time window to detect swipe
const GESTURE_COOLDOWN_MS = 800; // Minimum time between gestures
const MIN_CONFIDENCE = 0.6; // Minimum confidence for built-in gestures

export function createSwipeState(): SwipeState {
  return { positions: [], lastGestureTime: 0 };
}

export function detectSwipe(
  state: SwipeState,
  currentX: number,
  currentTimestamp: number
): DetectedGesture | null {
  // Add current position
  state.positions.push({ x: currentX, timestamp: currentTimestamp });

  // Remove positions outside the time window
  const cutoff = currentTimestamp - SWIPE_WINDOW_MS;
  state.positions = state.positions.filter((p) => p.timestamp >= cutoff);

  // Need at least 5 data points for reliable swipe detection
  if (state.positions.length < 5) return null;

  // Enforce cooldown (skip if no gesture has been detected yet)
  if (
    state.lastGestureTime > 0 &&
    currentTimestamp - state.lastGestureTime < GESTURE_COOLDOWN_MS
  )
    return null;

  const oldest = state.positions[0];
  const dx = currentX - oldest.x;

  if (Math.abs(dx) < SWIPE_THRESHOLD) return null;

  const type = dx > 0 ? "swipe_right" : "swipe_left";

  // Reset state after detection
  state.positions = [];
  state.lastGestureTime = currentTimestamp;

  return {
    type,
    confidence: Math.min(Math.abs(dx) / 0.3, 1), // Scale confidence by displacement
    timestamp: currentTimestamp,
  };
}

export function classifyBuiltInGesture(
  gestureName: string,
  score: number,
  timestamp: number
): DetectedGesture | null {
  if (score < MIN_CONFIDENCE) return null;

  switch (gestureName) {
    case "Thumb_Up":
      return { type: "thumbs_up", confidence: score, timestamp };
    case "Thumb_Down":
      return { type: "thumbs_down", confidence: score, timestamp };
    default:
      return null;
  }
}
