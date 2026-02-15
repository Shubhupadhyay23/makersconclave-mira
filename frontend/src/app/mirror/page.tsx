"use client";

import { Suspense } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCamera } from "@/hooks/useCamera";
import { useGestureRecognizer } from "@/hooks/useGestureRecognizer";
import { useLiveAvatar } from "@/hooks/useLiveAvatar";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { GestureIndicator } from "@/components/mirror/GestureIndicator";
import AvatarPiP from "@/components/mirror/AvatarPiP";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";
import ProductCarousel, {
  type ProductCard,
} from "@/components/mirror/ProductCarousel";
import { SentenceBuffer } from "@/lib/sentence-buffer";
import { socket } from "@/lib/socket";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { RecommendationResponse, Outfit } from "@/lib/types";

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
  const [products, setProducts] = useState<ProductCard[]>([]);

  // Recommendation state (from main)
  const [outfitData, setOutfitData] = useState<RecommendationResponse["data"] | null>(null);
  const [outfitActiveIndex, setOutfitActiveIndex] = useState(0);
  const outfits = outfitData?.outfits ?? [];

  // Avatar + voice
  const avatar = useLiveAvatar();
  const stt = useDeepgramSTT();

  // Queue transcripts while avatar is speaking, send when quiet
  const pendingTranscriptRef = useRef<string | null>(null);

  // Sentence buffer: accumulates streamed speech chunks → fires complete sentences to avatar
  const sentenceBuffer = useMemo(
    () =>
      new SentenceBuffer((sentence) => {
        avatar.speak(sentence);
      }),
    // avatar.speak is stable (useCallback), safe to depend on
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [avatar.speak],
  );

  // Auto-advance outfit carousel
  useEffect(() => {
    if (outfits.length <= 1) return;
    const timer = setInterval(() => {
      setOutfitActiveIndex((i) => (i + 1) % outfits.length);
    }, 8000);
    return () => clearInterval(timer);
  }, [outfits.length]);

  // Connect socket and join user room
  useEffect(() => {
    socket.connect();

    if (userId) {
      socket.emit("join_room", { user_id: userId });
    }

    // Recommendation events (from main)
    socket.on("outfits_ready", (result: RecommendationResponse) => {
      if (result.status === "success" && result.data) {
        setOutfitData(result.data);
        setOutfitActiveIndex(0);
      }
    });

    return () => {
      socket.off("outfits_ready");
      socket.disconnect();
    };
  }, [userId]);

  // Listen for session_active from backend
  useEffect(() => {
    const handleSessionActive = () => {
      setSessionActive(true);
      setIsStarting(false);
      avatar.startSession();
      stt.startListening();
    };

    socket.on("session_active", handleSessionActive);
    return () => {
      socket.off("session_active", handleSessionActive);
    };
    // avatar.startSession and stt.startListening are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for mira_speech events (streamed text from AI)
  useEffect(() => {
    const handleSpeech = (data: { text?: string; is_chunk?: boolean }) => {
      // Fallback session detection: if we get speech before session_active
      if (!sessionActive && !isStarting) {
        setSessionActive(true);
        setIsStarting(false);
        avatar.startSession();
        stt.startListening();
      }

      if (data.text) {
        if (data.is_chunk === false) {
          // End of message — flush remaining buffer
          sentenceBuffer.feed(data.text);
          sentenceBuffer.flush();
        } else {
          sentenceBuffer.feed(data.text);
        }
      }
    };

    socket.on("mira_speech", handleSpeech);
    return () => {
      socket.off("mira_speech", handleSpeech);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, isStarting, sentenceBuffer]);

  // Listen for tool_result events (product recommendations)
  useEffect(() => {
    const handleToolResult = (data: { tool?: string; items?: ProductCard[] }) => {
      if (data.tool === "present_items" && data.items) {
        setProducts(data.items);
      }
    };

    socket.on("tool_result", handleToolResult);
    return () => {
      socket.off("tool_result", handleToolResult);
    };
  }, []);

  // Listen for session_ended
  useEffect(() => {
    const handleSessionEnded = () => {
      avatar.stopSession();
      stt.stopListening();
      setSessionActive(false);
      setProducts([]);
    };

    socket.on("session_ended", handleSessionEnded);
    return () => {
      socket.off("session_ended", handleSessionEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send transcripts to backend when avatar stops speaking
  useEffect(() => {
    if (!avatar.isSpeaking && pendingTranscriptRef.current && userId) {
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "voice", transcript: pendingTranscriptRef.current },
      });
      pendingTranscriptRef.current = null;
    }
  }, [avatar.isSpeaking, userId]);

  // Forward final STT transcripts
  useEffect(() => {
    if (!stt.transcript || !userId) return;

    if (avatar.isSpeaking) {
      // Queue transcript until avatar is done speaking to avoid interruption
      pendingTranscriptRef.current = stt.transcript;
    } else {
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
        type: "snapshot",
        image_base64: base64,
        user_id: userId,
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

      // Forward to carousel if it exists
      const carouselGesture = (
        window as unknown as Record<string, unknown>
      ).__carouselGesture as ((g: GestureType) => void) | undefined;
      if (carouselGesture) {
        carouselGesture(gesture.type);
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
    [userId],
  );

  const { isLoading: isModelLoading, error: modelError } =
    useGestureRecognizer({
      videoRef,
      isVideoReady: isCameraReady,
      onGesture: handleGesture,
    });

  const handleProductGesture = useCallback(
    (gesture: GestureType, item: ProductCard) => {
      socket.emit("mirror_event", {
        user_id: userId,
        event: {
          type: "product_gesture",
          gesture,
          product_id: item.product_id,
          title: item.title,
        },
      });
    },
    [userId],
  );

  const handleStartSession = useCallback(() => {
    if (!userId || isStarting || sessionActive) return;

    // Unlock browser audio policy while we still have the user gesture context.
    // When session.attach() later calls play(), the browser will allow it.
    const ctx = new AudioContext();
    ctx.resume().then(() => ctx.close());

    setIsStarting(true);
    socket.emit("start_session", { user_id: userId });
  }, [userId, isStarting, sessionActive]);

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

      {/* Avatar PiP (top-right, session only) */}
      {sessionActive && (
        <AvatarPiP videoRef={avatar.avatarRef} isReady={avatar.isReady} />
      )}

      {/* Gesture visual feedback */}
      <GestureIndicator key={gestureKey} gesture={lastGesture} />

      {/* Product carousel (bottom, when products exist) */}
      {sessionActive && products.length > 0 && (
        <ProductCarousel items={products} onGesture={handleProductGesture} />
      )}

      {/* Outfit recommendation overlay (from recommendation pipeline) */}
      {outfitData && outfits.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 15,
            pointerEvents: "none",
          }}
        >
          <OutfitsView
            greeting={outfitData.greeting}
            styleAnalysis={outfitData.style_analysis}
            outfits={outfits}
            activeIndex={outfitActiveIndex}
            onDotClick={setOutfitActiveIndex}
          />
        </div>
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
          }}
        >
          Loading gesture recognition...
        </div>
      )}
    </main>
  );
}

