"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { MemojiAvatar, type AvatarState } from "@/lib/memoji-avatar";
import { ElevenLabsTTS } from "@/lib/elevenlabs-tts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface UseMemojiAvatarReturn {
  isReady: boolean;
  isSpeaking: boolean;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  speak: (text: string) => void;
  playScripted: (videoPath: string) => Promise<void>;
  interrupt: () => void;
  clearQueue: () => void;
  setAvatarState: (state: AvatarState) => void;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useMemojiAvatar(): UseMemojiAvatarReturn {
  const [isReady, setIsReady] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<MemojiAvatar | null>(null);
  const ttsRef = useRef<ElevenLabsTTS | null>(null);

  // Speech queue
  const speechQueueRef = useRef<string[]>([]);
  const isProcessingQueueRef = useRef(false);

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current || !avatarRef.current || !ttsRef.current) return;

    const next = speechQueueRef.current.shift();
    if (!next) {
      setIsSpeaking(false);
      avatarRef.current.idle();
      return;
    }

    isProcessingQueueRef.current = true;
    setIsSpeaking(true);
    console.log("[MemojiAvatar] processQueue: speaking next sentence", {
      sentence: next.slice(0, 80),
      remaining: speechQueueRef.current.length,
    });

    const avatar = avatarRef.current;
    ttsRef.current
      .speak(
        next,
        () => avatar.talking(),
        () => {
          isProcessingQueueRef.current = false;
          processQueue();
        },
      )
      .catch(() => {
        isProcessingQueueRef.current = false;
        processQueue();
      });
  }, []);

  const clearQueue = useCallback(() => {
    speechQueueRef.current = [];
    isProcessingQueueRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearQueue();
      ttsRef.current?.stop();
      avatarRef.current?.destroy();
      avatarRef.current = null;
      ttsRef.current = null;
    };
  }, [clearQueue]);

  const startSession = useCallback(async () => {
    if (avatarRef.current) {
      console.log("[MemojiAvatar] startSession: already initialized, skipping");
      return;
    }
    const container = containerRef.current;
    console.log("[MemojiAvatar] startSession: containerRef.current =", container ? "found" : "null");
    if (!container) {
      console.warn("[MemojiAvatar] No container ref — cannot start session");
      return;
    }

    try {
      const avatar = new MemojiAvatar(container);
      await avatar.init();
      avatarRef.current = avatar;

      const tts = new ElevenLabsTTS(API_URL);
      ttsRef.current = tts;

      setIsReady(true);
      console.log("[MemojiAvatar] Session started successfully");
      // Drain any speech that queued before init completed
      processQueue();
    } catch (err) {
      console.error("[MemojiAvatar] startSession failed:", err);
    }
  }, [processQueue]);

  const stopSession = useCallback(async () => {
    console.log("[MemojiAvatar] stopSession: cleaning up");
    clearQueue();
    ttsRef.current?.stop();
    avatarRef.current?.destroy();
    avatarRef.current = null;
    ttsRef.current = null;
    setIsReady(false);
    setIsSpeaking(false);
    console.log("[MemojiAvatar] stopSession: done");
  }, [clearQueue]);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      console.log(
        "[MemojiAvatar] Queued:",
        text.slice(0, 60),
        `(queue=${speechQueueRef.current.length})`,
      );
      speechQueueRef.current.push(text);
      setIsSpeaking(true);
      processQueue();
    },
    [processQueue],
  );

  const playScripted = useCallback(
    async (videoPath: string) => {
      console.log("[MemojiAvatar] playScripted:", videoPath);
      if (!avatarRef.current) {
        console.warn("[MemojiAvatar] playScripted: avatar not initialized");
        return;
      }
      // Stop any TTS and clear queue — scripted video has its own audio
      clearQueue();
      ttsRef.current?.stop();
      setIsSpeaking(true);
      await avatarRef.current.playScriptedVideo(videoPath);
      setIsSpeaking(false);
    },
    [clearQueue],
  );

  const interrupt = useCallback(() => {
    clearQueue();
    ttsRef.current?.stop();
    avatarRef.current?.idle();
    setIsSpeaking(false);
  }, [clearQueue]);

  const setAvatarState = useCallback((state: AvatarState) => {
    avatarRef.current?.setState(state);
  }, []);

  return {
    isReady,
    isSpeaking,
    startSession,
    stopSession,
    speak,
    playScripted,
    interrupt,
    clearQueue,
    setAvatarState,
    containerRef,
  };
}
