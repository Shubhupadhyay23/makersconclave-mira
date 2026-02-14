"use client";

import { useState, FormEvent } from "react";
import { updateProfile, UserProfile } from "@/lib/api";

interface ProfileFormProps {
  user: UserProfile;
  onComplete: (user: UserProfile) => void;
  onError: (error: string) => void;
}

export default function ProfileForm({ user, onComplete, onError }: ProfileFormProps) {
  const [name, setName] = useState(user.name || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) return;

    setSubmitting(true);
    try {
      const updated = await updateProfile(user.id, name.trim(), phone.trim());
      onComplete(updated);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle = {
    width: "100%",
    padding: "14px 16px",
    fontSize: 16,
    border: "1px solid #ddd",
    borderRadius: 8,
    outline: "none",
    boxSizing: "border-box" as const,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Your Profile</h2>
      <p style={{ color: "#666", margin: 0 }}>
        Confirm your details so Mira can personalize your experience.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={{ fontSize: 14, fontWeight: 600, display: "block", marginBottom: 6 }}>
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            required
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: 14, fontWeight: 600, display: "block", marginBottom: 6 }}>
            Phone number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 (555) 123-4567"
            required
            style={inputStyle}
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !name.trim() || !phone.trim()}
          style={{
            padding: "14px 24px",
            fontSize: 16,
            fontWeight: 600,
            color: "#fff",
            background: submitting ? "#999" : "#000",
            border: "none",
            borderRadius: 8,
            cursor: submitting ? "not-allowed" : "pointer",
            marginTop: 4,
          }}
        >
          {submitting ? "Saving..." : "Continue"}
        </button>
      </form>
    </div>
  );
}
