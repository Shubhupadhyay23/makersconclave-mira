"use client";

import { Suspense } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useCamera } from "@/hooks/useCamera";
import { useGestureRecognizer } from "@/hooks/useGestureRecognizer";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { useMiraVideoAvatar } from "@/hooks/useMiraVideoAvatar";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { parseEmotionTag, detectEmotionFromText } from "@/lib/emotion-parser";
import { MiraVideoAvatar } from "@/components/ui/mira-video-avatar";
import { GestureIndicator } from "@/components/mirror/GestureIndicator";
import { ClothingCanvas } from "@/components/mirror/ClothingCanvas";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";
import PriceStrip, { type PriceStripItem } from "@/components/mirror/PriceStrip";
import SessionRecap from "@/components/mirror/SessionRecap";
import { socket } from "@/lib/socket";
import { skipQueueUser } from "@/lib/api";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { PoseResult } from "@/types/pose";
import type { ClothingItem } from "@/types/clothing";
import { mapToClothingItems } from "@/lib/map-clothing-items";

type KioskState = "attract" | "waiting" | "session" | "recap";

interface ActiveUser {
  id: string;
  name: string;
}

const PHONE_URL = process.env.NEXT_PUBLIC_PHONE_URL || "https://mirrorless.vercel.app/phone";
const WAITING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export default function MirrorPageWrapper() {
  return (
    <Suspense fallback={null}>
      <MirrorPage />
    </Suspense>
  );
}

