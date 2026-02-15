"use client";

import { useEffect, useState, useRef } from "react";
import { socket } from "@/lib/socket";
import type { RecommendationResponse, Outfit } from "@/lib/types";

type MirrorState = "idle" | "loading" | "showing_outfits" | "error";

export default function MirrorPage() {
  const [state, setState] = useState<MirrorState>("idle");
  const [data, setData] = useState<RecommendationResponse["data"] | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const outfits = data?.outfits ?? [];

  // Auto-advance carousel
  useEffect(() => {
    if (state !== "showing_outfits" || outfits.length <= 1) return;
    timerRef.current = setInterval(() => {
      setActiveIndex((i) => (i + 1) % outfits.length);
    }, 8000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state, outfits.length]);

  // Socket.io listeners
  useEffect(() => {
    socket.connect();

    socket.on("outfit_generation_started", () => {
      setState("loading");
    });

    socket.on("outfits_ready", (result: RecommendationResponse) => {
      if (result.status === "success" && result.data) {
        setData(result.data);
        setActiveIndex(0);
        setState("showing_outfits");
      } else if (result.status === "error") {
        setErrorMsg(result.message ?? "Something went wrong.");
        setState("error");
      }
    });

    socket.on("error", (err: { message: string }) => {
      setErrorMsg(err.message);
      setState("error");
    });

    return () => {
      socket.off("outfit_generation_started");
      socket.off("outfits_ready");
      socket.off("error");
      socket.disconnect();
    };
  }, []);

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        background: "#000",
        color: "#fff",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {state === "idle" && <IdleView />}
      {state === "loading" && <LoadingView />}
      {state === "showing_outfits" && data && (
        <OutfitsView
          greeting={data.greeting}
          styleAnalysis={data.style_analysis}
          outfits={outfits}
          activeIndex={activeIndex}
          onDotClick={setActiveIndex}
        />
      )}
      {state === "error" && <ErrorView message={errorMsg} />}
    </main>
  );
}

function IdleView() {
  return (
    <div style={{ textAlign: "center", opacity: 0.5 }}>
      <p style={{ fontSize: 24, letterSpacing: 4 }}>MIRRORLESS</p>
      <p style={{ fontSize: 14, marginTop: 8 }}>Waiting for session...</p>
    </div>
  );
}

function LoadingView() {
  return (
    <div style={{ textAlign: "center" }}>
      <p
        style={{
          fontSize: 28,
          animation: "pulse 2s ease-in-out infinite",
        }}
      >
        Mira is picking your outfits...
      </p>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

function OutfitsView({
  greeting,
  styleAnalysis,
  outfits,
  activeIndex,
  onDotClick,
}: {
  greeting: string;
  styleAnalysis: string;
  outfits: Outfit[];
  activeIndex: number;
  onDotClick: (i: number) => void;
}) {
  const outfit = outfits[activeIndex];
  if (!outfit) return null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 40,
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 22, fontWeight: 300, margin: 0 }}>{greeting}</p>
        <p style={{ fontSize: 14, opacity: 0.6, marginTop: 6 }}>
          {styleAnalysis}
        </p>
      </div>

      {/* Outfit card */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
        }}
      >
        <p
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 1,
            margin: 0,
          }}
        >
          {outfit.outfit_name}
        </p>

        {/* Items row */}
        <div
          style={{
            display: "flex",
            gap: 24,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {outfit.items.map((oi, idx) => (
            <div
              key={idx}
              style={{
                textAlign: "center",
                width: 180,
              }}
            >
              <div
                style={{
                  width: 180,
                  height: 220,
                  background: "#fff",
                  borderRadius: 8,
                  overflow: "hidden",
                  marginBottom: 8,
                }}
              >
                <img
                  src={oi.item.flat_image_url ?? oi.item.image_url}
                  alt={oi.item.title}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    mixBlendMode: "multiply",
                  }}
                />
              </div>
              <p
                style={{
                  fontSize: 13,
                  margin: 0,
                  opacity: 0.9,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {oi.item.title}
              </p>
              <p style={{ fontSize: 13, margin: "4px 0 0", opacity: 0.6 }}>
                {oi.item.price}
              </p>
            </div>
          ))}
        </div>

        {/* Mira comment */}
        <p
          style={{
            fontSize: 15,
            fontStyle: "italic",
            opacity: 0.7,
            maxWidth: 600,
            textAlign: "center",
            margin: 0,
          }}
        >
          &ldquo;{outfit.mira_comment}&rdquo;
        </p>
      </div>

      {/* Navigation dots */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          paddingTop: 20,
        }}
      >
        {outfits.map((_, i) => (
          <button
            key={i}
            onClick={() => onDotClick(i)}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              border: "none",
              background: i === activeIndex ? "#fff" : "rgba(255,255,255,0.3)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", maxWidth: 500, padding: 40 }}>
      <p style={{ fontSize: 20, lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}
