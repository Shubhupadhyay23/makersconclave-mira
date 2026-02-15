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
import { ClothingCanvas, type FitMethod } from "@/components/mirror/ClothingCanvas";
import { DebugOverlay } from "@/components/mirror/DebugOverlay";
import { SpeechDisplay } from "@/components/mirror/SpeechDisplay";
import { OutfitDots } from "@/components/mirror/OutfitDots";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";
import PriceStrip, { type PriceStripItem } from "@/components/mirror/PriceStrip";
import SessionRecap from "@/components/mirror/SessionRecap";
import { socket } from "@/lib/socket";
import { skipQueueUser } from "@/lib/api";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { PoseResult } from "@/types/pose";
import type { ClothingItem } from "@/types/clothing";
import ProductCarousel, { type ProductCard } from "@/components/mirror/ProductCarousel";
import { processToolResult } from "@/lib/process-tool-result";

type KioskState = "attract" | "waiting" | "session" | "recap";

interface ActiveUser {
  id: string;
  name: string;
}

const PHONE_URL = process.env.NEXT_PUBLIC_PHONE_URL || "https://mirrorless.vercel.app/phone";
const WAITING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

export default function MirrorV2PageWrapper() {
  return (
    <Suspense fallback={null}>
      <MirrorV2Page />
    </Suspense>
  );
}

