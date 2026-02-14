"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { startScrape, Purchase, StyleProfile } from "@/lib/api";

interface ScrapeResultsProps {
  userId: string;
  onContinue: () => void;
}

type Phase = "searching" | "parsing" | "profiling" | "complete" | "error";

const PHASE_LABELS: Record<Phase, string> = {
  searching: "Searching receipts...",
  parsing: "Parsing purchases...",
  profiling: "Building your style profile...",
  complete: "Done!",
  error: "Something went wrong",
};

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8000";

export default function ScrapeResults({ userId, onContinue }: ScrapeResultsProps) {
  const [phase, setPhase] = useState<Phase>("searching");
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [profile, setProfile] = useState<StyleProfile | null>(null);
  const [error, setError] = useState("");
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Connect to Socket.io for live progress
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join_room", { user_id: userId });
    });

    socket.on("scrape_progress", (data: { phase: string }) => {
      if (data.phase === "error") {
        setError("Scrape failed on the server");
        setPhase("error");
      }
    });

    socket.on("purchase_found", (data: { purchases: Purchase[]; total_so_far: number }) => {
      // Move to parsing phase on first purchase
      setPhase((prev) => (prev === "searching" ? "parsing" : prev));
      setPurchases((prev) => [...prev, ...data.purchases]);
    });

    socket.on("scrape_complete", (data: { profile: StyleProfile }) => {
      setProfile(data.profile);
      setPhase("profiling");
      // Brief "profiling" phase then transition to complete
      setTimeout(() => setPhase("complete"), 1200);
    });

    // Fire-and-forget: trigger the scrape via HTTP
    startScrape(userId).catch((err) => {
      setError(err.message || "Failed to start scrape");
      setPhase("error");
    });

    return () => {
      socket.disconnect();
    };
  }, [userId]);

  const purchaseCount = purchases.length;
  const brandSet = new Set(purchases.map((p) => p.brand));
  const brandCount = brandSet.size;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Your Style DNA</h2>

      {/* Progress steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(["searching", "parsing", "profiling", "complete"] as Phase[]).map((p, i) => {
          const isActive = p === phase;
          const isDone =
            (["searching", "parsing", "profiling", "complete"] as Phase[]).indexOf(phase) > i ||
            phase === "complete";
          return (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                opacity: isDone || isActive ? 1 : 0.4,
                fontSize: 14,
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 600,
                  background: isDone ? "#10b981" : isActive ? "#5B4FE9" : "#e5e7eb",
                  color: isDone || isActive ? "#fff" : "#9ca3af",
                  flexShrink: 0,
                }}
              >
                {isDone && !isActive ? "\u2713" : i + 1}
              </span>
              <span style={{ fontWeight: isActive ? 600 : 400 }}>
                {PHASE_LABELS[p]}
              </span>
              {isActive && phase !== "complete" && (
                <span style={{ marginLeft: 4, animation: "pulse 1.5s infinite" }}>
                  ...
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Error state */}
      {phase === "error" && (
        <div style={{ background: "#fef2f2", color: "#b91c1c", padding: "12px 16px", borderRadius: 8, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Live counter while loading */}
      {phase !== "complete" && phase !== "error" && purchaseCount > 0 && (
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          Found {purchaseCount} purchase{purchaseCount !== 1 ? "s" : ""} from {brandCount} brand{brandCount !== 1 ? "s" : ""} so far...
        </p>
      )}

      {/* Purchases table — renders incrementally as items arrive */}
      {purchaseCount > 0 && (
        <>
          {phase === "complete" && (
            <div
              style={{
                background: "#f0fdf4",
                padding: "12px 16px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                color: "#166534",
              }}
            >
              Found {purchaseCount} purchase{purchaseCount !== 1 ? "s" : ""} from {brandCount} brand{brandCount !== 1 ? "s" : ""}
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Brand</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Item</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Price</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Date</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Category</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px", fontWeight: 500 }}>{p.brand}</td>
                    <td style={{ padding: "6px" }}>{p.item_name}</td>
                    <td style={{ padding: "6px" }}>{p.price != null ? `$${p.price.toFixed(2)}` : "-"}</td>
                    <td style={{ padding: "6px", whiteSpace: "nowrap" }}>{p.date || "-"}</td>
                    <td style={{ padding: "6px" }}>{p.category || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Style profile — shown after scrape_complete */}
      {profile && phase === "complete" && (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 8px 0" }}>Style Profile</h3>

          {/* Price range */}
          <p style={{ fontSize: 13, color: "#666", margin: "0 0 8px 0" }}>
            Price range: ${profile.price_range.min.toFixed(0)} &ndash; ${profile.price_range.max.toFixed(0)}
            {" "}(avg ${profile.price_range.avg.toFixed(0)})
          </p>

          {/* Style tags */}
          {profile.style_tags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {profile.style_tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: "#ede9fe",
                    color: "#5B4FE9",
                    padding: "4px 10px",
                    borderRadius: 16,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Narrative summary */}
          {profile.narrative_summary && (
            <p style={{ fontSize: 13, color: "#444", lineHeight: 1.5, margin: 0 }}>
              {profile.narrative_summary}
            </p>
          )}
        </div>
      )}

      {/* Continue button */}
      {phase === "complete" && profile && (
        <button
          onClick={onContinue}
          style={{
            padding: "14px 24px",
            fontSize: 16,
            fontWeight: 600,
            color: "#fff",
            background: "#5B4FE9",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            width: "100%",
          }}
        >
          Continue
        </button>
      )}

      {/* Retry on error */}
      {phase === "error" && (
        <button
          onClick={() => window.location.reload()}
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
          Retry
        </button>
      )}
    </div>
  );
}
