"use client";

import { useState } from "react";
import { socket } from "@/lib/socket";
import { fetchRecommendations, submitReaction, submitOnboarding } from "@/lib/api";
import type { Outfit, OnboardingData, RecommendationResponse } from "@/lib/types";

// MVP hardcoded IDs — replace with Google OAuth later
const USER_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "00000000-0000-0000-0000-000000000001";

type PhoneState = "welcome" | "onboarding" | "loading" | "outfits" | "done";

export default function PhonePage() {
  const [state, setState] = useState<PhoneState>("welcome");
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [liked, setLiked] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [greeting, setGreeting] = useState("");

  async function startSession() {
    setState("loading");
    socket.connect();
    socket.emit("session_started", {
      session_id: SESSION_ID,
      user_id: USER_ID,
    });

    // Also call REST endpoint directly
    try {
      const result = await fetchRecommendations(SESSION_ID);
      handleResult(result);
    } catch {
      setErrorMsg("Could not reach backend.");
      setState("welcome");
    }
  }

  function handleResult(result: RecommendationResponse) {
    if (result.status === "success" && result.data) {
      setGreeting(result.data.greeting);
      setOutfits(result.data.outfits);
      setCurrentIdx(0);
      setLiked(0);
      setState("outfits");
    } else if (result.status === "needs_onboarding") {
      setState("onboarding");
    } else {
      setErrorMsg(result.message ?? "Something went wrong.");
      setState("welcome");
    }
  }

  async function handleOnboardingSubmit(data: OnboardingData) {
    setState("loading");
    await submitOnboarding(USER_ID, data);
    try {
      const result = await fetchRecommendations(SESSION_ID);
      handleResult(result);
    } catch {
      setErrorMsg("Could not reach backend.");
      setState("welcome");
    }
  }

  async function handleReaction(reaction: "liked" | "disliked" | "skipped") {
    if (reaction === "liked") setLiked((n) => n + 1);

    // Fire-and-forget reaction update
    const outfitId = outfits[currentIdx]?.id;
    if (outfitId) {
      submitReaction(outfitId, reaction).catch(() => {});
    }

    if (currentIdx + 1 < outfits.length) {
      setCurrentIdx((i) => i + 1);
    } else {
      setState("done");
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        background: "#fafafa",
        color: "#111",
      }}
    >
      {state === "welcome" && (
        <WelcomeView onStart={startSession} error={errorMsg} />
      )}
      {state === "onboarding" && (
        <OnboardingView onSubmit={handleOnboardingSubmit} />
      )}
      {state === "loading" && <PhoneLoadingView />}
      {state === "outfits" && outfits[currentIdx] && (
        <OutfitCardView
          outfit={outfits[currentIdx]}
          index={currentIdx}
          total={outfits.length}
          greeting={greeting}
          onReaction={handleReaction}
        />
      )}
      {state === "done" && (
        <DoneView liked={liked} total={outfits.length} onRestart={() => setState("welcome")} />
      )}
    </main>
  );
}

/* ---------- Sub-views ---------- */

function WelcomeView({ onStart, error }: { onStart: () => void; error: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        padding: 32,
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>
        Mirrorless
      </h1>
      <p style={{ fontSize: 16, color: "#666", marginBottom: 32 }}>
        Your AI stylist, powered by Mira
      </p>
      <button
        onClick={onStart}
        style={{
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          padding: "14px 40px",
          fontSize: 16,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Start Session
      </button>
      {error && (
        <p style={{ color: "#c00", marginTop: 16, fontSize: 14 }}>{error}</p>
      )}
    </div>
  );
}

function PhoneLoadingView() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        textAlign: "center",
      }}
    >
      <p
        style={{
          fontSize: 20,
          fontWeight: 500,
          animation: "pulse 2s ease-in-out infinite",
        }}
      >
        Mira is styling you...
      </p>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  );
}

const STYLE_OPTIONS = [
  "Casual",
  "Streetwear",
  "Minimalist",
  "Preppy",
  "Athleisure",
  "Vintage",
  "Smart Casual",
  "Bohemian",
];

const OCCASION_OPTIONS = [
  "Everyday",
  "Work",
  "Date Night",
  "Workout",
  "Weekend",
  "Travel",
];

