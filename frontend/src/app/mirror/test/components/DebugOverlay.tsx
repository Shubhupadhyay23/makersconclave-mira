"use client";

import { useRef, useEffect } from 'react';
import type { PoseResult } from '@/types/pose';
import { POSE_LANDMARKS } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { landmarkToPixel, calculateClothingTransform } from '../lib/clothing-transform';

interface DebugOverlayProps {
  pose: PoseResult | null;
  items: ClothingItem[];
  width: number;
  height: number;
  visible: boolean;
}

// Pose skeleton connections (based on BlazePose topology)
const SKELETON_CONNECTIONS = [
  // Arms
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_ELBOW],
  [POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.LEFT_WRIST],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_ELBOW],
  [POSE_LANDMARKS.RIGHT_ELBOW, POSE_LANDMARKS.RIGHT_WRIST],

  // Torso
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.RIGHT_SHOULDER],
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_HIP],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_HIP],
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP],

  // Legs
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.LEFT_KNEE],
  [POSE_LANDMARKS.LEFT_KNEE, POSE_LANDMARKS.LEFT_ANKLE],
  [POSE_LANDMARKS.RIGHT_HIP, POSE_LANDMARKS.RIGHT_KNEE],
  [POSE_LANDMARKS.RIGHT_KNEE, POSE_LANDMARKS.RIGHT_ANKLE],

  // Feet
  [POSE_LANDMARKS.LEFT_ANKLE, POSE_LANDMARKS.LEFT_HEEL],
  [POSE_LANDMARKS.LEFT_HEEL, POSE_LANDMARKS.LEFT_FOOT_INDEX],
  [POSE_LANDMARKS.RIGHT_ANKLE, POSE_LANDMARKS.RIGHT_HEEL],
  [POSE_LANDMARKS.RIGHT_HEEL, POSE_LANDMARKS.RIGHT_FOOT_INDEX],
];

// Anchor points for each category
const ANCHOR_POINTS = {
  tops: [
    POSE_LANDMARKS.LEFT_SHOULDER,
    POSE_LANDMARKS.RIGHT_SHOULDER,
    POSE_LANDMARKS.LEFT_ELBOW,
    POSE_LANDMARKS.RIGHT_ELBOW,
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.RIGHT_HIP,
  ],
  bottoms: [
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.RIGHT_HIP,
    POSE_LANDMARKS.LEFT_KNEE,
    POSE_LANDMARKS.RIGHT_KNEE,
    POSE_LANDMARKS.LEFT_ANKLE,
    POSE_LANDMARKS.RIGHT_ANKLE,
  ],
};

export function DebugOverlay({ pose, items, width, height, visible }: DebugOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible || !pose) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    const { landmarks } = pose;

    // 1. Draw skeleton connections (cyan lines)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
    ctx.lineWidth = 2;

    for (const [startIdx, endIdx] of SKELETON_CONNECTIONS) {
      const start = landmarks[startIdx];
      const end = landmarks[endIdx];

      if (!start || !end) continue;
      if (start.visibility < 0.5 || end.visibility < 0.5) continue;

      const startPx = landmarkToPixel(start, width, height);
      const endPx = landmarkToPixel(end, width, height);

      ctx.beginPath();
      ctx.moveTo(startPx.x, startPx.y);
      ctx.lineTo(endPx.x, endPx.y);
      ctx.stroke();
    }

    // 2. Draw all pose landmarks (cyan dots)
    ctx.fillStyle = 'cyan';

    for (const landmark of landmarks) {
      if (landmark.visibility < 0.5) continue;

      const px = landmarkToPixel(landmark, width, height);

      ctx.beginPath();
      ctx.arc(px.x, px.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Draw anchor points for active clothing items
    for (const item of items) {
      const anchorIndices = ANCHOR_POINTS[item.category];
      const color = item.category === 'tops' ? 'red' : 'lime';

      ctx.fillStyle = color;

      for (const idx of anchorIndices) {
        const landmark = landmarks[idx];
        if (!landmark || landmark.visibility < 0.5) continue;

        const px = landmarkToPixel(landmark, width, height);

        ctx.beginPath();
        ctx.arc(px.x, px.y, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 4. Draw bounding boxes for clothing items
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 3;

    for (const item of items) {
      const transform = calculateClothingTransform(
        landmarks,
        item.category,
        width,
        height
      );

      if (!transform) continue;

      ctx.save();
      ctx.translate(transform.centerX, transform.centerY);
      ctx.rotate(transform.rotation);

      ctx.strokeRect(
        -transform.width / 2,
        -transform.height / 2,
        transform.width,
        transform.height
      );

      ctx.restore();
    }
  }, [pose, items, width, height, visible]);

  if (!visible) return null;

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    />
  );
}