function MirrorPage() {
  // Kiosk state
  const [kioskState, setKioskState] = useState<KioskState>("attract");
  const [activeUser, setActiveUser] = useState<ActiveUser | null>(null);
  const waitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQueueRef = useRef<ActiveUser | null | undefined>(undefined);

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

  // Recap state (shown after session ends)
  const [recapData, setRecapData] = useState<{
    summary?: string;
    liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
    stats?: { items_shown: number; likes: number; dislikes: number };
    user_name?: string;
  } | null>(null);

  // Mira video avatar + voice
  const mira = useMiraVideoAvatar();
  const stt = useDeepgramSTT();

  // Queue transcripts while mira is speaking, send when quiet
  const pendingTranscriptRef = useRef<string | null>(null);

  // Accumulate full response text before delivering
  const responseAccumulatorRef = useRef<string>("");

  // Current user ID for session (from queue, not URL)
  const userId = activeUser?.id ?? null;

  // Pose detection for clothing overlay
  const handlePoseUpdate = useCallback((result: PoseResult) => {
    setCurrentPose(result);
  }, []);

  usePoseDetection({
    videoRef,
    isVideoReady: isCameraReady,
    onPoseUpdate: handlePoseUpdate,
  });

  // Connect socket and join mirror room
  useEffect(() => {
    socket.connect();
    socket.emit("join_mirror_room");

    return () => {
      socket.disconnect();
    };
  }, []);

  // Join user-specific room when active user changes
  useEffect(() => {
    if (userId) {
      socket.emit("join_room", { user_id: userId });
    }
  }, [userId]);

  // Listen for queue_updated events (drives attract ↔ waiting transitions)
  useEffect(() => {
    const handleQueueUpdated = (data: {
      active_user: ActiveUser | null;
      queue: Array<{ id: string; user_id: string; name: string; position: number; status: string }>;
    }) => {
      console.log("[Mirror] queue_updated:", data);
      if (kioskState === "session") return; // Don't interrupt active sessions

      // During recap, store the update for when recap dismisses
      if (kioskState === "recap") {
        pendingQueueRef.current = data.active_user ?? null;
        return;
      }

      if (data.active_user) {
        setActiveUser(data.active_user);
        setKioskState("waiting");
      } else {
        setActiveUser(null);
        setKioskState("attract");
      }
    };

    socket.on("queue_updated", handleQueueUpdated);
    return () => {
      socket.off("queue_updated", handleQueueUpdated);
    };
  }, [kioskState]);

  // 2-minute timeout in waiting state
  useEffect(() => {
    if (kioskState === "waiting" && activeUser) {
      waitingTimerRef.current = setTimeout(() => {
        console.log("[Mirror] Waiting timeout — auto-skipping user");
        skipQueueUser(activeUser.id).catch(() => {});
      }, WAITING_TIMEOUT_MS);
    }
    return () => {
      if (waitingTimerRef.current) {
        clearTimeout(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    };
  }, [kioskState, activeUser]);

  // Listen for session_active from backend
  useEffect(() => {
    const handleSessionActive = () => {
      setKioskState("session");
      setSessionActive(true);
      setIsStarting(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);
      mira.startSession();
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
        setKioskState("session");
        setSessionActive(true);
        setIsStarting(false);
        mira.startSession();
        stt.startListening();
      }

      if (data.is_chunk !== false) {
        if (!data.text) return;
        console.log("[Mirror] mira_speech chunk received");
        responseAccumulatorRef.current += data.text;
        mira.setOrbState("thinking");
        mira.setEmotion("thinking");
      } else {
        if (data.text) {
          responseAccumulatorRef.current += data.text;
        }
        const fullText = responseAccumulatorRef.current;
        responseAccumulatorRef.current = "";
        console.log("[Mirror] Agent full response:", fullText);
        if (!fullText) return;

        // Parse emotion tag first, then detect from content as fallback
        let { emotion, cleanText } = parseEmotionTag(fullText);

        // If no explicit emotion tag, try to detect from content
        if (emotion === "idle") {
          emotion = detectEmotionFromText(cleanText);
        }

        console.log("[Mirror] Parsed emotion:", emotion);
        mira.speak(cleanText, emotion);
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
      // voice_message type removed — TTS is handled by the mira_speech streaming path
    };

    socket.on("tool_result", handleToolResult);
    return () => {
      socket.off("tool_result", handleToolResult);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mira.speak]);

  // Listen for session_ended — show recap overlay, then return to attract
  useEffect(() => {
    const handleSessionEnded = (data?: {
      summary?: string;
      liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
      stats?: { items_shown: number; likes: number; dislikes: number };
      user_name?: string;
    }) => {
      // Don't stop mira immediately — let closing speech TTS finish playing
      stt.stopListening();
      setSessionActive(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);

      // Show recap overlay (keep activeUser set for display)
      if (data && (data.summary || data.liked_items?.length || data.stats)) {
        setRecapData(data);
        setKioskState("recap");
      } else {
        // No recap data — go straight to attract
        mira.stopSession();
        setActiveUser(null);
        setKioskState("attract");
      }
    };

    socket.on("session_ended", handleSessionEnded);
    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for session_force_end — same as session_ended
  useEffect(() => {
    const handleForceEnd = (data: { user_id?: string }) => {
      if (userId && data.user_id === userId) {
        socket.emit("end_session", { user_id: userId });
      }
    };

    socket.on("session_force_end", handleForceEnd);
    return () => {
      socket.off("session_force_end", handleForceEnd);
    };
  }, [userId]);

  // Send transcripts to backend when mira stops speaking
  useEffect(() => {
    if (!mira.isSpeaking && pendingTranscriptRef.current && userId) {
      console.log("[Mirror] Flushing queued transcript:", pendingTranscriptRef.current);
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "voice", transcript: pendingTranscriptRef.current },
      });
      pendingTranscriptRef.current = null;
    }
  }, [mira.isSpeaking, userId]);

  // Forward final STT transcripts
  useEffect(() => {
    if (!stt.transcript || !userId) return;

    if (mira.isSpeaking) {
      console.log("[Mirror] Queuing transcript (mira speaking):", stt.transcript);
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

  // Gesture handler
  const handleGesture = useCallback(
    (gesture: DetectedGesture) => {
      console.log("[Mirror] Gesture detected:", gesture.type, gesture.confidence);

      setLastGesture(gesture.type);
      gestureKeyRef.current += 1;
      setGestureKey(gestureKeyRef.current);

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

    // Emit start via socket (server-side orchestrator)
    socket.emit("start_session", { user_id: userId });
  }, [userId, isStarting, sessionActive]);

  const handleSkipUser = useCallback(() => {
    if (!activeUser) return;
    skipQueueUser(activeUser.id).catch(() => {});
  }, [activeUser]);

  // Dismiss recap overlay — transition to next queued user or attract
  const handleRecapDismiss = useCallback(() => {
    mira.stopSession();
    setRecapData(null);

    // Check if a queue_updated arrived during recap
    const pending = pendingQueueRef.current;
    pendingQueueRef.current = undefined;

    if (pending) {
      setActiveUser(pending);
      setKioskState("waiting");
    } else {
      setActiveUser(null);
      setKioskState("attract");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {/* === ATTRACT STATE === */}
      {kioskState === "attract" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(20px)",
          }}
        >
          <h1
            style={{
              color: "#fff",
              fontSize: "3rem",
              fontWeight: 700,
              marginBottom: 8,
              letterSpacing: "-0.02em",
            }}
          >
            Mirrorless
          </h1>
          <p style={{ color: "rgba(255,255,255,0.6)", fontSize: "1.2rem", marginBottom: 40 }}>
            Your AI stylist
          </p>

          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: 20,
              marginBottom: 24,
            }}
          >
            <QRCodeSVG
              value={PHONE_URL}
              size={180}
              level="M"
              includeMargin={false}
            />
          </div>

          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.9rem" }}>
            Scan the QR code with your phone
          </p>
        </div>
      )}

      {/* === WAITING STATE === */}
      {kioskState === "waiting" && activeUser && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(10px)",
          }}
        >
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "1rem", marginBottom: 8 }}>
            Up next
          </p>
          <h2 style={{ color: "#fff", fontSize: "2.5rem", fontWeight: 700, marginBottom: 40 }}>
            {activeUser.name}
          </h2>
          <div style={{ display: "flex", gap: 16 }}>
            <button
              onClick={handleStartSession}
              disabled={isStarting}
              style={{
                padding: "16px 48px",
                fontSize: "1.2rem",
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
              {isStarting ? "Starting..." : "Start Session"}
            </button>
            <button
              onClick={handleSkipUser}
              style={{
                padding: "16px 32px",
                fontSize: "1.2rem",
                fontWeight: 600,
                color: "#fff",
                background: "rgba(255, 255, 255, 0.15)",
                border: "1px solid rgba(255,255,255,0.3)",
                borderRadius: 12,
                cursor: "pointer",
                backdropFilter: "blur(10px)",
              }}
            >
              Skip
            </button>
          </div>
          <WaitingCountdown />
        </div>
      )}

      {/* === SESSION STATE === */}

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

      {/* Mira Video Avatar (fixed top-right corner) */}
      {sessionActive && (
        <div
          style={{
            position: "absolute",
            top: 24,
            right: 24,
            zIndex: 10,
          }}
        >
          <MiraVideoAvatar
            emotion={mira.emotion}
            state={mira.avatarState}
            size={180}
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

      {/* === RECAP STATE === */}
      {recapData && (
        <SessionRecap
          summary={recapData.summary}
          likedItems={recapData.liked_items || []}
          stats={recapData.stats}
          userName={recapData.user_name}
          onDismiss={handleRecapDismiss}
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

/* ---------- Waiting Countdown ---------- */

function WaitingCountdown() {
  const [remaining, setRemaining] = useState(120);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((s) => {
        if (s <= 0) return 0;
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: "0.9rem", marginTop: 24 }}>
      Auto-skip in {minutes}:{String(seconds).padStart(2, "0")}
    </p>
  );
}
