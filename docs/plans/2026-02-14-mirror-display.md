# Mirror Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the full-screen mirror display — black background, BlazePose body tracking, clothing image overlay with affine warping, floating Mira avatar container, sparkle transitions, idle QR code screen, and agent-triggered camera snapshots.

**Architecture:** The mirror page (`frontend/src/app/mirror/page.tsx`) currently shows a webcam feed with gesture detection. We'll remove the visible webcam feed (black background for one-way mirror film), add BlazePose for full-body pose landmarks at 30fps, render clothing overlays on a Canvas using affine transforms, add a glassmorphism HeyGen avatar container that floats collision-aware, and add backend support for background removal via rembg. Socket.io events connect the mirror to the backend agent for outfit recommendations and snapshot requests.

**Tech Stack:** Next.js 15, React 19, TypeScript, MediaPipe BlazePose (heavy), HTML Canvas, CSS animations, Socket.io, Python FastAPI, rembg

---

### Task 1: Add BlazePose Pose Detection Hook

**Files:**
- Create: `frontend/src/hooks/usePoseDetection.ts`
- Create: `frontend/src/types/pose.ts`
- Test: `frontend/src/__tests__/pose-types.test.ts`

**Step 1: Create pose types**

Create `frontend/src/types/pose.ts`:

```typescript
export interface PoseLandmark {
  x: number; // 0-1 normalized
  y: number; // 0-1 normalized
  z: number;
  visibility: number; // 0-1 confidence
}

export interface PoseResult {
  landmarks: PoseLandmark[];
  timestamp: number;
}

// BlazePose landmark indices for clothing overlay
export const POSE_LANDMARKS = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;
```

**Step 2: Write the failing test**

Create `frontend/src/__tests__/pose-types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { POSE_LANDMARKS } from "@/types/pose";

describe("POSE_LANDMARKS", () => {
  it("has correct landmark indices for clothing overlay", () => {
    expect(POSE_LANDMARKS.LEFT_SHOULDER).toBe(11);
    expect(POSE_LANDMARKS.RIGHT_SHOULDER).toBe(12);
    expect(POSE_LANDMARKS.LEFT_HIP).toBe(23);
    expect(POSE_LANDMARKS.RIGHT_HIP).toBe(24);
    expect(POSE_LANDMARKS.LEFT_ANKLE).toBe(27);
    expect(POSE_LANDMARKS.RIGHT_ANKLE).toBe(28);
  });

  it("has all required body regions for full-body overlay", () => {
    const required = [
      "LEFT_SHOULDER", "RIGHT_SHOULDER",
      "LEFT_HIP", "RIGHT_HIP",
      "LEFT_ANKLE", "RIGHT_ANKLE",
      "LEFT_HEEL", "RIGHT_HEEL",
      "LEFT_FOOT_INDEX", "RIGHT_FOOT_INDEX",
    ];
    for (const key of required) {
      expect(POSE_LANDMARKS).toHaveProperty(key);
    }
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/__tests__/pose-types.test.ts`
Expected: FAIL — module not found

**Step 4: Implement the types file** (code from Step 1)

**Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- --run src/__tests__/pose-types.test.ts`
Expected: PASS

**Step 6: Create the pose detection hook**

Create `frontend/src/hooks/usePoseDetection.ts`:

```typescript
import { useEffect, useRef, useCallback, useState } from "react";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { PoseResult } from "@/types/pose";

interface UsePoseDetectionOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isVideoReady: boolean;
  onPoseUpdate: (result: PoseResult) => void;
}

export function usePoseDetection({
  videoRef,
  isVideoReady,
  onPoseUpdate,
}: UsePoseDetectionOptions) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameRef = useRef<number>(0);
  const onPoseUpdateRef = useRef(onPoseUpdate);
  onPoseUpdateRef.current = onPoseUpdate;

  useEffect(() => {
    let cancelled = false;

    async function initPoseLandmarker() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });

        if (cancelled) {
          poseLandmarker.close();
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;
        setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load pose model"
          );
          setIsLoading(false);
        }
      }
    }

    initPoseLandmarker();

    return () => {
      cancelled = true;
      poseLandmarkerRef.current?.close();
      poseLandmarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isVideoReady || isLoading || !poseLandmarkerRef.current) return;

    const video = videoRef.current;
    if (!video) return;

    let lastTimestamp = -1;

    function detectPose() {
      const pl = poseLandmarkerRef.current;
      if (!pl || !video || video.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(detectPose);
        return;
      }

      const now = performance.now();
      if (now === lastTimestamp) {
        animFrameRef.current = requestAnimationFrame(detectPose);
        return;
      }
      lastTimestamp = now;

      try {
        const result = pl.detectForVideo(video, now);
        if (result.landmarks && result.landmarks.length > 0) {
          onPoseUpdateRef.current({
            landmarks: result.landmarks[0].map((lm) => ({
              x: lm.x,
              y: lm.y,
              z: lm.z,
              visibility: lm.visibility ?? 0,
            })),
            timestamp: now,
          });
        }
      } catch {
        // Skip frame on error
      }

      animFrameRef.current = requestAnimationFrame(detectPose);
    }

    animFrameRef.current = requestAnimationFrame(detectPose);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [isVideoReady, isLoading, videoRef]);

  return { isLoading, error };
}
```

**Step 7: Commit**

```bash
git add frontend/src/hooks/usePoseDetection.ts frontend/src/types/pose.ts frontend/src/__tests__/pose-types.test.ts
git commit -m "feat: add BlazePose pose detection hook (heavy mode, 30fps)"
```

---

### Task 2: Clothing Overlay Canvas with Affine Transforms

**Files:**
- Create: `frontend/src/lib/pose-overlay.ts`
- Create: `frontend/src/components/mirror/ClothingOverlay.tsx`
- Create: `frontend/src/types/outfit.ts`
- Test: `frontend/src/__tests__/pose-overlay.test.ts`

**Step 1: Create outfit types**

Create `frontend/src/types/outfit.ts`:

```typescript
export type ClothingCategory = "tops" | "bottoms" | "shoes" | "outerwear" | "accessories" | "dresses";

