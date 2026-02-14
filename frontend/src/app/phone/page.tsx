"use client";

import { useState } from "react";
import { UserProfile } from "@/lib/api";
import GoogleSignIn from "@/components/phone/GoogleSignIn";
import ProfileForm from "@/components/phone/ProfileForm";
import PokeLink from "@/components/phone/PokeLink";
import QueueStatus from "@/components/phone/QueueStatus";

type Step = "signin" | "profile" | "poke" | "queue";

export default function PhonePage() {
  const [step, setStep] = useState<Step>("signin");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState("");

  function handleSignIn(profile: UserProfile) {
    setUser(profile);
    setError("");
    // If they already have a phone number, skip profile step
    if (profile.phone) {
      setStep("poke");
    } else {
      setStep("profile");
    }
  }

  function handleProfileComplete(updated: UserProfile) {
    setUser(updated);
    setError("");
    setStep("poke");
  }

  function handlePokeSkip() {
    setStep("queue");
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "24px 20px",
        maxWidth: 400,
        margin: "0 auto",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {error && (
        <div
          style={{
            background: "#fef2f2",
            color: "#b91c1c",
            padding: "12px 16px",
            borderRadius: 8,
            marginBottom: 20,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {step === "signin" && (
        <GoogleSignIn onSuccess={handleSignIn} onError={setError} />
      )}

      {step === "profile" && user && (
        <ProfileForm
          user={user}
          onComplete={handleProfileComplete}
          onError={setError}
        />
      )}

      {step === "poke" && <PokeLink onContinue={handlePokeSkip} />}

      {step === "queue" && user && <QueueStatus userId={user.id} />}
    </main>
  );
}
