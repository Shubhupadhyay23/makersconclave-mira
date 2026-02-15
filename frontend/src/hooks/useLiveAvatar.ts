"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveAvatarSession,
  SessionEvent,
  SessionState as AvatarSessionState,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface UseLiveAvatarReturn {
  isReady: boolean;
  isSpeaking: boolean;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  speak: (text: string) => void;
  interrupt: () => void;
  clearQueue: () => void;
  avatarRef: React.RefObject<HTMLVideoElement | null>;
}

async function fetchSessionToken(): Promise<string> {
  const res = await fetch(`${API_URL}/api/heygen/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_sandbox: true }),
  });
  if (!res.ok) throw new Error(`Failed to fetch LiveAvatar token: ${res.status}`);
  const data = await res.json();
  return data.session_token;
}

export function useLiveAvatar(): UseLiveAvatarReturn {
  const [isReady, setIsReady] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const avatarRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const isReadyRef = useRef(false);

  // Speech queue — process one sentence at a time to prevent overlapping speech
  const speechQueueRef = useRef<string[]>([]);
  const isProcessingQueueRef = useRef(false);

  const processQueue = useCallback(() => {
    // Don't attempt repeat() until the session is actually connected
    if (isProcessingQueueRef.current || !sessionRef.current || !isReadyRef.current) return;

    // SDK fires STREAM_READY before state reaches CONNECTED.
    // repeat() silently no-ops if not CONNECTED, so defer until ready.
    if (sessionRef.current.state !== AvatarSessionState.CONNECTED) {
      setTimeout(() => processQueue(), 200);
      return;
    }

    const next = speechQueueRef.current.shift();
    if (!next) {
      setIsSpeaking(false);
      return;
    }
    isProcessingQueueRef.current = true;
    setIsSpeaking(true);
    console.log("[LiveAvatar] repeat():", next.slice(0, 60));
    try {
      sessionRef.current.repeat(next);
    } catch (err) {
      console.error("[LiveAvatar] repeat() failed:", err);
      isProcessingQueueRef.current = false;
      // Try next item on next tick instead of leaving queue permanently stuck
      setTimeout(() => processQueue(), 0);
    }
  }, []);

  const clearQueue = useCallback(() => {
    speechQueueRef.current = [];
    isProcessingQueueRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearQueue();
      sessionRef.current?.stop().catch(() => {});
      sessionRef.current = null;
      isReadyRef.current = false;
    };
  }, [clearQueue]);

  const startSession = useCallback(async () => {
    if (sessionRef.current) return;

    console.log("[LiveAvatar] Fetching session token...");
    const token = await fetchSessionToken();
    console.log("[LiveAvatar] Token received, creating session...");
    const session = new LiveAvatarSession(token);
    sessionRef.current = session;

    session.on(SessionEvent.SESSION_STREAM_READY, () => {
      console.log("[LiveAvatar] Stream ready — attaching video + draining queue");
      if (avatarRef.current) {
        session.attach(avatarRef.current);
      }
      isReadyRef.current = true;
      setIsReady(true);
      // Drain any speech that queued while we were connecting
      processQueue();
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
      console.log("[LiveAvatar] Avatar started speaking");
      setIsSpeaking(true);
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      console.log("[LiveAvatar] Avatar stopped speaking, processing next in queue");
      isProcessingQueueRef.current = false;
      processQueue();
    });

    session.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
      console.log("[LiveAvatar] Disconnected:", reason);
      isReadyRef.current = false;
      setIsReady(false);
      setIsSpeaking(false);
      clearQueue();
      sessionRef.current = null;
    });

    session.on(SessionEvent.SESSION_STATE_CHANGED, (state: AvatarSessionState) => {
      console.log("[LiveAvatar] State changed:", state);
    });

    console.log("[LiveAvatar] Starting session...");
    try {
      await session.start();
    } catch (err) {
      console.error("[LiveAvatar] session.start() failed:", err);
      sessionRef.current = null;
      throw err;
    }
    console.log("[LiveAvatar] session.start() resolved");

    // SDK v0.0.10 bug: WebSocket handler drops AVATAR_SPEAK_TEXT commands
    // (logs "Unsupported command event type:" and does nothing).
    // Route text commands through LiveKit data channel instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sess = session as any;
    if (typeof sess.sendCommandEvent === "function") {
      const origSend = sess.sendCommandEvent.bind(sess);
      sess.sendCommandEvent = (cmd: any) => {
        const TEXT_CMDS = ["avatar.speak_text", "avatar.speak_response"];
        if (
          TEXT_CMDS.includes(cmd.event_type) &&
          sess.room?.state === "connected"
        ) {
          const data = new TextEncoder().encode(JSON.stringify(cmd));
          sess.room.localParticipant.publishData(data, {
            reliable: true,
            topic: "agent-control",
          });
        } else {
          origSend(cmd);
        }
      };
    }
  }, [processQueue, clearQueue]);

  const stopSession = useCallback(async () => {
    if (!sessionRef.current) return;
    clearQueue();
    isReadyRef.current = false;
    await sessionRef.current.stop();
    sessionRef.current = null;
    setIsReady(false);
    setIsSpeaking(false);
  }, [clearQueue]);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      console.log("[LiveAvatar] Queued:", text.slice(0, 60), `(ready=${isReadyRef.current}, queue=${speechQueueRef.current.length})`);
      speechQueueRef.current.push(text);
      setIsSpeaking(true);
      processQueue();
    },
    [processQueue],
  );

  const interrupt = useCallback(() => {
    if (!sessionRef.current) return;
    clearQueue();
    sessionRef.current.interrupt();
  }, [clearQueue]);

  return {
    isReady,
    isSpeaking,
    startSession,
    stopSession,
    speak,
    interrupt,
    clearQueue,
    avatarRef,
  };
}