export interface OutfitItem {
  id: string;
  name: string;
  brand: string;
  price: number;
  image_url: string; // transparent PNG URL (bg removed)
  buy_url: string;
  category: ClothingCategory;
}

export interface OutfitRecommendation {
  recommendation_id: string;
  items: OutfitItem[];
  explanation: string;
}
```

**Step 2: Write the failing test for pose-overlay**

Create `frontend/src/__tests__/pose-overlay.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  getLandmarkPixelCoords,
  computeAffineTransform,
  getCategoryLandmarks,
} from "@/lib/pose-overlay";
import type { PoseLandmark } from "@/types/pose";

function makeLandmark(x: number, y: number, vis = 0.9): PoseLandmark {
  return { x, y, z: 0, visibility: vis };
}

describe("getLandmarkPixelCoords", () => {
  it("converts normalized coords to pixel coords", () => {
    const landmark = makeLandmark(0.5, 0.5);
    const result = getLandmarkPixelCoords(landmark, 1920, 1080);
    expect(result).toEqual({ x: 960, y: 540 });
  });

  it("handles edge coordinates", () => {
    const landmark = makeLandmark(0, 0);
    const result = getLandmarkPixelCoords(landmark, 1920, 1080);
    expect(result).toEqual({ x: 0, y: 0 });
  });
});

describe("getCategoryLandmarks", () => {
  it("returns shoulder and hip indices for tops", () => {
    const result = getCategoryLandmarks("tops");
    expect(result).toEqual({
      topLeft: 11,
      topRight: 12,
      bottomLeft: 23,
      bottomRight: 24,
    });
  });

  it("returns hip and ankle indices for bottoms", () => {
    const result = getCategoryLandmarks("bottoms");
    expect(result).toEqual({
      topLeft: 23,
      topRight: 24,
      bottomLeft: 27,
      bottomRight: 28,
    });
  });

  it("returns ankle and foot indices for shoes", () => {
    const result = getCategoryLandmarks("shoes");
    expect(result).toEqual({
      topLeft: 27,
      topRight: 28,
      bottomLeft: 31,
      bottomRight: 32,
    });
  });
});

