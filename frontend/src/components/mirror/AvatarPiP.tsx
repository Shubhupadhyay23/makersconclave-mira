"use client";

import type { RefObject } from "react";

interface AvatarPiPProps {
  containerRef: RefObject<HTMLDivElement | null>;
  isReady: boolean;
  visible: boolean;
}

export default function AvatarPiP({ containerRef, isReady, visible }: AvatarPiPProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        right: 20,
        width: "15vw",
        minWidth: 160,
        maxWidth: 240,
        aspectRatio: "1",
        borderRadius: 16,
        overflow: "hidden",
        zIndex: 10,
        border: "2px solid rgba(255, 255, 255, 0.3)",
        boxShadow: "0 0 20px rgba(100, 140, 255, 0.3)",
        background: "#111",
        display: visible ? "block" : "none",
      }}
    >
      {/* MemojiAvatar injects its <video> elements into this div */}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: isReady ? "block" : "none",
        }}
      />
      {!isReady && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "rgba(255, 255, 255, 0.5)",
            fontSize: "0.85rem",
          }}
        >
          Loading avatar...
        </div>
      )}
    </div>
  );
}
