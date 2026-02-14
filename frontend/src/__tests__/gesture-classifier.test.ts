import { describe, it, expect } from "vitest";
import {
  createSwipeState,
  detectSwipe,
  classifyBuiltInGesture,
} from "@/lib/gesture-classifier";

describe("createSwipeState", () => {
  it("returns empty initial state", () => {
    const state = createSwipeState();
    expect(state.positions).toEqual([]);
    expect(state.lastGestureTime).toBe(0);
  });
});

describe("detectSwipe", () => {
  it("returns null when not enough positions", () => {
    const state = createSwipeState();
    const result = detectSwipe(state, 0.5, 100);
    expect(result).toBeNull();
  });

  it("detects swipe right when wrist moves right quickly", () => {
    const state = createSwipeState();
    // Simulate wrist moving from x=0.3 to x=0.6 over 400ms
    const positions = [
      { x: 0.3, timestamp: 0 },
      { x: 0.35, timestamp: 50 },
      { x: 0.4, timestamp: 100 },
      { x: 0.45, timestamp: 150 },
      { x: 0.5, timestamp: 200 },
      { x: 0.55, timestamp: 250 },
      { x: 0.6, timestamp: 300 },
    ];
    state.positions = positions;

    const result = detectSwipe(state, 0.62, 350);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("swipe_right");
  });

  it("detects swipe left when wrist moves left quickly", () => {
    const state = createSwipeState();
    const positions = [
      { x: 0.7, timestamp: 0 },
      { x: 0.65, timestamp: 50 },
      { x: 0.6, timestamp: 100 },
      { x: 0.55, timestamp: 150 },
      { x: 0.5, timestamp: 200 },
      { x: 0.45, timestamp: 250 },
      { x: 0.4, timestamp: 300 },
    ];
    state.positions = positions;

    const result = detectSwipe(state, 0.38, 350);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("swipe_left");
  });

  it("returns null for small movements (not a swipe)", () => {
    const state = createSwipeState();
    const positions = [
      { x: 0.5, timestamp: 0 },
      { x: 0.51, timestamp: 50 },
      { x: 0.52, timestamp: 100 },
      { x: 0.51, timestamp: 150 },
    ];
    state.positions = positions;

    const result = detectSwipe(state, 0.52, 200);
    expect(result).toBeNull();
  });

  it("enforces cooldown between gestures", () => {
    const state = createSwipeState();
    state.lastGestureTime = 500;
    const positions = [
      { x: 0.3, timestamp: 500 },
      { x: 0.35, timestamp: 550 },
      { x: 0.4, timestamp: 600 },
      { x: 0.45, timestamp: 650 },
      { x: 0.5, timestamp: 700 },
      { x: 0.55, timestamp: 750 },
      { x: 0.6, timestamp: 800 },
    ];
    state.positions = positions;

    // 850ms - 500ms = 350ms, less than 800ms cooldown
    const result = detectSwipe(state, 0.62, 850);
    expect(result).toBeNull();
  });
});

describe("classifyBuiltInGesture", () => {
  it("maps Thumb_Up to thumbs_up", () => {
    const result = classifyBuiltInGesture("Thumb_Up", 0.9, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("thumbs_up");
    expect(result!.confidence).toBe(0.9);
  });

  it("maps Thumb_Down to thumbs_down", () => {
    const result = classifyBuiltInGesture("Thumb_Down", 0.85, 200);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("thumbs_down");
  });

  it("returns null for unrecognized gestures", () => {
    const result = classifyBuiltInGesture("Victory", 0.9, 100);
    expect(result).toBeNull();
  });

  it("returns null for None gesture", () => {
    const result = classifyBuiltInGesture("None", 0.9, 100);
    expect(result).toBeNull();
  });

  it("returns null for low confidence", () => {
    const result = classifyBuiltInGesture("Thumb_Up", 0.3, 100);
    expect(result).toBeNull();
  });
});
