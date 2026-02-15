"use client";

import { useState } from "react";
import { MiraVideoAvatar, type MiraEmotion, type MiraAvatarState } from "@/components/ui/mira-video-avatar";

const EMOTIONS: MiraEmotion[] = [
  "idle",
  "thinking",
  "talking",
  "happy",
  "excited",
  "concerned",
  "sassy",
  "disappointed",
  "surprised",
  "proud",
  "flirty",
  "judgy",
  "sympathetic",
];

export default function MiraDemoPage() {
  const [emotion, setEmotion] = useState<MiraEmotion>("idle");
  const [avatarState, setAvatarState] = useState<MiraAvatarState>("idle");
  const [size, setSize] = useState(300);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#111",
        color: "#fff",
        padding: 40,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Mira Video Avatar Demo</h1>
      <p style={{ color: "#888", marginBottom: 32 }}>
        13 emotions × 2 states (idle/speaking) = 26 seamless video loops
      </p>

      <div style={{ display: "flex", gap: 60, flexWrap: "wrap" }}>
        {/* Avatar preview */}
        <div>
          <MiraVideoAvatar
            emotion={emotion}
            state={avatarState}
            size={size}
          />
          <div style={{ marginTop: 16, textAlign: "center", color: "#888" }}>
            {emotion} / {avatarState}
          </div>
        </div>

        {/* Controls */}
        <div style={{ flex: 1, minWidth: 300 }}>
          {/* State toggle */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ marginBottom: 12 }}>Avatar State</h3>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={() => setAvatarState("idle")}
                style={{
                  padding: "12px 24px",
                  background: avatarState === "idle" ? "#4a6fa5" : "#333",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: "1rem",
                }}
              >
                Idle (no lip movement)
              </button>
              <button
                onClick={() => setAvatarState("speaking")}
                style={{
                  padding: "12px 24px",
                  background: avatarState === "speaking" ? "#4a6fa5" : "#333",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: "1rem",
                }}
              >
                Speaking (lip movement)
              </button>
            </div>
          </div>

          {/* Emotion selector */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ marginBottom: 12 }}>Emotion</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {EMOTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmotion(e)}
                  style={{
                    padding: "8px 16px",
                    background: emotion === e ? "#4a6fa5" : "#333",
                    border: "none",
                    borderRadius: 6,
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "0.9rem",
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          {/* Size slider */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ marginBottom: 12 }}>Size: {size}px</h3>
            <input
              type="range"
              min={100}
              max={500}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              style={{ width: "100%", maxWidth: 300 }}
            />
          </div>

          {/* Quick test buttons */}
          <div>
            <h3 style={{ marginBottom: 12 }}>Quick Tests</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                onClick={() => {
                  setEmotion("thinking");
                  setAvatarState("idle");
                }}
                style={quickButtonStyle}
              >
                🤔 Thinking
              </button>
              <button
                onClick={() => {
                  setEmotion("happy");
                  setAvatarState("speaking");
                }}
                style={quickButtonStyle}
              >
                😊 Happy Speaking
              </button>
              <button
                onClick={() => {
                  setEmotion("sassy");
                  setAvatarState("speaking");
                }}
                style={quickButtonStyle}
              >
                💅 Sassy Speaking
              </button>
              <button
                onClick={() => {
                  setEmotion("surprised");
                  setAvatarState("idle");
                }}
                style={quickButtonStyle}
              >
                😮 Surprised
              </button>
              <button
                onClick={() => {
                  setEmotion("excited");
                  setAvatarState("speaking");
                }}
                style={quickButtonStyle}
              >
                🎉 Excited Speaking
              </button>
              <button
                onClick={() => {
                  setEmotion("judgy");
                  setAvatarState("speaking");
                }}
                style={quickButtonStyle}
              >
                🤨 Judgy Speaking
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Video path info */}
      <div
        style={{
          marginTop: 40,
          padding: 20,
          background: "#222",
          borderRadius: 8,
          fontFamily: "monospace",
          fontSize: "0.85rem",
        }}
      >
        <div style={{ color: "#888", marginBottom: 8 }}>Current video path:</div>
        <div style={{ color: "#4a6fa5" }}>
          /avatar/loops/seamless/
          {avatarState === "speaking" ? `talking/${emotion}_talking.mp4` : `${emotion}_loop.mp4`}
        </div>
      </div>
    </main>
  );
}

const quickButtonStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "#222",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#fff",
  cursor: "pointer",
  fontSize: "0.9rem",
};
