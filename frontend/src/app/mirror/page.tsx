"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCamera } from "@/hooks/useCamera";
import { useGestureRecognizer } from "@/hooks/useGestureRecognizer";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { useOrbAvatar } from "@/hooks/useOrbAvatar";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { parseEmotionTag } from "@/lib/emotion-parser";
import { GestureIndicator } from "@/components/mirror/GestureIndicator";
import { ClothingCanvas } from "@/components/mirror/ClothingCanvas";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";
import PriceStrip, { type PriceStripItem } from "@/components/mirror/PriceStrip";
import { socket } from "@/lib/socket";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { PoseResult } from "@/types/pose";
import type { ClothingItem } from "@/types/clothing";
import { mapToClothingItems } from "@/lib/map-clothing-items";

// Lazy-load the Orb (Three.js is heavy — don't block initial paint)
const Orb = dynamic(
  () => import("@/components/ui/orb").then((mod) => ({ default: mod.Orb })),
  { ssr: false },
);

export default function MirrorPageWrapper() {
  return (
    <Suspense fallback={null}>
      <MirrorPage />
    </Suspense>
  );
}

function MirrorPage() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("user_id");

  // Camera + gesture recognition
  const { videoRef, isReady: isCameraReady, error: cameraError } = useCamera();
  const [lastGesture, setLastGesture] = useState<GestureType | null>(null);
  const gestureKeyRef = useRef(0);
  const [gestureKey, setGestureKey] = useState(0);

  // Session state
  const [sessionActive, setSessionActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  // Pose detection + clothing overlay state
  const [currentPose, setCurrentPose] = useState<PoseResult | null>(null);

  interface CanvasOutfit {
    name: string;
    items: ClothingItem[];
    productInfo: PriceStripItem[];
  }
  const [canvasOutfits, setCanvasOutfits] = useState<CanvasOutfit[]>([]);
  const [canvasOutfitIndex, setCanvasOutfitIndex] = useState(0);
  const activeCanvasOutfit = canvasOutfits[canvasOutfitIndex]?.items ?? [];
  const activePriceItems = canvasOutfits[canvasOutfitIndex]?.productInfo ?? [];

  // Orb avatar + voice
  const orb = useOrbAvatar();
  const stt = useDeepgramSTT();

  // Queue transcripts while orb is speaking, send when quiet
  const pendingTranscriptRef = useRef<string | null>(null);

  // Accumulate full response text before delivering
  const responseAccumulatorRef = useRef<string>("");

  // Pose detection for clothing overlay
  const handlePoseUpdate = useCallback((result: PoseResult) => {
    setCurrentPose(result);
  }, []);

  usePoseDetection({
    videoRef,
    isVideoReady: isCameraReady,
    onPoseUpdate: handlePoseUpdate,
  });

  // Connect socket and join user room
  useEffect(() => {
    socket.connect();

    if (userId) {
      socket.emit("join_room", { user_id: userId });
    }

    return () => {
      socket.disconnect();
    };
  }, [userId]);

  // Listen for session_active from backend
  useEffect(() => {
    const handleSessionActive = () => {
      setSessionActive(true);
      setIsStarting(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);
      orb.startSession();
      stt.startListening();
    };

    socket.on("session_active", handleSessionActive);
    return () => {
      socket.off("session_active", handleSessionActive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for mira_speech events (streamed text from AI)
  useEffect(() => {
    const handleSpeech = (data: { text?: string; is_chunk?: boolean }) => {
      // Fallback session detection
      if (!sessionActive && !isStarting) {
        setSessionActive(true);
        setIsStarting(false);
        orb.startSession();
        stt.startListening();
      }

      if (data.is_chunk !== false) {
        // Still accumulating — skip empty chunks
        if (!data.text) return;
        console.log("[Mirror] mira_speech chunk received");
        responseAccumulatorRef.current += data.text;
        orb.setOrbState("thinking");
      } else {
        // End of message — accumulate any final text, then deliver
        if (data.text) {
          responseAccumulatorRef.current += data.text;
        }
        const fullText = responseAccumulatorRef.current;
        responseAccumulatorRef.current = "";
        console.log("[Mirror] Agent full response:", fullText);
        if (!fullText) return;

        // Parse emotion tag and stream TTS
        const { emotion, cleanText } = parseEmotionTag(fullText);
        console.log("[Mirror] Parsed emotion:", emotion);
        orb.speak(cleanText, emotion);
      }
    };

    socket.on("mira_speech", handleSpeech);
    return () => {
      socket.off("mira_speech", handleSpeech);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, isStarting]);

  // Listen for tool_result events (product recommendations + voice messages)
  useEffect(() => {
    const handleToolResult = (data: {
      type?: string;
      tool?: string;
      items?: { title: string; price?: string; [key: string]: unknown }[];
      text?: string;
      emotion?: string;
      outfit_name?: string;
    }) => {
      // display_product: flat lay items from Gemini pipeline
      if (data.type === "display_product" && data.items) {
        const clothingItems = mapToClothingItems(data.items);
        const priceInfo: PriceStripItem[] = data.items.map((it) => ({
          title: it.title,
          price: it.price,
        }));
        if (clothingItems.length > 0) {
          setCanvasOutfits((prev) => {
            const next = [...prev, {
              name: data.outfit_name || `Outfit ${prev.length + 1}`,
              items: clothingItems,
              productInfo: priceInfo,
            }];
            setCanvasOutfitIndex(next.length - 1);
            return next;
          });
        }
        return;
      }
      // voice_message: text for TTS / display
      if (data.type === "voice_message" && data.text) {
        orb.speak(data.text);
        return;
      }
    };

    socket.on("tool_result", handleToolResult);
    return () => {
      socket.off("tool_result", handleToolResult);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orb.speak]);

  // Listen for session_ended
  useEffect(() => {
    const handleSessionEnded = () => {
      orb.stopSession();
      stt.stopListening();
      setSessionActive(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);
    };

    socket.on("session_ended", handleSessionEnded);
    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send transcripts to backend when orb stops speaking
  useEffect(() => {
    if (!orb.isSpeaking && pendingTranscriptRef.current && userId) {
      console.log("[Mirror] Flushing queued transcript:", pendingTranscriptRef.current);
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "voice", transcript: pendingTranscriptRef.current },
      });
      pendingTranscriptRef.current = null;
    }
  }, [orb.isSpeaking, userId]);

  // Forward final STT transcripts
  useEffect(() => {
    if (!stt.transcript || !userId) return;

    if (orb.isSpeaking) {
      console.log("[Mirror] Queuing transcript (orb speaking):", stt.transcript);
      pendingTranscriptRef.current = stt.transcript;
    } else {
      console.log("[Mirror] Sending transcript to backend:", stt.transcript);
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "voice", transcript: stt.transcript },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stt.transcript, userId]);

  // Listen for snapshot requests from the backend
  useEffect(() => {
    const handleSnapshotRequest = () => {
      const video = videoRef.current;
      if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      const base64 = dataUrl.split(",")[1];

      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "snapshot", image_base64: base64 },
      });
    };

    socket.on("request_snapshot", handleSnapshotRequest);
    return () => {
      socket.off("request_snapshot", handleSnapshotRequest);
    };
  }, [videoRef, userId]);

  // Listen for on-demand photo requests from the orchestrator (take_photo tool)
  useEffect(() => {
    const handlePhotoRequest = () => {
      const video = videoRef.current;
      if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      const base64 = dataUrl.split(",")[1];

      socket.emit("photo_response", {
        user_id: userId,
        image_base64: base64,
      });
    };

    socket.on("request_photo", handlePhotoRequest);
    return () => {
      socket.off("request_photo", handlePhotoRequest);
    };
  }, [videoRef, userId]);

  // Gesture handler
  const handleGesture = useCallback(
    (gesture: DetectedGesture) => {
      console.log("[Mirror] Gesture detected:", gesture.type, gesture.confidence);

      setLastGesture(gesture.type);
      gestureKeyRef.current += 1;
      setGestureKey(gestureKeyRef.current);

      // Navigate canvas outfits with swipe gestures
      if (canvasOutfits.length > 1) {
        if (gesture.type === "swipe_left") {
          setCanvasOutfitIndex((i) => (i + 1) % canvasOutfits.length);
        } else if (gesture.type === "swipe_right") {
          setCanvasOutfitIndex((i) => (i - 1 + canvasOutfits.length) % canvasOutfits.length);
        }
      }

      socket.emit("mirror_event", {
        user_id: userId,
        event: {
          type: "gesture",
          gesture: gesture.type,
          confidence: gesture.confidence,
          timestamp: gesture.timestamp,
        },
      });
    },
    [userId, canvasOutfits.length],
  );

  const { isLoading: isModelLoading, error: modelError } =
    useGestureRecognizer({
      videoRef,
      isVideoReady: isCameraReady,
      onGesture: handleGesture,
    });

  const handleStartSession = useCallback(() => {
    if (!userId || isStarting || sessionActive) return;

    // Unlock browser audio policy while we still have the user gesture context
    const ctx = new AudioContext();
    ctx.resume().then(() => ctx.close());

    setIsStarting(true);
    socket.emit("start_session", { user_id: userId });
  }, [userId, isStarting, sessionActive]);

  // Context-aware orb positioning
  const orbStyle = useMemo<React.CSSProperties>(() => {
    const hasProducts = canvasOutfits.length > 0;
    if (orb.orbState === "idle") {
      return { top: 24, right: 24, width: 120, height: 120 };
    }
    if (orb.orbState === "thinking") {
      return { top: "35%", left: "50%", transform: "translateX(-50%)", width: 180, height: 180 };
    }
    if (hasProducts) {
      return { top: 24, right: 24, width: 150, height: 150 };
    }
    return { top: "25%", right: 40, width: 200, height: 200 };
  }, [orb.orbState, canvasOutfits.length]);

  return (
    <main
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        background: "#000",
        overflow: "hidden",
      }}
    >
      {/* Webcam feed (mirrored) */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />

      {/* Clothing overlay canvas */}
      {activeCanvasOutfit.length > 0 && currentPose && (
        <ClothingCanvas
          pose={currentPose}
          items={activeCanvasOutfit}
          width={1920}
          height={1080}
        />
      )}

      {/* Outfit dot indicator */}
      {canvasOutfits.length > 1 && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 8, zIndex: 18 }}>
          {canvasOutfits.map((_, i) => (
            <div key={i} style={{
              width: 10, height: 10, borderRadius: "50%",
              background: i === canvasOutfitIndex ? "#fff" : "rgba(255,255,255,0.3)",
            }} />
          ))}
        </div>
      )}

      {/* Start Session button (pre-session overlay) */}
      {!sessionActive && !isStarting && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 20,
          }}
        >
          <button
            onClick={handleStartSession}
            style={{
              padding: "16px 40px",
              fontSize: "1.3rem",
              fontWeight: 600,
              color: "#fff",
              background: "rgba(100, 140, 255, 0.8)",
              border: "none",
              borderRadius: 12,
              cursor: "pointer",
              backdropFilter: "blur(10px)",
              boxShadow: "0 4px 20px rgba(100, 140, 255, 0.4)",
            }}
          >
            Start Session
          </button>
        </div>
      )}

      {/* Starting indicator */}
      {isStarting && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#fff",
            fontSize: "1.5rem",
            zIndex: 20,
          }}
        >
          Starting...
        </div>
      )}

      {/* Orb avatar (context-aware positioning) */}
      {sessionActive && (
        <div
          style={{
            position: "absolute",
            zIndex: 10,
            borderRadius: "50%",
            overflow: "hidden",
            transition: "all 0.6s ease-in-out",
            ...orbStyle,
          }}
        >
          <Orb
            className="h-full w-full"
            volumeMode="manual"
            outputVolumeRef={orb.outputVolumeRef}
            colorsRef={orb.colorsRef}
            agentState={orb.agentState}
            seed={42}
          />
        </div>
      )}

      {/* Gesture visual feedback */}
      <GestureIndicator key={gestureKey} gesture={lastGesture} />

      {/* Price strip (bottom, when outfit active) */}
      {sessionActive && activePriceItems.length > 0 && (
        <PriceStrip items={activePriceItems} />
      )}

      {/* Voice indicator (bottom-left, session only) */}
      {sessionActive && (
        <VoiceIndicator
          isListening={stt.isListening}
          interimTranscript={stt.interimTranscript}
        />
      )}

      {/* Error indicators */}
      {(cameraError || modelError) && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
            color: "#f44",
            fontSize: "1rem",
            zIndex: 30,
          }}
        >
          {cameraError && <div>Camera: {cameraError}</div>}
          {modelError && <div>Model: {modelError}</div>}
        </div>
      )}

      {isModelLoading && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#fff",
            fontSize: "1.5rem",
            zIndex: 30,
            pointerEvents: "none",
          }}
        >
          Loading gesture recognition...
        </div>
      )}
    </main>
  );
}
