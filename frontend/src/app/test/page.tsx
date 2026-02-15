"use client";

import { useState } from "react";
import type { RecommendationResponse, Outfit } from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8000";

export default function TestPage() {
  const [sessionId, setSessionId] = useState("");
  const [result, setResult] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedOutfit, setSelectedOutfit] = useState<number>(0);

  async function fetchRecs() {
    if (!sessionId.trim()) {
      setError("Enter a session ID");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout
      const res = await fetch(
        `${API_BASE}/api/sessions/${sessionId}/recommendations`,
        { method: "POST", signal: controller.signal }
      );
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text();
        setError(`HTTP ${res.status}: ${text}`);
        return;
      }
      const data: RecommendationResponse = await res.json();
      setResult(data);
      setSelectedOutfit(0);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("Request timed out (5 min). The backend may be slow.");
      } else {
        setError(e instanceof Error ? e.message : "Failed to fetch");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Mirrorless Recommendation Tester</h1>

      {/* Input */}
      <div style={styles.inputRow}>
        <input
          type="text"
          placeholder="Session ID (UUID)"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          style={styles.input}
        />
        <button onClick={fetchRecs} disabled={loading} style={styles.button}>
          {loading ? "Loading..." : "Get Recommendations"}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {loading && (
        <div style={styles.loadingBox}>
          <p style={styles.loadingText}>
            Mira is curating your outfits... This takes ~2 minutes.
          </p>
          <div style={styles.spinner} />
        </div>
      )}

      {result?.status === "success" && result.data && (
        <div style={styles.results}>
          {/* Header */}
          <div style={styles.greeting}>
            <p style={{ fontSize: 18, margin: 0 }}>{result.data.greeting}</p>
            <p style={{ fontSize: 14, opacity: 0.6, marginTop: 6 }}>
              {result.data.style_analysis}
            </p>
            <p style={{ fontSize: 12, opacity: 0.4, marginTop: 4 }}>
              Generated in {((result.generation_time_ms ?? 0) / 1000).toFixed(1)}s
            </p>
          </div>

          {/* Outfit tabs */}
          <div style={styles.tabs}>
            {result.data.outfits.map((outfit, i) => (
              <button
                key={i}
                onClick={() => setSelectedOutfit(i)}
                style={{
                  ...styles.tab,
                  background: i === selectedOutfit ? "#fff" : "#333",
                  color: i === selectedOutfit ? "#000" : "#aaa",
                }}
              >
                {i + 1}. {outfit.outfit_name}
              </button>
            ))}
          </div>

          {/* Selected outfit */}
          <OutfitCard outfit={result.data.outfits[selectedOutfit]} />
        </div>
      )}

      {result?.status === "needs_onboarding" && (
        <div style={styles.infoBox}>
          <p>{result.message}</p>
        </div>
      )}

      {result?.status === "error" && (
        <div style={styles.errorBox}>
          <p>{result.message}</p>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </div>
  );
}

function OutfitCard({ outfit }: { outfit: Outfit }) {
  if (!outfit) return null;

  return (
    <div style={styles.outfitCard}>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>{outfit.outfit_name}</h2>
      <p style={{ margin: "0 0 8px", opacity: 0.6, fontSize: 14 }}>
        {outfit.description}
      </p>

      {outfit.why_its_a_match && (
        <p style={styles.matchReason}>{outfit.why_its_a_match}</p>
      )}

      {/* Items grid */}
      <div style={styles.itemsGrid}>
        {outfit.items.map((oi, idx) => (
          <div key={idx} style={styles.itemCard}>
            <div style={styles.typeLabel}>{oi.type.toUpperCase()}</div>
            <div style={styles.imageContainer}>
              {(oi.item.flat_image_url || oi.item.image_url) ? (
                <img
                  src={oi.item.flat_image_url || oi.item.image_url}
                  alt={oi.item.title}
                  style={styles.image}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    // Fallback to original image if flat lay fails to load
                    if (oi.item.flat_image_url && img.src !== oi.item.image_url) {
                      img.src = oi.item.image_url;
                    } else {
                      img.style.display = "none";
                    }
                  }}
                />
              ) : (
                <div style={styles.noImage}>No Image</div>
              )}
            </div>
            <div style={styles.itemInfo}>
              <p style={styles.itemTitle}>{oi.item.title}</p>
              <p style={styles.itemSource}>{oi.item.source}</p>
              <div style={styles.priceRow}>
                <span style={styles.price}>{oi.item.price}</span>
                {oi.item.rating && (
                  <span style={styles.rating}>
                    {"*".repeat(Math.round(oi.item.rating))} {oi.item.rating}
                  </span>
                )}
              </div>
              {oi.item.link && (
                <a
                  href={oi.item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.buyLink}
                >
                  View Product
                </a>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Mira comment */}
      <div style={styles.miraComment}>
        <span style={{ opacity: 0.5 }}>Mira says: </span>
        &ldquo;{outfit.mira_comment}&rdquo;
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#111",
    color: "#fff",
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    padding: 32,
    maxWidth: 1200,
    margin: "0 auto",
  },
  title: {
    fontSize: 28,
    fontWeight: 300,
    letterSpacing: 2,
    marginBottom: 24,
  },
  inputRow: {
    display: "flex",
    gap: 12,
    marginBottom: 20,
  },
  input: {
    flex: 1,
    padding: "12px 16px",
    fontSize: 15,
    background: "#222",
    border: "1px solid #444",
    borderRadius: 8,
    color: "#fff",
    outline: "none",
  },
  button: {
    padding: "12px 24px",
    fontSize: 15,
    fontWeight: 600,
    background: "#fff",
    color: "#000",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  error: { color: "#ff6b6b", fontSize: 14 },
  loadingBox: {
    textAlign: "center" as const,
    padding: 60,
  },
  loadingText: {
    fontSize: 18,
    animation: "pulse 2s ease-in-out infinite",
    marginBottom: 20,
  },
  spinner: {
    width: 40,
    height: 40,
    border: "3px solid #333",
    borderTop: "3px solid #fff",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
    margin: "0 auto",
  },
  results: { marginTop: 20 },
  greeting: {
    background: "#1a1a2e",
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  tabs: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
    marginBottom: 20,
  },
  tab: {
    padding: "8px 16px",
    fontSize: 13,
    border: "1px solid #444",
    borderRadius: 20,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  outfitCard: {
    background: "#1a1a1a",
    borderRadius: 16,
    padding: 28,
  },
  matchReason: {
    background: "#1a2a1a",
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 14,
    borderLeft: "3px solid #4caf50",
    marginBottom: 20,
  },
  itemsGrid: {
    display: "flex",
    gap: 20,
    flexWrap: "wrap" as const,
    justifyContent: "center",
    margin: "20px 0",
  },
  itemCard: {
    width: 240,
    background: "#222",
    borderRadius: 12,
    overflow: "hidden",
    position: "relative" as const,
  },
  typeLabel: {
    position: "absolute" as const,
    top: 8,
    left: 8,
    background: "rgba(0,0,0,0.7)",
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1,
    zIndex: 1,
  },
  imageContainer: {
    width: "100%",
    height: 260,
    background: "#2a2a2a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
  },
  noImage: {
    color: "#666",
    fontSize: 14,
  },
  itemInfo: {
    padding: 14,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: 500,
    margin: "0 0 4px",
    lineHeight: 1.3,
  },
  itemSource: {
    fontSize: 12,
    opacity: 0.5,
    margin: "0 0 8px",
  },
  priceRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  price: {
    fontSize: 18,
    fontWeight: 700,
    color: "#4caf50",
  },
  rating: {
    fontSize: 12,
    opacity: 0.6,
  },
  buyLink: {
    display: "inline-block",
    fontSize: 12,
    color: "#64b5f6",
    textDecoration: "none",
  },
  miraComment: {
    marginTop: 20,
    padding: "14px 18px",
    background: "#1a1a2e",
    borderRadius: 10,
    fontStyle: "italic",
    fontSize: 15,
    lineHeight: 1.5,
  },
  infoBox: {
    background: "#1a2a1a",
    padding: 20,
    borderRadius: 12,
    marginTop: 20,
  },
  errorBox: {
    background: "#2a1a1a",
    padding: 20,
    borderRadius: 12,
    marginTop: 20,
  },
};