function OnboardingView({ onSubmit }: { onSubmit: (d: OnboardingData) => void }) {
  const [brands, setBrands] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [occasions, setOccasions] = useState<string[]>([]);
  const [gender, setGender] = useState("unspecified");
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(300);

  function toggle(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  }

  function handleSubmit() {
    onSubmit({
      favorite_brands: brands.split(",").map((b) => b.trim()).filter(Boolean),
      style_preferences: styles,
      price_range: { min: priceMin, max: priceMax },
      size_info: {},
      gender,
      occasions,
    });
  }

  const chipBase: React.CSSProperties = {
    border: "1px solid #ccc",
    borderRadius: 20,
    padding: "8px 16px",
    fontSize: 14,
    cursor: "pointer",
    background: "#fff",
  };
  const chipActive: React.CSSProperties = {
    ...chipBase,
    background: "#111",
    color: "#fff",
    borderColor: "#111",
  };

  return (
    <div style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
        Let&apos;s get to know you
      </h2>
      <p style={{ color: "#666", marginBottom: 24, fontSize: 14 }}>
        Mira needs a bit of info to style you perfectly.
      </p>

      {/* Gender */}
      <label style={{ fontWeight: 600, fontSize: 14 }}>Gender</label>
      <select
        value={gender}
        onChange={(e) => setGender(e.target.value)}
        style={{
          display: "block",
          width: "100%",
          padding: 10,
          marginTop: 6,
          marginBottom: 20,
          borderRadius: 8,
          border: "1px solid #ccc",
          fontSize: 14,
        }}
      >
        <option value="mens">Men</option>
        <option value="womens">Women</option>
        <option value="unspecified">Prefer not to say</option>
      </select>

      {/* Brands */}
      <label style={{ fontWeight: 600, fontSize: 14 }}>
        Favorite brands (comma-separated)
      </label>
      <input
        value={brands}
        onChange={(e) => setBrands(e.target.value)}
        placeholder="Nike, Zara, Uniqlo"
        style={{
          display: "block",
          width: "100%",
          padding: 10,
          marginTop: 6,
          marginBottom: 20,
          borderRadius: 8,
          border: "1px solid #ccc",
          fontSize: 14,
          boxSizing: "border-box",
        }}
      />

      {/* Style */}
      <label style={{ fontWeight: 600, fontSize: 14 }}>Style preferences</label>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
          marginBottom: 20,
        }}
      >
        {STYLE_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => toggle(styles, s, setStyles)}
            style={styles.includes(s) ? chipActive : chipBase}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Occasions */}
      <label style={{ fontWeight: 600, fontSize: 14 }}>Occasions</label>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
          marginBottom: 20,
        }}
      >
        {OCCASION_OPTIONS.map((o) => (
          <button
            key={o}
            onClick={() => toggle(occasions, o, setOccasions)}
            style={occasions.includes(o) ? chipActive : chipBase}
          >
            {o}
          </button>
        ))}
      </div>

      {/* Price range */}
      <label style={{ fontWeight: 600, fontSize: 14 }}>
        Price range: ${priceMin} – ${priceMax}
      </label>
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 8,
          marginBottom: 28,
          alignItems: "center",
        }}
      >
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={priceMin}
          onChange={(e) => setPriceMin(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={priceMax}
          onChange={(e) => setPriceMax(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>

      <button
        onClick={handleSubmit}
        style={{
          width: "100%",
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          padding: "14px 0",
          fontSize: 16,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Continue
      </button>
    </div>
  );
}

function OutfitCardView({
  outfit,
  index,
  total,
  greeting,
  onReaction,
}: {
  outfit: Outfit;
  index: number;
  total: number;
  greeting: string;
  onReaction: (r: "liked" | "disliked" | "skipped") => void;
}) {
  return (
    <div style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      {/* Progress */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <p style={{ fontSize: 13, color: "#999", margin: 0 }}>
          {index + 1} of {total}
        </p>
        {index === 0 && greeting && (
          <p
            style={{
              fontSize: 13,
              color: "#666",
              margin: 0,
              fontStyle: "italic",
              maxWidth: 220,
              textAlign: "right",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {greeting}
          </p>
        )}
      </div>

      {/* Outfit name */}
      <h2
        style={{
          fontSize: 22,
          fontWeight: 700,
          margin: "0 0 4px",
        }}
      >
        {outfit.outfit_name}
      </h2>
      <p style={{ fontSize: 14, color: "#666", margin: "0 0 16px" }}>
        {outfit.description}
      </p>

      {/* Items stack */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
        {outfit.items.map((oi, idx) => (
          <div
            key={idx}
            style={{
              display: "flex",
              gap: 12,
              background: "#fff",
              borderRadius: 12,
              padding: 10,
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
            }}
          >
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 8,
                overflow: "hidden",
                flexShrink: 0,
                background: "#eee",
              }}
            >
              <img
                src={oi.item.image_url}
                alt={oi.item.title}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  margin: "0 0 4px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {oi.item.title}
              </p>
              <p style={{ fontSize: 13, color: "#666", margin: "0 0 4px" }}>
                {oi.item.price}
              </p>
              <a
                href={oi.item.link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: "#0066cc" }}
              >
                Buy →
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* Mira comment */}
      <p
        style={{
          fontSize: 14,
          fontStyle: "italic",
          color: "#555",
          marginBottom: 24,
          lineHeight: 1.5,
        }}
      >
        &ldquo;{outfit.mira_comment}&rdquo;
      </p>

      {/* Reaction buttons */}
      <div style={{ display: "flex", gap: 12 }}>
        <ReactionButton
          label="👎"
          subLabel="Nope"
          onClick={() => onReaction("disliked")}
          bg="#f5f5f5"
          color="#333"
        />
        <ReactionButton
          label="→"
          subLabel="Skip"
          onClick={() => onReaction("skipped")}
          bg="#f5f5f5"
          color="#333"
        />
        <ReactionButton
          label="👍"
          subLabel="Love it"
          onClick={() => onReaction("liked")}
          bg="#111"
          color="#fff"
        />
      </div>
    </div>
  );
}

function ReactionButton({
  label,
  subLabel,
  onClick,
  bg,
  color,
}: {
  label: string;
  subLabel: string;
  onClick: () => void;
  bg: string;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: bg,
        color,
        border: "none",
        borderRadius: 12,
        padding: "14px 0",
        fontSize: 20,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, opacity: 0.7 }}>{subLabel}</span>
    </button>
  );
}

function DoneView({
  liked,
  total,
  onRestart,
}: {
  liked: number;
  total: number;
  onRestart: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        padding: 32,
        textAlign: "center",
      }}
    >
      <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        All done!
      </h2>
      <p style={{ fontSize: 16, color: "#666", marginBottom: 8 }}>
        You liked {liked} outfit{liked !== 1 ? "s" : ""} out of {total}.
      </p>
      <p style={{ fontSize: 14, color: "#999", marginBottom: 32 }}>
        {total - liked} new items to explore next time.
      </p>
      <button
        onClick={onRestart}
        style={{
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          padding: "14px 40px",
          fontSize: 16,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Start Over
      </button>
    </div>
  );
}
