"use client";

import { Suspense } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCamera } from "@/hooks/useCamera";
import { useGestureRecognizer } from "@/hooks/useGestureRecognizer";
import { useMemojiAvatar } from "@/hooks/useMemojiAvatar";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { GestureIndicator } from "@/components/mirror/GestureIndicator";
import { ClothingCanvas } from "@/components/mirror/ClothingCanvas";
import AvatarPiP from "@/components/mirror/AvatarPiP";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";
import PriceStrip, { type PriceStripItem } from "@/components/mirror/PriceStrip";
import { SentenceBuffer } from "@/lib/sentence-buffer";
import { findScriptedResponse, detectEmotion } from "@/lib/scripted-responses";
import { socket } from "@/lib/socket";
import type { DetectedGesture, GestureType } from "@/types/gestures";
import type { PoseResult } from "@/types/pose";
import type { ClothingItem } from "@/types/clothing";
import { mapToClothingItems } from "@/lib/map-clothing-items";

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
  const [voiceMessage, setVoiceMessage] = useState<{ text: string; emotion: string } | null>(null);

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

  // Avatar + voice
  const avatar = useMemojiAvatar();
  const stt = useDeepgramSTT();

  // Queue transcripts while avatar is speaking, send when quiet
  const pendingTranscriptRef = useRef<string | null>(null);

  // Accumulate full response text before deciding delivery method
  const responseAccumulatorRef = useRef<string>("");

  // Stash remaining text after a scripted video; drained when video ends
  const pendingTTSAfterScriptedRef = useRef<string | null>(null);

  // Sentence buffer: used for non-scripted responses (TTS path)
  const sentenceBuffer = useMemo(
    () =>
      new SentenceBuffer((sentence) => {
        avatar.speak(sentence);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [avatar.speak],
  );

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
      avatar.startSession();
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
        avatar.startSession();
        stt.startListening();
      }

      if (data.is_chunk !== false) {
        // Still accumulating — skip empty chunks
        if (!data.text) return;
        console.log("[Mirror] mira_speech chunk received");
        responseAccumulatorRef.current += data.text;
        avatar.setAvatarState("thinking");
      } else {
        // New complete message arrived — discard any stale pending TTS
        pendingTTSAfterScriptedRef.current = null;
        // End of message — accumulate any final text, then deliver
        if (data.text) {
          responseAccumulatorRef.current += data.text;
        }
        const fullText = responseAccumulatorRef.current;
        responseAccumulatorRef.current = "";
        console.log("[Mirror] Agent full response:", fullText);
        if (!fullText) return;

        // Check for scripted response match
        const scripted = findScriptedResponse(fullText);

        if (scripted) {
          // Play pre-recorded video, then TTS any remaining text
          console.log("[Mirror] Scripted match:", scripted.phrase);
          const phraseIdx = fullText.toLowerCase().indexOf(scripted.phrase);
          const afterPhrase = phraseIdx >= 0
            ? fullText.slice(phraseIdx + scripted.phrase.length).trim()
            : "";
          if (afterPhrase) {
            pendingTTSAfterScriptedRef.current = afterPhrase;
            console.log("[Mirror] Pending TTS after scripted:", afterPhrase.slice(0, 80));
          }
          avatar.playScripted(scripted.video);
        } else {
          // No match — detect emotion for avatar state, then TTS per sentence
          const emotion = detectEmotion(fullText);
          avatar.setAvatarState(emotion);

          // Feed full text through sentence buffer for per-sentence TTS
          sentenceBuffer.feed(fullText);
          sentenceBuffer.flush();
        }
      }
    };

    socket.on("mira_speech", handleSpeech);
    return () => {
      socket.off("mira_speech", handleSpeech);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, isStarting, sentenceBuffer]);

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
        setVoiceMessage({ text: data.text, emotion: data.emotion ?? "neutral" });
        avatar.speak(data.text);
        return;
      }
    };

    socket.on("tool_result", handleToolResult);
    return () => {
      socket.off("tool_result", handleToolResult);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar.speak]);

  // Listen for session_ended
  useEffect(() => {
    const handleSessionEnded = () => {
      avatar.stopSession();
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

  // Drain pending TTS text after a scripted video finishes playing
  useEffect(() => {
    if (!avatar.isSpeaking && pendingTTSAfterScriptedRef.current) {
      const text = pendingTTSAfterScriptedRef.current;
      pendingTTSAfterScriptedRef.current = null;
      console.log("[Mirror] Draining pending TTS after scripted:", text.slice(0, 80));
      const emotion = detectEmotion(text);
      avatar.setAvatarState(emotion);
      sentenceBuffer.feed(text);
      sentenceBuffer.flush();
    }
  }, [avatar.isSpeaking, avatar.setAvatarState, sentenceBuffer]);

  // Send transcripts to backend when avatar stops speaking
  useEffect(() => {
    if (!avatar.isSpeaking && pendingTranscriptRef.current && userId) {
      console.log("[Mirror] Flushing queued transcript:", pendingTranscriptRef.current);
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
      console.log("[Mirror] Queuing transcript (avatar speaking):", stt.transcript);
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

      {/* Avatar PiP (top-right, always mounted so ref stays alive) */}
      <AvatarPiP containerRef={avatar.containerRef} isReady={avatar.isReady} visible={sessionActive} />

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

