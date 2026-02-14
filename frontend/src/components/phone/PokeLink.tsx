"use client";

interface PokeLinkProps {
  onContinue: () => void;
}

export default function PokeLink({ onContinue }: PokeLinkProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Join Poke</h2>
      <p style={{ color: "#666", margin: 0, textAlign: "center", lineHeight: 1.5 }}>
        Sign up for Poke to unlock exclusive features and connect with the Mirrorless community.
      </p>
      <a
        href="https://poke.com/treehacks"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "block",
          width: "100%",
          padding: "14px 24px",
          fontSize: 16,
          fontWeight: 600,
          color: "#fff",
          background: "#5B4FE9",
          border: "none",
          borderRadius: 8,
          textAlign: "center",
          textDecoration: "none",
          boxSizing: "border-box",
        }}
      >
        Sign up on Poke
      </a>
      <button
        onClick={onContinue}
        style={{
          padding: "14px 24px",
          fontSize: 16,
          fontWeight: 500,
          color: "#666",
          background: "transparent",
          border: "1px solid #ddd",
          borderRadius: 8,
          cursor: "pointer",
          width: "100%",
        }}
      >
        Skip for now
      </button>
    </div>
  );
}