function MirrorV2Page() {
  // ── Kiosk state ──
  const [kioskState, setKioskState] = useState<KioskState>("attract");
  const [activeUser, setActiveUser] = useState<ActiveUser | null>(null);
  const waitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQueueRef = useRef<ActiveUser | null | undefined>(undefined);

  // ── Camera (hidden, 1080p for better pose accuracy) ──
  const { videoRef, isReady: isCameraReady } = useCamera();

  // ── Gesture recognition ──
  const [lastGesture, setLastGesture] = useState<GestureType | null>(null);
  const gestureKeyRef = useRef(0);
  const [gestureKey, setGestureKey] = useState(0);

  // ── Session state ──
  const [sessionActive, setSessionActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  // ── Pose detection + clothing overlay ──
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

  // ── Outfit opacity for fade-in ──
  const [outfitOpacity, setOutfitOpacity] = useState(1);

  // ── Product carousel (fallback when no flat lays / from present_items) ──
  const [carouselItems, setCarouselItems] = useState<ProductCard[]>([]);

  // ── Debug overlay ──
  const [debugMode, setDebugMode] = useState(false);

  // ── Fit status tracking ──
  const [fitStatuses, setFitStatuses] = useState<Map<string, FitMethod>>(new Map());

  // ── Recap state ──
  const [recapData, setRecapData] = useState<{
    summary?: string;
    liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
    stats?: { items_shown: number; likes: number; dislikes: number };
    user_name?: string;
  } | null>(null);

  // ── Mira video avatar + voice ──
  const mira = useMiraVideoAvatar();
  const stt = useDeepgramSTT();

  // ── Speech display state ──
  const [speechText, setSpeechText] = useState("");
  const [speechVisible, setSpeechVisible] = useState(false);
  const speechFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Queue transcripts while mira is speaking, send when quiet
  const pendingTranscriptRef = useRef<string | null>(null);

  // Sentence buffer for incremental TTS — flushes at sentence boundaries
  const sentenceBufferRef = useRef<string>("");
  // Track emotion for the current response (parsed from first chunk)
  const currentEmotionRef = useRef<string>("idle");
  // Track whether emotion has been parsed for this response
  const emotionParsedRef = useRef(false);

  // Track whether we just interrupted Mira (ignore stale mira_speech chunks)
  const interruptedRef = useRef(false);

  // Current user ID for session
  const userId = activeUser?.id ?? null;

  // ── Log kiosk state transitions ──
  useEffect(() => {
    console.log("[MirrorV2:State]", kioskState, activeUser ? `user=${activeUser.name}` : "");
  }, [kioskState, activeUser]);

  // ── Pose detection callback ──
  const handlePoseUpdate = useCallback((result: PoseResult) => {
    setCurrentPose(result);
  }, []);

  usePoseDetection({
    videoRef,
    isVideoReady: isCameraReady,
    onPoseUpdate: handlePoseUpdate,
  });

  // ── Fit status callback ──
  const handleFitStatus = useCallback((statuses: Map<string, FitMethod>) => {
    setFitStatuses(statuses);
  }, []);

  // ── Connect socket and join mirror room ──
  useEffect(() => {
    socket.connect();
    socket.emit("join_mirror_room");

    const onConnect = () => console.log("[MirrorV2:Socket] Connected, id:", socket.id);
    const onConnectError = (err: Error) => console.error("[MirrorV2:Socket] Connection error:", err.message);
    const onDisconnect = (reason: string) => console.warn("[MirrorV2:Socket] Disconnected:", reason);

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.disconnect();
    };
  }, []);

  // Join user-specific room when active user changes
  useEffect(() => {
    if (userId) {
      socket.emit("join_room", { user_id: userId });
    }
  }, [userId]);

  // ── Queue events (drives attract <-> waiting) ──
  useEffect(() => {
    const handleQueueUpdated = (data: {
      active_user: ActiveUser | null;
      queue: Array<{ id: string; user_id: string; name: string; position: number; status: string }>;
    }) => {
      console.log("[MirrorV2] queue_updated:", data);
      if (kioskState === "session") return;

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

  // ── 2-minute timeout in waiting state ──
  useEffect(() => {
    if (kioskState === "waiting" && activeUser) {
      waitingTimerRef.current = setTimeout(() => {
        console.log("[MirrorV2] Waiting timeout — auto-skipping user");
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

  // ── Session active from backend ──
  useEffect(() => {
    const handleSessionActive = () => {
      setKioskState("session");
      setSessionActive(true);
      setIsStarting(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);
      setCarouselItems([]);
      setOutfitOpacity(1);
      setSpeechText("");
      setSpeechVisible(false);
      mira.startSession();
      stt.startListening();
    };

    socket.on("session_active", handleSessionActive);
    return () => {
      socket.off("session_active", handleSessionActive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mira speech events (sentence-level streaming) ──
  useEffect(() => {
    // Regex for sentence boundaries: .!? followed by a space or end of string
    const SENTENCE_BOUNDARY = /[.!?](?:\s|$)/;

    /**
     * Flush complete sentences from the buffer to TTS.
     * Returns any remaining partial sentence left in the buffer.
     */
    function flushSentences(buffer: string, emotion: string): string {
      let remaining = buffer;

      while (true) {
        const match = SENTENCE_BOUNDARY.exec(remaining);
        if (!match) break;

        // Split at the sentence boundary (include the punctuation)
        const endIdx = match.index + match[0].length;
        const sentence = remaining.slice(0, endIdx).trim();
        remaining = remaining.slice(endIdx);

        if (sentence) {
          mira.speakQueued(sentence, emotion as ReturnType<typeof parseEmotionTag>["emotion"]);

          // Show sentence on screen immediately
          setSpeechText(sentence);
          setSpeechVisible(true);
          if (speechFadeTimerRef.current) {
            clearTimeout(speechFadeTimerRef.current);
          }
        }
      }

      return remaining;
    }

    const handleSpeech = (data: { text?: string; is_chunk?: boolean }) => {
      // Ignore stale chunks from the pre-interrupt response
      if (interruptedRef.current) {
        if (data.is_chunk === false) {
          interruptedRef.current = false; // Old response ended
        }
        return;
      }

      // Fallback session detection
      if (!sessionActive && !isStarting) {
        setKioskState("session");
        setSessionActive(true);
        setIsStarting(false);
        mira.startSession();
        stt.startListening();
      }

      if (data.is_chunk !== false) {
        // ── Streaming chunk ──
        if (!data.text) return;

        sentenceBufferRef.current += data.text;

        // Parse emotion from first chunk (where [emotion:X] tag appears)
        if (!emotionParsedRef.current) {
          const { emotion, cleanText } = parseEmotionTag(sentenceBufferRef.current);
          if (emotion !== "idle") {
            currentEmotionRef.current = emotion;
            emotionParsedRef.current = true;
            sentenceBufferRef.current = cleanText;
          } else {
            // Try keyword detection on accumulated text
            const detected = detectEmotionFromText(sentenceBufferRef.current);
            if (detected !== "idle") {
              currentEmotionRef.current = detected;
              emotionParsedRef.current = true;
            }
          }
        }

        // Flush any complete sentences to TTS immediately
        sentenceBufferRef.current = flushSentences(
          sentenceBufferRef.current,
          currentEmotionRef.current,
        );
      } else {
        // ── End of message ──
        if (data.text) {
          sentenceBufferRef.current += data.text;
        }

        // Parse emotion if we haven't yet (short responses)
        if (!emotionParsedRef.current) {
          const { emotion, cleanText } = parseEmotionTag(sentenceBufferRef.current);
          currentEmotionRef.current = emotion === "idle"
            ? detectEmotionFromText(sentenceBufferRef.current)
            : emotion;
          sentenceBufferRef.current = emotion !== "idle" ? cleanText : sentenceBufferRef.current;
        }

        // Flush any remaining text as the final sentence
        const remainder = sentenceBufferRef.current.trim();
        if (remainder) {
          mira.speakQueued(remainder, currentEmotionRef.current as ReturnType<typeof parseEmotionTag>["emotion"]);
          setSpeechText(remainder);
          setSpeechVisible(true);
          if (speechFadeTimerRef.current) {
            clearTimeout(speechFadeTimerRef.current);
          }
        }

        // Signal end of queue — drain callback will reset avatar state
        mira.flushQueue();

        // Reset for next response
        sentenceBufferRef.current = "";
        currentEmotionRef.current = "idle";
        emotionParsedRef.current = false;
      }
    };

    socket.on("mira_speech", handleSpeech);
    return () => {
      socket.off("mira_speech", handleSpeech);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, isStarting]);

  // Fade out speech text 2s after mira stops speaking
  useEffect(() => {
    if (!mira.isSpeaking && speechVisible) {
      speechFadeTimerRef.current = setTimeout(() => {
        setSpeechVisible(false);
      }, 2000);
    }
    return () => {
      if (speechFadeTimerRef.current) {
        clearTimeout(speechFadeTimerRef.current);
        speechFadeTimerRef.current = null;
      }
    };
  }, [mira.isSpeaking, speechVisible]);

  // ── Tool result events (product recommendations) ──
  useEffect(() => {
    const handleToolResult = (data: {
      type?: string;
      tool?: string;
      items?: { title: string; price?: string; [key: string]: unknown }[];
      text?: string;
      emotion?: string;
      outfit_name?: string;
    }) => {
      const result = processToolResult(data);
      if (!result) {
        console.warn("[MirrorV2:ToolResult] Ignored — processToolResult returned null for:", data.type, data);
        return;
      }
      console.log("[MirrorV2:ToolResult] Processed:", data.type, "canvas:", result.canvasItems.length, "carousel:", result.carouselCards.length);

      // Always show carousel cards (doesn't need pose detection)
      if (result.carouselCards.length > 0) {
        setCarouselItems(result.carouselCards);
      }

      // Additionally populate canvas overlay (renders when pose available)
      if (result.canvasItems.length > 0) {
        setOutfitOpacity(0);
        setCanvasOutfits((prev) => {
          const next = [
            ...prev,
            {
              name: result.outfitName || `Outfit ${prev.length + 1}`,
              items: result.canvasItems,
              productInfo: result.priceInfo,
            },
          ];
          setCanvasOutfitIndex(next.length - 1);
          return next;
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setOutfitOpacity(1);
          });
        });
      }
    };

    socket.on("tool_result", handleToolResult);
    return () => {
      socket.off("tool_result", handleToolResult);
    };
  }, []);

  // ── Session ended — show recap ──
  useEffect(() => {
    const handleSessionEnded = (data?: {
      summary?: string;
      liked_items?: Array<{ title: string; price?: string; image_url?: string }>;
      stats?: { items_shown: number; likes: number; dislikes: number };
      user_name?: string;
    }) => {
      stt.stopListening();
      setSessionActive(false);
      setCanvasOutfits([]);
      setCanvasOutfitIndex(0);
      setCarouselItems([]);
      setSpeechText("");
      setSpeechVisible(false);

      if (data && (data.summary || data.liked_items?.length || data.stats)) {
        setRecapData(data);
        setKioskState("recap");
      } else {
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

  // ── Force end from admin ──
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

  // ── Flush queued transcripts when mira stops speaking ──
  useEffect(() => {
    if (!mira.isSpeaking && pendingTranscriptRef.current && userId) {
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "voice", transcript: pendingTranscriptRef.current },
      });
      pendingTranscriptRef.current = null;
    }
  }, [mira.isSpeaking, userId]);

  // ── Forward final STT transcripts (interrupt Mira if speaking) ──
  useEffect(() => {
    if (!stt.transcript || !userId) return;

    if (mira.isSpeaking) {
      // INTERRUPT: stop TTS/avatar and tell backend to abort the stream
      mira.stop();
      interruptedRef.current = true;
      sentenceBufferRef.current = "";
      currentEmotionRef.current = "idle";
      emotionParsedRef.current = false;
      setSpeechText("");
      setSpeechVisible(false);
      socket.emit("interrupt", { user_id: userId });
    }

    // Always send transcript immediately (whether interrupting or not)
    socket.emit("mirror_event", {
      user_id: userId,
      event: { type: "voice", transcript: stt.transcript },
    });
    pendingTranscriptRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stt.transcript, userId]);

  // ── Snapshot handler ──
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

  // ── Gesture handler ──
  const handleGesture = useCallback(
    (gesture: DetectedGesture) => {
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

  useGestureRecognizer({
    videoRef,
    isVideoReady: isCameraReady,
    onGesture: handleGesture,
  });

  // ── Keyboard shortcuts ──
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case "d":
        case "D":
          setDebugMode((d) => !d);
          break;

        case "f":
        case "F":
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            document.documentElement.requestFullscreen();
          }
          break;

        case "ArrowLeft":
          if (canvasOutfits.length > 1) {
            setCanvasOutfitIndex((i) => (i - 1 + canvasOutfits.length) % canvasOutfits.length);
          }
          break;

        case "ArrowRight":
          if (canvasOutfits.length > 1) {
            setCanvasOutfitIndex((i) => (i + 1) % canvasOutfits.length);
          }
          break;

        case "r":
        case "R":
          setCanvasOutfitIndex(0);
          break;

        default: {
          const num = parseInt(e.key);
          if (num >= 1 && num <= 9 && num - 1 < canvasOutfits.length) {
            setCanvasOutfitIndex(num - 1);
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canvasOutfits.length]);

  // ── Start session handler ──
  const handleStartSession = useCallback(() => {
    if (!userId || isStarting || sessionActive) return;

    // Unlock browser audio policy while we still have the user gesture context
    const ctx = new AudioContext();
    ctx.resume().then(() => ctx.close());

    setIsStarting(true);
    socket.emit("start_session", { user_id: userId });
  }, [userId, isStarting, sessionActive]);

  const handleSkipUser = useCallback(() => {
    if (!activeUser) return;
    skipQueueUser(activeUser.id).catch(() => {});
  }, [activeUser]);

  // ── Carousel gesture callback ──
  const handleCarouselGesture = useCallback(
    (gesture: GestureType, item: ProductCard) => {
      socket.emit("mirror_event", {
        user_id: userId,
        event: {
          type: "gesture",
          gesture,
          product_id: item.product_id,
          product_title: item.title,
        },
      });
    },
    [userId],
  );

  // ── Dismiss recap ──
  const handleRecapDismiss = useCallback(() => {
    mira.stopSession();
    setRecapData(null);

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
      {/* Hidden camera feed (1x1 pixel, invisible — only used for pose detection) */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
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
            background: "#000",
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
            background: "#000",
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
              }}
            >
              Skip
            </button>
          </div>
          <WaitingCountdown />
        </div>
      )}

      {/* === SESSION STATE === */}

      {/* Clothing overlay canvas (z-5) */}
      {activeCanvasOutfit.length > 0 && currentPose && (
        <div style={{ position: "absolute", inset: 0, zIndex: 5, transition: "opacity 500ms ease", opacity: outfitOpacity }}>
          <ClothingCanvas
            pose={currentPose}
            items={activeCanvasOutfit}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onFitStatus={handleFitStatus}
          />
        </div>
      )}

      {/* Debug overlay (z-6, toggle with 'd') */}
      <div style={{ position: "absolute", inset: 0, zIndex: 6 }}>
        <DebugOverlay
          pose={currentPose}
          items={activeCanvasOutfit}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          visible={debugMode}
        />
      </div>

      {/* Mira Video Avatar (z-10, top-right corner) */}
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

      {/* Speech display (z-10, bottom-center, above price strip) */}
      {sessionActive && (
        <SpeechDisplay text={speechText} visible={speechVisible} />
      )}

      {/* Product carousel (z-10, bottom) — hidden when canvas overlay is active on body */}
      {sessionActive && carouselItems.length > 0 && !(activeCanvasOutfit.length > 0 && currentPose) && (
        <ProductCarousel items={carouselItems} onGesture={handleCarouselGesture} />
      )}

      {/* Price strip (z-15, bottom) — shows when canvas overlay is active */}
      {sessionActive && activePriceItems.length > 0 && activeCanvasOutfit.length > 0 && currentPose && (
        <PriceStrip items={activePriceItems} />
      )}

      {/* Outfit dots (z-18, bottom) */}
      <OutfitDots count={canvasOutfits.length} activeIndex={canvasOutfitIndex} />

      {/* Voice indicator for user STT (z-15, bottom-left) */}
      {sessionActive && (
        <VoiceIndicator
          isListening={stt.isListening}
          interimTranscript={stt.interimTranscript}
        />
      )}

      {/* Gesture visual feedback (z-20, center) */}
      <GestureIndicator key={gestureKey} gesture={lastGesture} />

      {/* === RECAP STATE === (z-25) */}
      {recapData && (
        <SessionRecap
          summary={recapData.summary}
          likedItems={recapData.liked_items || []}
          stats={recapData.stats}
          userName={recapData.user_name}
          onDismiss={handleRecapDismiss}
        />
      )}

      {/* Fit status indicator (bottom-right, debug-only) */}
      {debugMode && fitStatuses.size > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            padding: "8px 12px",
            background: "rgba(0,0,0,0.7)",
            borderRadius: 8,
            color: "#fff",
            fontSize: "0.75rem",
            zIndex: 30,
            fontFamily: "monospace",
          }}
        >
          {Array.from(fitStatuses.entries()).map(([id, method]) => (
            <div key={id}>
              {id.slice(0, 8)}: {method === "precise" ? "anchor" : "quad"}
            </div>
          ))}
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