describe("computeAffineTransform", () => {
  it("computes position, size, and rotation for a rectangular region", () => {
    const landmarks: PoseLandmark[] = Array(33).fill(makeLandmark(0, 0));
    // Shoulders at (0.3, 0.3) and (0.7, 0.3), hips at (0.3, 0.6) and (0.7, 0.6)
    landmarks[11] = makeLandmark(0.3, 0.3);
    landmarks[12] = makeLandmark(0.7, 0.3);
    landmarks[23] = makeLandmark(0.3, 0.6);
    landmarks[24] = makeLandmark(0.7, 0.6);

    const result = computeAffineTransform(landmarks, "tops", 1920, 1080);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(960, 0); // center x
    expect(result!.y).toBeCloseTo(486, 0); // center y
    expect(result!.width).toBeGreaterThan(0);
    expect(result!.height).toBeGreaterThan(0);
  });

  it("returns null when landmarks have low visibility", () => {
    const landmarks: PoseLandmark[] = Array(33).fill(makeLandmark(0, 0, 0.1));
    const result = computeAffineTransform(landmarks, "tops", 1920, 1080);
    expect(result).toBeNull();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/__tests__/pose-overlay.test.ts`
Expected: FAIL — module not found

**Step 4: Implement pose-overlay.ts**

Create `frontend/src/lib/pose-overlay.ts`:

```typescript
import type { PoseLandmark } from "@/types/pose";
import { POSE_LANDMARKS } from "@/types/pose";
import type { ClothingCategory } from "@/types/outfit";

export interface PixelCoord {
  x: number;
  y: number;
}

export interface AffineTransform {
  x: number;      // center x in pixels
  y: number;      // center y in pixels
  width: number;  // width in pixels
  height: number; // height in pixels
  rotation: number; // radians
}

interface CategoryLandmarkIndices {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

const MIN_VISIBILITY = 0.5;
const PADDING_FACTOR = 1.15; // 15% padding around clothing

export function getLandmarkPixelCoords(
  landmark: PoseLandmark,
  canvasWidth: number,
  canvasHeight: number
): PixelCoord {
  return {
    x: landmark.x * canvasWidth,
    y: landmark.y * canvasHeight,
  };
}

export function getCategoryLandmarks(category: ClothingCategory): CategoryLandmarkIndices {
  switch (category) {
    case "tops":
    case "outerwear":
      return {
        topLeft: POSE_LANDMARKS.LEFT_SHOULDER,
        topRight: POSE_LANDMARKS.RIGHT_SHOULDER,
        bottomLeft: POSE_LANDMARKS.LEFT_HIP,
        bottomRight: POSE_LANDMARKS.RIGHT_HIP,
      };
    case "bottoms":
      return {
        topLeft: POSE_LANDMARKS.LEFT_HIP,
        topRight: POSE_LANDMARKS.RIGHT_HIP,
        bottomLeft: POSE_LANDMARKS.LEFT_ANKLE,
        bottomRight: POSE_LANDMARKS.RIGHT_ANKLE,
      };
    case "shoes":
      return {
        topLeft: POSE_LANDMARKS.LEFT_ANKLE,
        topRight: POSE_LANDMARKS.RIGHT_ANKLE,
        bottomLeft: POSE_LANDMARKS.LEFT_FOOT_INDEX,
        bottomRight: POSE_LANDMARKS.RIGHT_FOOT_INDEX,
      };
    case "dresses":
      return {
        topLeft: POSE_LANDMARKS.LEFT_SHOULDER,
        topRight: POSE_LANDMARKS.RIGHT_SHOULDER,
        bottomLeft: POSE_LANDMARKS.LEFT_KNEE,
        bottomRight: POSE_LANDMARKS.RIGHT_KNEE,
      };
    case "accessories":
    default:
      return {
        topLeft: POSE_LANDMARKS.LEFT_SHOULDER,
        topRight: POSE_LANDMARKS.RIGHT_SHOULDER,
        bottomLeft: POSE_LANDMARKS.LEFT_HIP,
        bottomRight: POSE_LANDMARKS.RIGHT_HIP,
      };
  }
}

export function computeAffineTransform(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number
): AffineTransform | null {
  const indices = getCategoryLandmarks(category);

  const tl = landmarks[indices.topLeft];
  const tr = landmarks[indices.topRight];
  const bl = landmarks[indices.bottomLeft];
  const br = landmarks[indices.bottomRight];

  // Check visibility
  if (
    tl.visibility < MIN_VISIBILITY ||
    tr.visibility < MIN_VISIBILITY ||
    bl.visibility < MIN_VISIBILITY ||
    br.visibility < MIN_VISIBILITY
  ) {
    return null;
  }

  const tlPx = getLandmarkPixelCoords(tl, canvasWidth, canvasHeight);
  const trPx = getLandmarkPixelCoords(tr, canvasWidth, canvasHeight);
  const blPx = getLandmarkPixelCoords(bl, canvasWidth, canvasHeight);
  const brPx = getLandmarkPixelCoords(br, canvasWidth, canvasHeight);

  // Center
  const cx = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const cy = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Width = average of top and bottom edges
  const topWidth = Math.hypot(trPx.x - tlPx.x, trPx.y - tlPx.y);
  const bottomWidth = Math.hypot(brPx.x - blPx.x, brPx.y - blPx.y);
  const width = ((topWidth + bottomWidth) / 2) * PADDING_FACTOR;

  // Height = average of left and right edges
  const leftHeight = Math.hypot(blPx.x - tlPx.x, blPx.y - tlPx.y);
  const rightHeight = Math.hypot(brPx.x - trPx.x, brPx.y - trPx.y);
  const height = ((leftHeight + rightHeight) / 2) * PADDING_FACTOR;

  // Rotation from top edge
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return { x: cx, y: cy, width, height, rotation };
}
```

**Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- --run src/__tests__/pose-overlay.test.ts`
Expected: PASS

**Step 6: Create ClothingOverlay component**

Create `frontend/src/components/mirror/ClothingOverlay.tsx`:

```tsx
"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { PoseResult } from "@/types/pose";
import type { OutfitRecommendation } from "@/types/outfit";
import { computeAffineTransform } from "@/lib/pose-overlay";

interface ClothingOverlayProps {
  pose: PoseResult | null;
  outfit: OutfitRecommendation | null;
  width: number;
  height: number;
}

export function ClothingOverlay({ pose, outfit, width, height }: ClothingOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());

  // Preload clothing images when outfit changes
  useEffect(() => {
    if (!outfit) {
      imagesRef.current.clear();
      setLoadedImages(new Set());
      return;
    }

    const newImages = new Map<string, HTMLImageElement>();
    const loaded = new Set<string>();

    for (const item of outfit.items) {
      if (imagesRef.current.has(item.id)) {
        newImages.set(item.id, imagesRef.current.get(item.id)!);
        loaded.add(item.id);
        continue;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        loaded.add(item.id);
        setLoadedImages(new Set(loaded));
      };
      img.src = item.image_url;
      newImages.set(item.id, img);
    }

    imagesRef.current = newImages;
    setLoadedImages(loaded);
  }, [outfit]);

  // Render overlay on each pose update
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pose || !outfit) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    for (const item of outfit.items) {
      const img = imagesRef.current.get(item.id);
      if (!img || !loadedImages.has(item.id)) continue;

      const transform = computeAffineTransform(
        pose.landmarks,
        item.category,
        width,
        height
      );
      if (!transform) continue;

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.rotate(transform.rotation);
      ctx.drawImage(
        img,
        -transform.width / 2,
        -transform.height / 2,
        transform.width,
        transform.height
      );
      ctx.restore();
    }
  }, [pose, outfit, width, height, loadedImages]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 10,
      }}
    />
  );
}
```

**Step 7: Commit**

```bash
git add frontend/src/lib/pose-overlay.ts frontend/src/components/mirror/ClothingOverlay.tsx frontend/src/types/outfit.ts frontend/src/__tests__/pose-overlay.test.ts
git commit -m "feat: add clothing overlay with affine transform warping on pose landmarks"
```

---

### Task 3: Sparkle Transition Effect

**Files:**
- Create: `frontend/src/components/mirror/SparkleTransition.tsx`

**Step 1: Create the sparkle component**

Create `frontend/src/components/mirror/SparkleTransition.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";

interface SparkleTransitionProps {
  active: boolean;
  onComplete?: () => void;
}

const SPARKLE_COUNT = 20;
const DURATION_MS = 600;

interface Sparkle {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
}

function generateSparkles(): Sparkle[] {
  return Array.from({ length: SPARKLE_COUNT }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: 4 + Math.random() * 8,
    delay: Math.random() * 300,
  }));
}

export function SparkleTransition({ active, onComplete }: SparkleTransitionProps) {
  const [sparkles, setSparkles] = useState<Sparkle[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) return;

    setSparkles(generateSparkles());
    setVisible(true);

    const timer = setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, DURATION_MS);

    return () => clearTimeout(timer);
  }, [active, onComplete]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 15,
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes sparkle-pop {
          0% { transform: scale(0) rotate(0deg); opacity: 1; }
          50% { transform: scale(1) rotate(180deg); opacity: 1; }
          100% { transform: scale(0) rotate(360deg); opacity: 0; }
        }
      `}</style>
      {sparkles.map((s) => (
        <div
          key={s.id}
          style={{
            position: "absolute",
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.size,
            height: s.size,
            background: "radial-gradient(circle, #fff 0%, #aef 40%, transparent 70%)",
            borderRadius: "50%",
            boxShadow: "0 0 6px 2px rgba(174,239,255,0.6)",
            animation: `sparkle-pop ${DURATION_MS}ms ease-out ${s.delay}ms both`,
          }}
        />
      ))}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/mirror/SparkleTransition.tsx
git commit -m "feat: add CSS sparkle transition effect for outfit changes"
```

---

### Task 4: Mira Avatar Container (Glassmorphism + Collision-Aware Float)

**Files:**
- Create: `frontend/src/components/mirror/MiraAvatar.tsx`
- Test: `frontend/src/__tests__/avatar-position.test.ts`

**Step 1: Write the failing test for avatar positioning**

Create `frontend/src/__tests__/avatar-position.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findUnoccupiedPosition } from "@/components/mirror/MiraAvatar";

describe("findUnoccupiedPosition", () => {
  it("returns a corner position when no overlays exist", () => {
    const pos = findUnoccupiedPosition([], 1920, 1080, 250, 250);
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.x + 250).toBeLessThanOrEqual(1920);
    expect(pos.y + 250).toBeLessThanOrEqual(1080);
  });

  it("avoids occupied regions", () => {
    // Overlay in top-left quadrant
    const occupiedRegions = [{ x: 100, y: 100, width: 400, height: 400 }];
    const pos = findUnoccupiedPosition(occupiedRegions, 1920, 1080, 250, 250);
    // Should not overlap with occupied region
    const overlaps =
      pos.x < 500 && pos.x + 250 > 100 && pos.y < 500 && pos.y + 250 > 100;
    expect(overlaps).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/__tests__/avatar-position.test.ts`
Expected: FAIL

**Step 3: Create MiraAvatar component**

Create `frontend/src/components/mirror/MiraAvatar.tsx`:

```tsx
"use client";

import { useState, useEffect, useRef } from "react";

export interface OccupiedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MiraAvatarProps {
  occupiedRegions: OccupiedRegion[];
  screenWidth: number;
  screenHeight: number;
  avatarSize?: number;
  children?: React.ReactNode; // HeyGen video stream goes here
}

const AVATAR_SIZE = 250;
const REPOSITION_INTERVAL_MS = 3000;
const TRANSITION_MS = 1500;

// Candidate positions: corners and edge midpoints
function getCandidatePositions(
  sw: number,
  sh: number,
  aw: number,
  ah: number
) {
  const margin = 30;
  return [
    { x: sw - aw - margin, y: sh - ah - margin }, // bottom-right
    { x: margin, y: sh - ah - margin },             // bottom-left
    { x: sw - aw - margin, y: margin },             // top-right
    { x: margin, y: margin },                        // top-left
    { x: sw - aw - margin, y: (sh - ah) / 2 },     // middle-right
    { x: margin, y: (sh - ah) / 2 },                // middle-left
    { x: (sw - aw) / 2, y: margin },                // top-center
    { x: (sw - aw) / 2, y: sh - ah - margin },     // bottom-center
  ];
}

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function findUnoccupiedPosition(
  occupied: OccupiedRegion[],
  screenWidth: number,
  screenHeight: number,
  avatarWidth: number,
  avatarHeight: number
): { x: number; y: number } {
  const candidates = getCandidatePositions(
    screenWidth, screenHeight, avatarWidth, avatarHeight
  );

  for (const candidate of candidates) {
    const hasOverlap = occupied.some((r) =>
      rectsOverlap(
        candidate.x, candidate.y, avatarWidth, avatarHeight,
        r.x, r.y, r.width, r.height
      )
    );
    if (!hasOverlap) return candidate;
  }

  // Fallback: bottom-right corner
  return candidates[0];
}

export function MiraAvatar({
  occupiedRegions,
  screenWidth,
  screenHeight,
  avatarSize = AVATAR_SIZE,
  children,
}: MiraAvatarProps) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const initialized = useRef(false);

  // Initial position
  useEffect(() => {
    if (!initialized.current && screenWidth > 0) {
      const pos = findUnoccupiedPosition(
        occupiedRegions, screenWidth, screenHeight, avatarSize, avatarSize
      );
      setPosition(pos);
      initialized.current = true;
    }
  }, [screenWidth, screenHeight, avatarSize, occupiedRegions]);

  // Reposition periodically when overlays change
  useEffect(() => {
    const interval = setInterval(() => {
      const pos = findUnoccupiedPosition(
        occupiedRegions, screenWidth, screenHeight, avatarSize, avatarSize
      );
      setPosition(pos);
    }, REPOSITION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [occupiedRegions, screenWidth, screenHeight, avatarSize]);

  return (
    <div
      style={{
        position: "absolute",
        left: position.x,
        top: position.y,
        width: avatarSize,
        height: avatarSize,
        borderRadius: "50%",
        overflow: "hidden",
        // Glassmorphism
        background: "rgba(255, 255, 255, 0.08)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.15)",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3), inset 0 0 20px rgba(255,255,255,0.05)",
        transition: `left ${TRANSITION_MS}ms ease-in-out, top ${TRANSITION_MS}ms ease-in-out`,
        zIndex: 25,
        pointerEvents: "none",
      }}
    >
      {children || (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.4)",
            fontSize: "0.8rem",
          }}
        >
          Mira
        </div>
      )}
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --run src/__tests__/avatar-position.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/src/components/mirror/MiraAvatar.tsx frontend/src/__tests__/avatar-position.test.ts
git commit -m "feat: add Mira avatar with glassmorphism styling and collision-aware floating"
```

---

### Task 5: Outfit Info Panel (Shown on Thumbs-Up)

**Files:**
- Create: `frontend/src/components/mirror/OutfitInfoPanel.tsx`

**Step 1: Create the info panel component**

Create `frontend/src/components/mirror/OutfitInfoPanel.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import type { OutfitRecommendation } from "@/types/outfit";

interface OutfitInfoPanelProps {
  outfit: OutfitRecommendation | null;
  visible: boolean;
}

const DISPLAY_DURATION_MS = 5000;

export function OutfitInfoPanel({ outfit, visible }: OutfitInfoPanelProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!visible) {
      setShow(false);
      return;
    }
    setShow(true);
    const timer = setTimeout(() => setShow(false), DISPLAY_DURATION_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!show || !outfit) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        right: 40,
        maxWidth: 350,
        padding: "20px 24px",
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(10px)",
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#fff",
        zIndex: 30,
        animation: "fadeIn 300ms ease-out",
      }}
    >
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {outfit.items.map((item) => (
        <div key={item.id} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: "1rem", fontWeight: 600 }}>{item.name}</div>
          <div style={{ fontSize: "0.85rem", color: "rgba(255,255,255,0.6)" }}>
            {item.brand} &middot; ${item.price.toFixed(2)}
          </div>
        </div>
      ))}
      {outfit.explanation && (
        <div
          style={{
            fontSize: "0.8rem",
            color: "rgba(255,255,255,0.5)",
            marginTop: 8,
            fontStyle: "italic",
          }}
        >
          {outfit.explanation}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/mirror/OutfitInfoPanel.tsx
git commit -m "feat: add outfit info panel (visible on thumbs-up gesture)"
```

---

### Task 6: Idle Screen with QR Code

**Files:**
- Create: `frontend/src/components/mirror/IdleScreen.tsx`

**Step 1: Create the idle screen component**

Create `frontend/src/components/mirror/IdleScreen.tsx`:

```tsx
"use client";

interface IdleScreenProps {
  qrUrl: string;
}

export function IdleScreen({ qrUrl }: IdleScreenProps) {
  // Use Google Charts QR API (no npm dependency)
  const qrImageUrl = `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=${encodeURIComponent(qrUrl)}&choe=UTF-8`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        zIndex: 50,
      }}
    >
      <img
        src={qrImageUrl}
        alt="Scan to start"
        width={300}
        height={300}
        style={{
          borderRadius: 16,
          border: "2px solid rgba(255,255,255,0.1)",
        }}
      />
      <div
        style={{
          marginTop: 24,
          color: "rgba(255,255,255,0.5)",
          fontSize: "1.2rem",
          fontWeight: 300,
          letterSpacing: "0.05em",
        }}
      >
        Scan to start your style session
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/mirror/IdleScreen.tsx
git commit -m "feat: add idle screen with QR code for onboarding"
```

---

### Task 7: Camera Snapshot Handler

**Files:**
- Create: `frontend/src/lib/camera-snapshot.ts`
- Test: `frontend/src/__tests__/camera-snapshot.test.ts`

**Step 1: Write the failing test**

Create `frontend/src/__tests__/camera-snapshot.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compressSnapshot } from "@/lib/camera-snapshot";

describe("compressSnapshot", () => {
  it("returns a base64 JPEG string from canvas data", () => {
    // Create a small test canvas
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 4, 4);

    const result = compressSnapshot(canvas, 0.6);
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/__tests__/camera-snapshot.test.ts`
Expected: FAIL

**Step 3: Implement camera-snapshot.ts**

Create `frontend/src/lib/camera-snapshot.ts`:

```typescript
/**
 * Capture a JPEG snapshot from a video element or canvas.
 */
export function compressSnapshot(
  source: HTMLCanvasElement | HTMLVideoElement,
  quality: number = 0.7
): string {
  let canvas: HTMLCanvasElement;

  if (source instanceof HTMLVideoElement) {
    canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
  } else {
    canvas = source;
  }

  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Capture snapshot from a video element, stripping the data URL prefix.
 * Returns raw base64 string suitable for sending to backend.
 */
export function captureBase64Snapshot(
  video: HTMLVideoElement,
  quality: number = 0.7
): string {
  const dataUrl = compressSnapshot(video, quality);
  return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --run src/__tests__/camera-snapshot.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/src/lib/camera-snapshot.ts frontend/src/__tests__/camera-snapshot.test.ts
git commit -m "feat: add camera snapshot capture and JPEG compression utility"
```

---

### Task 8: Backend — Background Removal Endpoint (rembg)

**Files:**
- Modify: `backend/requirements.txt` — add `rembg`
- Create: `backend/services/image_processing.py`
- Create: `backend/routers/images.py`
- Modify: `backend/main.py` — register images router
- Test: `backend/tests/test_image_processing.py`

**Step 1: Add rembg to requirements**

Add to `backend/requirements.txt`:
```
rembg==2.0.57
Pillow==11.0.0
```

**Step 2: Install dependencies**

Run: `cd backend && pip install rembg==2.0.57 Pillow==11.0.0`

**Step 3: Write the failing test**

Create `backend/tests/test_image_processing.py`:

```python
"""Tests for image background removal service."""
import pytest
from services.image_processing import remove_background_from_url


def test_remove_background_returns_bytes():
    """Test that remove_background returns PNG bytes from a small test image."""
    # Use a small public domain image
    test_url = "https://via.placeholder.com/100x100/ff0000/ffffff.png"
    result = remove_background_from_url(test_url)
    assert isinstance(result, bytes)
    # PNG magic bytes
    assert result[:4] == b"\x89PNG"


def test_remove_background_invalid_url():
    """Test that invalid URL raises an error."""
    with pytest.raises(Exception):
        remove_background_from_url("https://invalid.example.com/nonexistent.png")
```

**Step 4: Run test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_image_processing.py -v`
Expected: FAIL — module not found

**Step 5: Implement image processing service**

Create `backend/services/image_processing.py`:

```python
"""Background removal service using rembg."""

import io

import httpx
from PIL import Image
from rembg import remove


def remove_background_from_url(image_url: str) -> bytes:
    """Download image from URL and remove its background.

    Returns PNG bytes with transparent background.
    """
    response = httpx.get(image_url, timeout=30)
    response.raise_for_status()

    input_image = Image.open(io.BytesIO(response.content))
    output_image = remove(input_image)

    output_buffer = io.BytesIO()
    output_image.save(output_buffer, format="PNG")
    return output_buffer.getvalue()
```

**Step 6: Run test to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_image_processing.py -v`
Expected: PASS (may be slow first run — rembg downloads model)

**Step 7: Create the images router**

Create `backend/routers/images.py`:

```python
"""Image processing endpoints."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from services.image_processing import remove_background_from_url

router = APIRouter(prefix="/api/images", tags=["images"])


class RemoveBackgroundRequest(BaseModel):
    image_url: str


@router.post("/remove-background")
async def remove_background(req: RemoveBackgroundRequest):
    """Remove background from a clothing image URL. Returns transparent PNG."""
    try:
        png_bytes = remove_background_from_url(req.image_url)
        return Response(content=png_bytes, media_type="image/png")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Background removal failed: {e}")
```

**Step 8: Register router in main.py**

Add to `backend/main.py` after the existing router imports:

```python
from routers.images import router as images_router
```

And after the existing `app.include_router` lines:

```python
app.include_router(images_router)
```

**Step 9: Commit**

```bash
git add backend/requirements.txt backend/services/image_processing.py backend/routers/images.py backend/main.py backend/tests/test_image_processing.py
git commit -m "feat: add rembg background removal endpoint for clothing images"
```

---

### Task 9: Socket.io Mirror Event Handlers

**Files:**
- Modify: `backend/main.py` — add mirror-specific Socket.io handlers

**Step 1: Add Socket.io handlers for mirror events**

Add to `backend/main.py` after the existing `disconnect` handler:

```python
@sio.event
async def request_snapshot(sid, data):
    """Backend requests a camera snapshot from the mirror."""
    user_id = data.get("user_id")
    if user_id:
        await sio.emit("request_snapshot", {"user_id": user_id}, room=user_id)
        print(f"[socket] Requested snapshot from mirror for user {user_id}")


@sio.event
async def camera_snapshot(sid, data):
    """Mirror sends back a camera snapshot."""
    user_id = data.get("user_id")
    image_base64 = data.get("image_base64")
    print(f"[socket] Received snapshot from {user_id}: {len(image_base64) if image_base64 else 0} bytes")
    # Store in memory for agent to consume (will be used by orchestrator)


@sio.event
async def session_ready(sid, data):
    """Mirror display reports it's loaded and ready."""
    user_id = data.get("user_id")
    if user_id:
        await sio.enter_room(sid, f"mirror_{user_id}")
        print(f"[socket] Mirror ready for user {user_id}")
```

**Step 2: Commit**

```bash
git add backend/main.py
git commit -m "feat: add Socket.io handlers for mirror snapshot requests and session ready"
```

---

### Task 10: Integrate Everything into Mirror Page

**Files:**
- Modify: `frontend/src/app/mirror/page.tsx` — full rewrite integrating all components

**Step 1: Rewrite the mirror page**

Replace `frontend/src/app/mirror/page.tsx` with:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCamera } from "@/hooks/useCamera";
import { useGestureRecognizer } from "@/hooks/useGestureRecognizer";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { GestureIndicator } from "@/components/mirror/GestureIndicator";
import { ClothingOverlay } from "@/components/mirror/ClothingOverlay";
import { MiraAvatar, type OccupiedRegion } from "@/components/mirror/MiraAvatar";
import { SparkleTransition } from "@/components/mirror/SparkleTransition";
import { OutfitInfoPanel } from "@/components/mirror/OutfitInfoPanel";
import { IdleScreen } from "@/components/mirror/IdleScreen";
import { captureBase64Snapshot } from "@/lib/camera-snapshot";
import { computeAffineTransform } from "@/lib/pose-overlay";
import { socket } from "@/lib/socket";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { PoseResult } from "@/types/pose";
import type { OutfitRecommendation } from "@/types/outfit";

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;
const PHONE_URL = process.env.NEXT_PUBLIC_PHONE_URL || "http://localhost:3000/phone";

export default function MirrorPage() {
  const { videoRef, isReady: isCameraReady, error: cameraError } = useCamera();

  // Gesture state
  const [lastGesture, setLastGesture] = useState<GestureType | null>(null);
  const gestureKeyRef = useRef(0);
  const [gestureKey, setGestureKey] = useState(0);

  // Pose state
  const [currentPose, setCurrentPose] = useState<PoseResult | null>(null);

  // Outfit state
  const [currentOutfit, setCurrentOutfit] = useState<OutfitRecommendation | null>(null);
  const [showSparkle, setShowSparkle] = useState(false);
  const [sparkleKey, setSparkleKey] = useState(0);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [infoPanelKey, setInfoPanelKey] = useState(0);

  // Session state
  const [sessionActive, setSessionActive] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // Occupied regions for avatar collision avoidance
  const [occupiedRegions, setOccupiedRegions] = useState<OccupiedRegion[]>([]);

  // Connect socket on mount
  useEffect(() => {
    socket.connect();

    socket.on("outfit_recommendation", (data: OutfitRecommendation) => {
      setSparkleKey((k) => k + 1);
      setShowSparkle(true);
      setTimeout(() => {
        setCurrentOutfit(data);
        setShowSparkle(false);
      }, 400);
    });

    socket.on("session_status", (data: { status: string; user_id: string }) => {
      if (data.status === "active") {
        setSessionActive(true);
        setUserId(data.user_id);
        socket.emit("join_room", { user_id: data.user_id });
        socket.emit("session_ready", { user_id: data.user_id });
      } else if (data.status === "completed" || data.status === "ended") {
        setSessionActive(false);
        setCurrentOutfit(null);
        setCurrentPose(null);
        setUserId(null);
      }
    });

    socket.on("request_snapshot", () => {
      if (videoRef.current) {
        const base64 = captureBase64Snapshot(videoRef.current, 0.7);
        socket.emit("camera_snapshot", {
          user_id: userId,
          image_base64: base64,
          timestamp: performance.now(),
        });
      }
    });

    socket.on("show_outfit_info", () => {
      setInfoPanelKey((k) => k + 1);
      setShowInfoPanel(true);
    });

    return () => {
      socket.off("outfit_recommendation");
      socket.off("session_status");
      socket.off("request_snapshot");
      socket.off("show_outfit_info");
      socket.disconnect();
    };
  }, [userId, videoRef]);

  // Gesture handler
  const handleGesture = useCallback(
    (gesture: DetectedGesture) => {
      console.log("[Mirror] Gesture:", gesture.type, gesture.confidence);

      setLastGesture(gesture.type);
      gestureKeyRef.current += 1;
      setGestureKey(gestureKeyRef.current);

      socket.emit("gesture_detected", {
        type: gesture.type,
        confidence: gesture.confidence,
        timestamp: gesture.timestamp,
      });

      // Show info panel on thumbs up
      if (gesture.type === "thumbs_up") {
        setInfoPanelKey((k) => k + 1);
        setShowInfoPanel(true);
      }
    },
    []
  );

  // Pose handler — update overlay positions
  const handlePoseUpdate = useCallback((result: PoseResult) => {
    setCurrentPose(result);

    // Update occupied regions for avatar collision avoidance
    if (currentOutfit) {
      const regions: OccupiedRegion[] = [];
      for (const item of currentOutfit.items) {
        const transform = computeAffineTransform(
          result.landmarks,
          item.category,
          SCREEN_WIDTH,
          SCREEN_HEIGHT
        );
        if (transform) {
          regions.push({
            x: transform.x - transform.width / 2,
            y: transform.y - transform.height / 2,
            width: transform.width,
            height: transform.height,
          });
        }
      }
      setOccupiedRegions(regions);
    }
  }, [currentOutfit]);

  const { isLoading: isModelLoading, error: modelError } =
    useGestureRecognizer({
      videoRef,
      isVideoReady: isCameraReady,
      onGesture: handleGesture,
    });

  const { isLoading: isPoseLoading, error: poseError } = usePoseDetection({
    videoRef,
    isVideoReady: isCameraReady,
    onPoseUpdate: handlePoseUpdate,
  });

  // Show idle screen when no session
  if (!sessionActive) {
    return (
      <main style={{ width: "100vw", height: "100vh", background: "#000" }}>
        <IdleScreen qrUrl={PHONE_URL} />
      </main>
    );
  }

  return (
    <main
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        background: "#000",
        overflow: "hidden",
      }}
    >
      {/* Hidden video element for pose/gesture detection */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      {/* Clothing overlay canvas */}
      <ClothingOverlay
        pose={currentPose}
        outfit={currentOutfit}
        width={SCREEN_WIDTH}
        height={SCREEN_HEIGHT}
      />

      {/* Sparkle transition */}
      <SparkleTransition key={sparkleKey} active={showSparkle} />

      {/* Mira avatar */}
      <MiraAvatar
        occupiedRegions={occupiedRegions}
        screenWidth={SCREEN_WIDTH}
        screenHeight={SCREEN_HEIGHT}
      />

      {/* Gesture feedback */}
      <GestureIndicator key={gestureKey} gesture={lastGesture} />

      {/* Outfit info panel */}
      <OutfitInfoPanel
        key={infoPanelKey}
        outfit={currentOutfit}
        visible={showInfoPanel}
      />

      {/* Status indicators */}
      {(cameraError || modelError || poseError) && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
            color: "#f44",
            fontSize: "1rem",
            zIndex: 30,
          }}
        >
          {cameraError && <div>Camera: {cameraError}</div>}
          {modelError && <div>Gesture Model: {modelError}</div>}
          {poseError && <div>Pose Model: {poseError}</div>}
        </div>
      )}

      {(isModelLoading || isPoseLoading) && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#fff",
            fontSize: "1.5rem",
            zIndex: 30,
          }}
        >
          Loading models...
        </div>
      )}
    </main>
  );
}
```

**Step 2: Run the build to verify no type errors**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add frontend/src/app/mirror/page.tsx
git commit -m "feat: integrate mirror display — black bg, pose tracking, overlay, avatar, idle QR"
```

---

### Task 11: Run All Tests and Final Verification

**Step 1: Run frontend tests**

Run: `cd frontend && npm test`
Expected: All tests pass

**Step 2: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no type errors

**Step 3: Run backend tests**

Run: `cd backend && python3 -m pytest tests/ -v`
Expected: All tests pass (including new image processing test)

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve test and build issues"
```
