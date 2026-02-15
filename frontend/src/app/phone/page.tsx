"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { socket } from "@/lib/socket";
import {
  getUser,
  updateProfile,
  uploadSelfie,
  startScrape,
  submitOnboarding,
  UserProfile,
} from "@/lib/api";
import type { OnboardingData } from "@/lib/types";
import GoogleSignIn from "@/components/phone/GoogleSignIn";
import SelfieCapture from "@/components/phone/SelfieCapture";
import QueueStatus from "@/components/phone/QueueStatus";

type PhoneState = "loading" | "signin" | "questionnaire" | "queue" | "idle" | "recap";

const STORAGE_KEY = "mirrorless_user_id";

export default function PhonePage() {
  const [state, setState] = useState<PhoneState>("loading");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState("");
  const [recapData, setRecapData] = useState<{
    summary?: string;
    items_shown?: number;
    items_liked?: number;
  }>({});

  // Shape of the actual session_ended payload from backend
  interface SessionEndedPayload {
    summary?: string;
    stats?: { items_shown: number; likes: number; dislikes: number };
    liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
    user_name?: string;
  }

  // Check for returning user on mount
  useEffect(() => {
    async function checkReturning() {
      const savedId = localStorage.getItem(STORAGE_KEY);
      if (savedId) {
        try {
          const existingUser = await getUser(savedId);
          setUser(existingUser);
          setState("queue");
          return;
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      setState("signin");
    }
    checkReturning();
  }, []);

  // Connect socket when we have a user
  useEffect(() => {
    if (!user) return;
    socket.connect();
    socket.emit("join_room", { user_id: user.id });

    const handleSessionEnded = (data: SessionEndedPayload) => {
      setRecapData({
        summary: data?.summary,
        items_shown: data?.stats?.items_shown,
        items_liked: data?.stats?.likes,
      });
      setState("recap");
    };

    socket.on("session_ended", handleSessionEnded);

    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
  }, [user]);

  const handleSignInComplete = useCallback(
    (profile: UserProfile, selfieBase64: string | null, displayName: string) => {
      setUser(profile);
      localStorage.setItem(STORAGE_KEY, profile.id);

      // Fire-and-forget: update name, upload selfie, start scrape
      updateProfile(profile.id, displayName).catch(() => {});
      if (selfieBase64) {
        uploadSelfie(profile.id, selfieBase64).catch(() => {});
      }
      startScrape(profile.id).catch(() => {});

      setState("questionnaire");
    },
    []
  );

  const handleQuestionnaireSubmit = useCallback(
    async (data: OnboardingData) => {
      if (!user) return;
      await submitOnboarding(user.id, data);
      setState("queue");
    },
    [user]
  );

  const handleBecameActive = useCallback(() => {
    setState("idle");
  }, []);

  const handleLeaveQueue = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setState("signin");
  }, []);

  const handleDone = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setRecapData({});
    setState("signin");
  }, []);

  if (state === "loading") {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-zinc-400 animate-pulse">Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white text-zinc-900">
      {state === "signin" && (
        <SignInView onComplete={handleSignInComplete} error={error} setError={setError} />
      )}
      {state === "questionnaire" && (
        <QuestionnaireView onSubmit={handleQuestionnaireSubmit} />
      )}
      {state === "queue" && user && (
        <div className="flex flex-col items-center justify-center min-h-screen p-8">
          <QueueStatus userId={user.id} onBecameActive={handleBecameActive} onLeave={handleLeaveQueue} />
        </div>
      )}
      {state === "idle" && <IdleView />}
      {state === "recap" && (
        <RecapView data={recapData} onDone={handleDone} />
      )}
    </main>
  );
}

/* ---------- SignIn View ---------- */

