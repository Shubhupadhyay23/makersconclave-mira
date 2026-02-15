"use client";

import { useEffect, useState } from "react";

interface SessionRecapProps {
  summary?: string;
  likedItems: Array<{ title: string; price?: string; image_url?: string }>;
  stats?: { items_shown: number; likes: number; dislikes: number };
  userName?: string;
  onDismiss: () => void;
}

const RECAP_DURATION_SECONDS = 20;

export default function SessionRecap({
  summary,
  likedItems,
  stats,
  userName,
  onDismiss,
}: SessionRecapProps) {
  const [remaining, setRemaining] = useState(RECAP_DURATION_SECONDS);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDismiss();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [onDismiss]);

  const progress = ((RECAP_DURATION_SECONDS - remaining) / RECAP_DURATION_SECONDS) * 100;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 25,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.85)",
        backdropFilter: "blur(20px)",
      }}
    >
      {/* Header */}
      <h1
        style={{
          color: "#fff",
          fontSize: "2.5rem",
          fontWeight: 700,
          marginBottom: 8,
          letterSpacing: "-0.02em",
        }}
      >
        Session Complete
      </h1>
      <p
        style={{
          color: "rgba(255, 255, 255, 0.6)",
          fontSize: "1.2rem",
          marginBottom: 32,
        }}
      >
        {userName ? `Great session, ${userName}!` : "Great session!"}
      </p>

      {/* Summary */}
      {summary && (
        <p
          style={{
            color: "rgba(255, 255, 255, 0.8)",
            fontSize: "1.1rem",
            maxWidth: 600,
            textAlign: "center",
            lineHeight: 1.6,
            marginBottom: 40,
          }}
        >
          {summary}
        </p>
      )}

      {/* Liked items grid */}
      {likedItems.length > 0 && (
        <div style={{ marginBottom: 40, textAlign: "center" }}>
          <p
            style={{
              color: "rgba(255, 255, 255, 0.5)",
              fontSize: "0.85rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 16,
            }}
          >
            Your Favorites
          </p>
          <div
            style={{
              display: "flex",
              gap: 16,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            {likedItems.slice(0, 4).map((item, i) => (
              <div
                key={i}
                style={{
                  width: 140,
                  background: "rgba(255, 255, 255, 0.08)",
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                }}
              >
                {item.image_url && (
                  <img
                    src={item.image_url}
                    alt={item.title}
                    style={{
                      width: "100%",
                      height: 140,
                      objectFit: "cover",
                    }}
                  />
                )}
                <div style={{ padding: "8px 10px" }}>
                  <p
                    style={{
                      color: "#fff",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title}
                  </p>
                  {item.price && (
                    <p
                      style={{
                        color: "rgba(255, 255, 255, 0.5)",
                        fontSize: "0.7rem",
                        marginTop: 2,
                      }}
                    >
                      {item.price}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats row */}
      {stats && (
        <div
          style={{
            display: "flex",
            gap: 48,
            marginBottom: 40,
          }}
        >
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#fff", fontSize: "2rem", fontWeight: 700 }}>
              {stats.items_shown}
            </p>
            <p
              style={{
                color: "rgba(255, 255, 255, 0.4)",
                fontSize: "0.8rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Items Shown
            </p>
          </div>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#fff", fontSize: "2rem", fontWeight: 700 }}>
              {stats.likes}
            </p>
            <p
              style={{
                color: "rgba(255, 255, 255, 0.4)",
                fontSize: "0.8rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Liked
            </p>
          </div>
        </div>
      )}

      {/* Footer text */}
      <p
        style={{
          color: "rgba(255, 255, 255, 0.4)",
          fontSize: "0.9rem",
          marginBottom: 24,
        }}
      >
        Your picks have been saved. Check your phone for links.
      </p>

      {/* Progress bar */}
      <div
        style={{
          width: 200,
          height: 3,
          background: "rgba(255, 255, 255, 0.1)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: "100%",
            background: "rgba(255, 255, 255, 0.4)",
            borderRadius: 2,
            transition: "width 1s linear",
          }}
        />
      </div>
    </div>
  );
}