/* ── Recommendation sub-components (from main) ── */

function OutfitsView({
  greeting,
  styleAnalysis,
  outfits,
  activeIndex,
  onDotClick,
}: {
  greeting: string;
  styleAnalysis: string;
  outfits: Outfit[];
  activeIndex: number;
  onDotClick: (i: number) => void;
}) {
  const outfit = outfits[activeIndex];
  if (!outfit) return null;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 40,
        boxSizing: "border-box",
        color: "#fff",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 22, fontWeight: 300, margin: 0 }}>{greeting}</p>
        <p style={{ fontSize: 14, opacity: 0.6, marginTop: 6 }}>
          {styleAnalysis}
        </p>
      </div>

      {/* Outfit card */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
        }}
      >
        <p
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 1,
            margin: 0,
          }}
        >
          {outfit.outfit_name}
        </p>

        {/* Items row */}
        <div
          style={{
            display: "flex",
            gap: 24,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {outfit.items.map((oi, idx) => (
            <div
              key={idx}
              style={{
                textAlign: "center",
                width: 180,
              }}
            >
              <div
                style={{
                  width: 180,
                  height: 220,
                  background: "#1a1a1a",
                  borderRadius: 8,
                  overflow: "hidden",
                  marginBottom: 8,
                }}
              >
                <img
                  src={oi.item.cleaned_image_url ?? oi.item.flat_image_url ?? oi.item.image_url}
                  alt={oi.item.title}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                  }}
                />
              </div>
              <p
                style={{
                  fontSize: 13,
                  margin: 0,
                  opacity: 0.9,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {oi.item.title}
              </p>
              <p style={{ fontSize: 13, margin: "4px 0 0", opacity: 0.6 }}>
                {oi.item.price}
              </p>
            </div>
          ))}
        </div>

        {/* Mira comment */}
        <p
          style={{
            fontSize: 15,
            fontStyle: "italic",
            opacity: 0.7,
            maxWidth: 600,
            textAlign: "center",
            margin: 0,
          }}
        >
          &ldquo;{outfit.mira_comment}&rdquo;
        </p>
      </div>

      {/* Navigation dots */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          paddingTop: 20,
          pointerEvents: "auto",
        }}
      >
        {outfits.map((_, i) => (
          <button
            key={i}
            onClick={() => onDotClick(i)}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              border: "none",
              background: i === activeIndex ? "#fff" : "rgba(255,255,255,0.3)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}