function SignInView({
  onComplete,
  error,
  setError,
}: {
  onComplete: (user: UserProfile, selfie: string | null, name: string) => void;
  error: string;
  setError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [selfie, setSelfie] = useState<string | null>(null);
  const [oauthUser, setOauthUser] = useState<UserProfile | null>(null);

  const handleGoogleSuccess = useCallback(
    (user: UserProfile) => {
      setOauthUser(user);
      if (!name && user.name) setName(user.name);
    },
    [name]
  );

  const handleContinue = useCallback(() => {
    if (!oauthUser) {
      setError("Please sign in with Google first.");
      return;
    }
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    onComplete(oauthUser, selfie, name.trim());
  }, [oauthUser, selfie, name, onComplete, setError]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 gap-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold mb-2">Mirrorless</h1>
        <p className="text-zinc-500">Your AI stylist awaits</p>
      </div>

      <SelfieCapture onCapture={setSelfie} />

      <div className="w-full max-w-sm">
        <label className="block text-sm font-semibold mb-1.5">Your name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your name"
          className="w-full px-4 py-3 border border-zinc-200 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </div>

      {!oauthUser ? (
        <GoogleSignIn
          onSuccess={handleGoogleSuccess}
          onError={setError}
        />
      ) : (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <span>✓</span>
          <span>Signed in as {oauthUser.email}</span>
        </div>
      )}

      {oauthUser && (
        <button
          onClick={handleContinue}
          className="w-full max-w-sm bg-zinc-900 text-white rounded-xl py-4 text-base font-semibold"
        >
          Continue
        </button>
      )}

      {error && <p className="text-red-500 text-sm text-center">{error}</p>}
    </div>
  );
}

/* ---------- Questionnaire View ---------- */

const STYLE_OPTIONS = [
  "Casual", "Streetwear", "Minimalist", "Preppy",
  "Athleisure", "Vintage", "Smart Casual", "Bohemian",
];

const OCCASION_OPTIONS = [
  "Everyday", "Work", "Date Night", "Workout", "Weekend", "Travel",
];

function QuestionnaireView({
  onSubmit,
}: {
  onSubmit: (data: OnboardingData) => void;
}) {
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

  return (
    <div className="p-6 max-w-lg mx-auto pb-20">
      <h2 className="text-2xl font-bold mb-1">Let&apos;s get to know you</h2>
      <p className="text-zinc-500 text-sm mb-6">
        Quick style questions to personalize your experience.
      </p>

      {/* Gender */}
      <label className="block text-sm font-semibold mb-1.5">Gender</label>
      <select
        value={gender}
        onChange={(e) => setGender(e.target.value)}
        className="w-full px-4 py-3 border border-zinc-200 rounded-xl text-base mb-5 focus:outline-none focus:ring-2 focus:ring-zinc-900"
      >
        <option value="mens">Men</option>
        <option value="womens">Women</option>
        <option value="unspecified">Prefer not to say</option>
      </select>

      {/* Brands */}
      <label className="block text-sm font-semibold mb-1.5">
        Favorite brands (comma-separated)
      </label>
      <input
        value={brands}
        onChange={(e) => setBrands(e.target.value)}
        placeholder="Nike, Zara, Uniqlo"
        className="w-full px-4 py-3 border border-zinc-200 rounded-xl text-base mb-5 focus:outline-none focus:ring-2 focus:ring-zinc-900"
      />

      {/* Style */}
      <label className="block text-sm font-semibold mb-2">Style preferences</label>
      <div className="flex flex-wrap gap-2 mb-5">
        {STYLE_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => toggle(styles, s, setStyles)}
            className={`px-4 py-2 rounded-full text-sm border transition-colors ${
              styles.includes(s)
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-700 border-zinc-200 hover:border-zinc-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Occasions */}
      <label className="block text-sm font-semibold mb-2">Occasions</label>
      <div className="flex flex-wrap gap-2 mb-5">
        {OCCASION_OPTIONS.map((o) => (
          <button
            key={o}
            onClick={() => toggle(occasions, o, setOccasions)}
            className={`px-4 py-2 rounded-full text-sm border transition-colors ${
              occasions.includes(o)
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-700 border-zinc-200 hover:border-zinc-400"
            }`}
          >
            {o}
          </button>
        ))}
      </div>

      {/* Price range */}
      <label className="block text-sm font-semibold mb-2">
        Price range: ${priceMin} – ${priceMax}
      </label>
      <div className="flex gap-3 items-center mb-8">
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={priceMin}
          onChange={(e) => setPriceMin(Number(e.target.value))}
          className="flex-1"
        />
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={priceMax}
          onChange={(e) => setPriceMax(Number(e.target.value))}
          className="flex-1"
        />
      </div>

      <button
        onClick={handleSubmit}
        className="w-full bg-zinc-900 text-white rounded-xl py-4 text-base font-semibold"
      >
        Join Queue
      </button>
    </div>
  );
}

/* ---------- Idle View ---------- */

const TIPS = [
  "Try saying: \"I want something for a night out\"",
  "Give a thumbs up to save items you like",
  "Swipe left or right to browse outfits",
  "Ask Mira about your style or upcoming events",
];

function IdleView() {
  const [tipIndex, setTipIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tipTimer = setInterval(() => {
      setTipIndex((i) => (i + 1) % TIPS.length);
    }, 5000);
    const clockTimer = setInterval(() => {
      setElapsed((s) => s + 1);
    }, 1000);
    return () => {
      clearInterval(tipTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 gap-8">
      <div className="w-20 h-20 rounded-full bg-green-500 flex items-center justify-center">
        <span className="text-white text-3xl">✦</span>
      </div>

      <h2 className="text-2xl font-bold text-center">
        You&apos;re at the mirror!
      </h2>

      <div className="h-12 flex items-center">
        <p className="text-zinc-500 text-center text-sm animate-pulse transition-all">
          {TIPS[tipIndex]}
        </p>
      </div>

      <div className="text-zinc-400 text-sm font-mono">
        {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
      </div>
    </div>
  );
}

/* ---------- Recap View ---------- */

function RecapView({
  data,
  onDone,
}: {
  data: { summary?: string; items_shown?: number; items_liked?: number };
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 gap-6">
      <h2 className="text-2xl font-bold">Session Complete</h2>

      {data.summary && (
        <p className="text-zinc-600 text-center max-w-sm">{data.summary}</p>
      )}

      <div className="flex gap-8">
        {data.items_shown !== undefined && (
          <div className="text-center">
            <p className="text-3xl font-bold">{data.items_shown}</p>
            <p className="text-xs text-zinc-500">Items Shown</p>
          </div>
        )}
        {data.items_liked !== undefined && (
          <div className="text-center">
            <p className="text-3xl font-bold">{data.items_liked}</p>
            <p className="text-xs text-zinc-500">Liked</p>
          </div>
        )}
      </div>

      <a
        href="#"
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline text-sm"
      >
        View on Poke
      </a>

      <button
        onClick={onDone}
        className="w-full max-w-sm bg-zinc-900 text-white rounded-xl py-4 text-base font-semibold"
      >
        Done
      </button>
    </div>
  );
}
