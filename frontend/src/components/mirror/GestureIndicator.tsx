"use client";

import { useState, useEffect } from "react";
import type { GestureType } from "@/types/gestures";

const GESTURE_DISPLAY: Record<
  GestureType,
  { icon: string; label: string; pendingLabel: string }
> = {
  swipe_left: { icon: "\u2190", label: "Previous", pendingLabel: "" },
  swipe_right: { icon: "\u2192", label: "Next", pendingLabel: "" },
  thumbs_up: { icon: "\uD83D\uDC4D", label: "Liked!", pendingLabel: "Hold to like" },
  thumbs_down: { icon: "\uD83D\uDC4E", label: "Skipped", pendingLabel: "Hold to skip" },
};

const CONFIRMED_DISPLAY_MS = 1500;
const RING_SIZE = 120;
const STROKE_WIDTH = 6;
const HOLD_DURATION_S = 2; // must match HOLD_DURATION_MS in page.tsx
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface GestureIndicatorProps {
  gesture: GestureType | null;
  gestureKey?: number;
  pendingGesture?: GestureType | null;
  holdKey?: number;
  /** @deprecated use holdKey + CSS animation instead */
  holdProgress?: number;
}

export function GestureIndicator({
  gesture,
  gestureKey = 0,
  pendingGesture = null,
  holdKey = 0,
}: GestureIndicatorProps) {
  const [confirmedGesture, setConfirmedGesture] = useState<GestureType | null>(null);
  const [confirmedVisible, setConfirmedVisible] = useState(false);

  // Show confirmed display when gestureKey changes (gesture dispatched)
  useEffect(() => {
    if (!gesture || gestureKey === 0) return;

    setConfirmedGesture(gesture);
    setConfirmedVisible(true);

    const timer = setTimeout(() => setConfirmedVisible(false), CONFIRMED_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [gestureKey, gesture]);

  // ── Pending hold state (CSS-animated ring filling) ──
  if (pendingGesture) {
    const display = GESTURE_DISPLAY[pendingGesture];

    return (
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          pointerEvents: "none",
          zIndex: 20,
        }}
      >
        <div style={{ position: "relative", width: RING_SIZE, height: RING_SIZE }}>
          <svg
            width={RING_SIZE}
            height={RING_SIZE}
            style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)" }}
          >
            {/* Background ring */}
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth={STROKE_WIDTH}
            />
            {/* Progress ring — CSS keyframe drives the fill */}
            <circle
              key={holdKey}
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="#fff"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE}
              style={{
                animation: `gestureRingFill ${HOLD_DURATION_S}s linear forwards`,
              }}
            />
          </svg>
          {/* Icon centered inside ring */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "3rem",
            }}
          >
            {display.icon}
          </div>
        </div>
        <div
          style={{
            color: "rgba(255,255,255,0.7)",
            fontSize: "1rem",
            marginTop: 12,
            textShadow: "0 0 10px rgba(0,0,0,0.8)",
          }}
        >
          {display.pendingLabel}
        </div>

        {/* Scoped keyframes for the ring animation */}
        <style>{`
          @keyframes gestureRingFill {
            from { stroke-dashoffset: ${CIRCUMFERENCE}; }
            to   { stroke-dashoffset: 0; }
          }
        `}</style>
      </div>
    );
  }

  // ── Confirmed state (gesture dispatched, show for 1.5s) ──
  if (!confirmedVisible || !confirmedGesture) return null;

  const display = GESTURE_DISPLAY[confirmedGesture];

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        fontSize: "4rem",
        color: "#fff",
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 20,
        textShadow: "0 0 20px rgba(0,0,0,0.8)",
      }}
    >
      <div style={{ fontSize: "6rem" }}>{display.icon}</div>
      <div style={{ fontSize: "1.5rem", marginTop: "0.5rem" }}>
        {display.label}
      </div>
    </div>
  );
}
