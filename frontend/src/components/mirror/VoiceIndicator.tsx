"use client";

interface VoiceIndicatorProps {
  isListening: boolean;
  interimTranscript: string;
}

export default function VoiceIndicator({
  isListening,
  interimTranscript,
}: VoiceIndicatorProps) {
  if (!isListening) return null;

  return (
    <div
      data-testid="voice-indicator"
      style={{
        position: "absolute",
        bottom: 24,
        left: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        borderRadius: 20,
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        fontSize: "0.9rem",
        zIndex: 15,
        maxWidth: "40vw",
        pointerEvents: "none",
      }}
    >
      {/* Mic dot indicator */}
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: interimTranscript ? "#4caf50" : "rgba(255,255,255,0.4)",
          flexShrink: 0,
          transition: "background 0.3s",
        }}
      />
      {interimTranscript ? (
        <span style={{ fontStyle: "italic", opacity: 0.9 }}>
          {interimTranscript}
        </span>
      ) : (
        <span style={{ opacity: 0.5 }}>Listening...</span>
      )}
    </div>
  );
}
