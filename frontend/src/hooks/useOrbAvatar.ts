"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StreamingTTS } from "@/lib/streaming-tts";
import type { AgentState } from "@/components/ui/orb";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";
export type MiraEmotion = "idle" | "neutral" | "proud" | "teasing";

const EMOTION_COLORS: Record<MiraEmotion, [string, string]> = {
  idle: ["#F0F0F5", "#E8E8EE"],
  neutral: ["#F5E6A0", "#E8D680"],
  proud: ["#4A6FA5", "#3A5C8C"],
  teasing: ["#FFF3B0", "#FFE580"],
};

/** Map OrbState to the Orb component's agentState prop. */
function toAgentState(state: OrbState): AgentState {
  switch (state) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "talking";
    default:
      return null;
  }
}

export interface UseOrbAvatarReturn {
  orbState: OrbState;
  agentState: AgentState;
  colors: [string, string];
  colorsRef: React.RefObject<[string, string]>;
  outputVolumeRef: React.RefObject<number>;
  getOutputVolume: () => number;
  speak: (text: string, emotion?: MiraEmotion) => void;
  setOrbState: (state: OrbState) => void;
  stop: () => void;
  isSpeaking: boolean;
  startSession: () => void;
  stopSession: () => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export function useOrbAvatar(): UseOrbAvatarReturn {
  const [orbState, setOrbStateInternal] = useState<OrbState>("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [colors, setColors] = useState<[string, string]>(EMOTION_COLORS.idle);

  const colorsRef = useRef<[string, string]>(EMOTION_COLORS.idle);
  const outputVolumeRef = useRef<number>(0);
  const ttsRef = useRef<StreamingTTS | null>(null);
  const rafIdRef = useRef<number>(0);

  // Volume polling loop — reads from TTS analyser, writes to ref for Orb
  const startVolumeLoop = useCallback(() => {
    const tick = () => {
      const tts = ttsRef.current;
      outputVolumeRef.current = tts ? tts.getOutputVolume() : 0;
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const stopVolumeLoop = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    outputVolumeRef.current = 0;
  }, []);

  const setOrbState = useCallback((state: OrbState) => {
    setOrbStateInternal(state);
  }, []);

  const updateColors = useCallback((emotion: MiraEmotion) => {
    const c = EMOTION_COLORS[emotion] ?? EMOTION_COLORS.neutral;
    colorsRef.current = c;
    setColors(c);
  }, []);

  const speak = useCallback(
    (text: string, emotion: MiraEmotion = "neutral") => {
      if (!text.trim() || !ttsRef.current) return;

      updateColors(emotion);
      setIsSpeaking(true);
      setOrbStateInternal("speaking");

      console.log(`[OrbAvatar] Speaking (emotion=${emotion}):`, text.slice(0, 80));

      ttsRef.current
        .speak(
          text,
          () => {
            // onStart — audio playback has begun
            console.log("[OrbAvatar] Playback started");
          },
          () => {
            // onEnd — audio playback finished
            console.log("[OrbAvatar] Playback finished");
            setIsSpeaking(false);
            setOrbStateInternal("idle");
            updateColors("idle");
          },
        )
        .catch(() => {
          setIsSpeaking(false);
          setOrbStateInternal("idle");
          updateColors("idle");
        });
    },
    [updateColors],
  );

  const stop = useCallback(() => {
    ttsRef.current?.stop();
    setIsSpeaking(false);
    setOrbStateInternal("idle");
    updateColors("idle");
  }, [updateColors]);

  const startSession = useCallback(() => {
    if (ttsRef.current) return;
    const tts = new StreamingTTS(API_URL);
    ttsRef.current = tts;
    startVolumeLoop();
    console.log("[OrbAvatar] Session started");
  }, [startVolumeLoop]);

  const stopSession = useCallback(() => {
    stopVolumeLoop();
    ttsRef.current?.destroy();
    ttsRef.current = null;
    setIsSpeaking(false);
    setOrbStateInternal("idle");
    updateColors("idle");
    console.log("[OrbAvatar] Session stopped");
  }, [stopVolumeLoop, updateColors]);

  const getOutputVolume = useCallback(() => {
    return ttsRef.current?.getOutputVolume() ?? 0;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      ttsRef.current?.destroy();
      ttsRef.current = null;
    };
  }, []);

  return {
    orbState,
    agentState: toAgentState(orbState),
    colors,
    colorsRef,
    outputVolumeRef,
    getOutputVolume,
    speak,
    setOrbState,
    stop,
    isSpeaking,
    startSession,
    stopSession,
  };
}
