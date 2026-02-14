"use client";

import { useEffect, useCallback, useRef } from "react";
import { googleLogin, UserProfile } from "@/lib/api";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient: (config: {
            client_id: string;
            scope: string;
            ux_mode: string;
            callback: (response: { code: string }) => void;
          }) => { requestCode: () => void };
        };
      };
    };
  }
}

interface GoogleSignInProps {
  onSuccess: (user: UserProfile) => void;
  onError: (error: string) => void;
}

export default function GoogleSignIn({ onSuccess, onError }: GoogleSignInProps) {
  const clientRef = useRef<{ requestCode: () => void } | null>(null);
  const loadingRef = useRef(false);

  const handleAuth = useCallback(
    async (response: { code: string }) => {
      try {
        const user = await googleLogin(response.code);
        onSuccess(user);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Login failed");
      }
    },
    [onSuccess, onError]
  );

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      onError("Google Client ID not configured");
      return;
    }

    function initClient() {
      if (!window.google || clientRef.current) return;
      clientRef.current = window.google.accounts.oauth2.initCodeClient({
        client_id: clientId!,
        scope: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.readonly",
        ].join(" "),
        ux_mode: "popup",
        callback: handleAuth,
      });
    }

    // Load GSI script if not already present
    if (window.google) {
      initClient();
    } else if (!loadingRef.current) {
      loadingRef.current = true;
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = initClient;
      document.head.appendChild(script);
    }
  }, [handleAuth, onError]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Mirrorless</h1>
      <p style={{ color: "#666", margin: 0, textAlign: "center" }}>
        Sign in to get personalized outfit recommendations
      </p>
      <button
        onClick={() => clientRef.current?.requestCode()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 28px",
          fontSize: 16,
          fontWeight: 600,
          border: "1px solid #ddd",
          borderRadius: 8,
          background: "#fff",
          cursor: "pointer",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Sign in with Google
      </button>
    </div>
  );
}
