"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StreamingTTS } from "@/lib/streaming-tts";
import type { MiraEmotion, MiraAvatarState } from "@/components/ui/mira-video-avatar";

export type { MiraEmotion, MiraAvatarState };

export interface UseMiraVideoAvatarReturn {
  emotion: MiraEmotion;
  avatarState: MiraAvatarState;
  isSpeaking: boolean;
  speak: (text: string, emotion?: MiraEmotion) => void;
  speakQueued: (text: string, emotion?: MiraEmotion) => void;
  flushQueue: () => void;
  setEmotion: (emotion: MiraEmotion) => void;
  setAvatarState: (state: MiraAvatarState) => void;
  stop: () => void;
  startSession: () => void;
  stopSession: () => void;
  // For compatibility with existing code expecting orb-like interface
  orbState: "idle" | "listening" | "thinking" | "speaking";
  setOrbState: (state: "idle" | "listening" | "thinking" | "speaking") => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Hook to manage Mira video avatar state and TTS playback.
 * Replaces useOrbAvatar but uses video loops instead of the WebGL orb.
 */
export function useMiraVideoAvatar(): UseMiraVideoAvatarReturn {
  const [emotion, setEmotionInternal] = useState<MiraEmotion>("idle");
  const [avatarState, setAvatarStateInternal] = useState<MiraAvatarState>("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [orbState, setOrbStateInternal] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");

  const ttsRef = useRef<StreamingTTS | null>(null);

  const setEmotion = useCallback((newEmotion: MiraEmotion) => {
    setEmotionInternal(newEmotion);
  }, []);

  const setAvatarState = useCallback((state: MiraAvatarState) => {
    setAvatarStateInternal(state);
  }, []);

  // Map orbState to avatarState for backward compatibility
  const setOrbState = useCallback((state: "idle" | "listening" | "thinking" | "speaking") => {
    setOrbStateInternal(state);
    
    if (state === "speaking") {
      setAvatarStateInternal("speaking");
    } else if (state === "thinking") {
      setEmotionInternal("thinking");
      setAvatarStateInternal("idle");
    } else {
      setAvatarStateInternal("idle");
    }
  }, []);

  const speak = useCallback(
    (text: string, speakEmotion: MiraEmotion = "idle") => {
      if (!text.trim() || !ttsRef.current) {
        console.warn("[MirrorV2:TTS] speak skipped — empty text or no TTS");
        return;
      }

      // Set emotion and switch to speaking state
      setEmotionInternal(speakEmotion);
      setAvatarStateInternal("speaking");
      setIsSpeaking(true);
      setOrbStateInternal("speaking");

      console.log(`[MirrorV2:TTS] Speaking (emotion=${speakEmotion}):`, text.slice(0, 80));

      ttsRef.current
        .speak(
          text,
          () => {
            // onStart — audio playback has begun
            console.log("[MirrorV2:TTS] Playback started");
          },
          () => {
            // onEnd — audio playback finished
            console.log("[MirrorV2:TTS] Playback finished");
            setIsSpeaking(false);
            setAvatarStateInternal("idle");
            setOrbStateInternal("idle");
            // Keep the emotion for a moment, then fade to idle
            setTimeout(() => {
              setEmotionInternal("idle");
            }, 500);
          }
        )
        .catch((err: unknown) => {
          console.error("[MirrorV2:TTS] speak() failed:", err instanceof Error ? err.message : err);
          setIsSpeaking(false);
          setAvatarStateInternal("idle");
          setEmotionInternal("idle");
          setOrbStateInternal("idle");
        });
    },
    []
  );

  /**
   * Enqueue a sentence for sequential playback.
   * Keeps avatar in speaking state across the full queue.
   * Call flushQueue() when all sentences have been enqueued (end-of-message).
   */
  const speakQueued = useCallback(
    (text: string, speakEmotion: MiraEmotion = "idle") => {
      if (!text.trim() || !ttsRef.current) {
        console.warn("[MirrorV2:TTS] speakQueued skipped — empty text or no TTS");
        return;
      }

      setEmotionInternal(speakEmotion);
      setAvatarStateInternal("speaking");
      setIsSpeaking(true);
      setOrbStateInternal("speaking");

      console.log(`[MirrorV2:TTS] Queuing sentence (emotion=${speakEmotion}):`, text.slice(0, 60));

      ttsRef.current.speakQueued(
        text,
        undefined,
        undefined,
      );
    },
    []
  );

  /**
   * Signal that all sentences have been enqueued.
   * The drain callback will fire when the last sentence finishes playing.
   */
  const flushQueue = useCallback(() => {
    if (!ttsRef.current) return;

    ttsRef.current.onAllDone(() => {
      console.log("[MirrorV2:TTS] Queue drained — all sentences played");
      setIsSpeaking(false);
      setAvatarStateInternal("idle");
      setOrbStateInternal("idle");
      setTimeout(() => {
        setEmotionInternal("idle");
      }, 500);
    });
  }, []);

  const stop = useCallback(() => {
    ttsRef.current?.stop();
    setIsSpeaking(false);
    setAvatarStateInternal("idle");
    setEmotionInternal("idle");
    setOrbStateInternal("idle");
  }, []);

  const startSession = useCallback(() => {
    if (ttsRef.current) return;
    try {
      const tts = new StreamingTTS(API_URL);
      ttsRef.current = tts;
      console.log("[MirrorV2:TTS] StreamingTTS initialized");
    } catch (err) {
      console.error("[MirrorV2:TTS] Init failed:", err instanceof Error ? err.message : err);
    }
  }, []);

  const stopSession = useCallback(() => {
    ttsRef.current?.destroy();
    ttsRef.current = null;
    setIsSpeaking(false);
    setAvatarStateInternal("idle");
    setEmotionInternal("idle");
    setOrbStateInternal("idle");
    console.log("[MirrorV2:TTS] Session stopped");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      ttsRef.current?.destroy();
      ttsRef.current = null;
    };
  }, []);

  return {
    emotion,
    avatarState,
    isSpeaking,
    speak,
    speakQueued,
    flushQueue,
    setEmotion,
    setAvatarState,
    stop,
    startSession,
    stopSession,
    // Backward compatibility
    orbState,
    setOrbState,
  };
}
