import { useEffect, useRef, useState } from "react";
import {
  GestureRecognizer,
  FilesetResolver,
} from "@mediapipe/tasks-vision";
import {
  createSwipeState,
  detectSwipe,
  classifyBuiltInGesture,
} from "@/lib/gesture-classifier";
import type { DetectedGesture, SwipeState } from "@/types/gestures";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

interface UseGestureRecognizerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isVideoReady: boolean;
  onGesture: (gesture: DetectedGesture) => void;
}

export function useGestureRecognizer({
  videoRef,
  isVideoReady,
  onGesture,
}: UseGestureRecognizerOptions) {
  const recognizerRef = useRef<GestureRecognizer | null>(null);
  const swipeStateRef = useRef<SwipeState>(createSwipeState());
  const rafRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;

  // Initialize MediaPipe GestureRecognizer
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        if (cancelled) return;

        const recognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        if (cancelled) {
          recognizer.close();
          return;
        }

        recognizerRef.current = recognizer;
        setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load gesture model"
          );
          setIsLoading(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      recognizerRef.current?.close();
      recognizerRef.current = null;
    };
  }, []);

  // Run recognition loop
  useEffect(() => {
    if (!isVideoReady || isLoading || !recognizerRef.current) return;

    function processFrame() {
      const video = videoRef.current;
      const recognizer = recognizerRef.current;

      if (!video || !recognizer || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(processFrame);
        return;
      }

      if (video.currentTime === lastVideoTimeRef.current) {
        rafRef.current = requestAnimationFrame(processFrame);
        return;
      }
      lastVideoTimeRef.current = video.currentTime;

      const now = performance.now();
      const result = recognizer.recognizeForVideo(video, now);

      // Check built-in gestures (thumbs up/down)
      if (result.gestures.length > 0 && result.gestures[0].length > 0) {
        const topGesture = result.gestures[0][0];
        const detected = classifyBuiltInGesture(
          topGesture.categoryName,
          topGesture.score,
          now
        );
        if (detected) {
          onGestureRef.current(detected);
        }
      }

      // Check swipe via landmark tracking (wrist = landmark 0)
      if (result.landmarks.length > 0 && result.landmarks[0].length > 0) {
        const wrist = result.landmarks[0][0];
        const swipe = detectSwipe(swipeStateRef.current, wrist.x, now);
        if (swipe) {
          onGestureRef.current(swipe);
        }
      }

      rafRef.current = requestAnimationFrame(processFrame);
    }

    rafRef.current = requestAnimationFrame(processFrame);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [isVideoReady, isLoading, videoRef]);

  return { isLoading, error };
}
