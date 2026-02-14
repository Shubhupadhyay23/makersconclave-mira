"use client";

import { useState, useEffect } from "react";
import type { GestureType } from "@/types/gestures";

const GESTURE_DISPLAY: Record<GestureType, { icon: string; label: string }> = {
  swipe_left: { icon: "\u2190", label: "Previous" },
  swipe_right: { icon: "\u2192", label: "Next" },
  thumbs_up: { icon: "\uD83D\uDC4D", label: "Liked!" },
  thumbs_down: { icon: "\uD83D\uDC4E", label: "Skipped" },
};

const DISPLAY_DURATION_MS = 1500;

interface GestureIndicatorProps {
  gesture: GestureType | null;
}

export function GestureIndicator({ gesture }: GestureIndicatorProps) {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<GestureType | null>(null);

  useEffect(() => {
    if (!gesture) return;

    setCurrent(gesture);
    setVisible(true);

    const timer = setTimeout(() => setVisible(false), DISPLAY_DURATION_MS);
    return () => clearTimeout(timer);
  }, [gesture]);

  if (!visible || !current) return null;

  const display = GESTURE_DISPLAY[current];

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
