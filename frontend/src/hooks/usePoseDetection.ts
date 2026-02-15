import { useEffect, useRef, useCallback, useState } from "react";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { PoseResult } from "@/types/pose";

interface UsePoseDetectionOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isVideoReady: boolean;
  onPoseUpdate: (result: PoseResult) => void;
}

export function usePoseDetection({
  videoRef,
  isVideoReady,
  onPoseUpdate,
}: UsePoseDetectionOptions) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameRef = useRef<number>(0);
  const videoNotReadyWarnedRef = useRef(false);
  const onPoseUpdateRef = useRef(onPoseUpdate);
  onPoseUpdateRef.current = onPoseUpdate;

  // Initialize MediaPipe Pose Landmarker
  useEffect(() => {
    let cancelled = false;

    async function initPoseLandmarker() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        if (cancelled) {
          poseLandmarker.close();
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;
        setIsLoading(false);
        console.log("[MirrorV2:Pose] Model loaded");
      } catch (err) {
        if (!cancelled) {
          console.error("[MirrorV2:Pose] Model load failed:", err);
          setError(
            err instanceof Error ? err.message : "Failed to load pose model"
          );
          setIsLoading(false);
        }
      }
    }

    initPoseLandmarker();

    return () => {
      cancelled = true;
      poseLandmarkerRef.current?.close();
      poseLandmarkerRef.current = null;
    };
  }, []);

  // Run pose detection loop
  useEffect(() => {
    if (!isVideoReady || isLoading || !poseLandmarkerRef.current) return;

    const video = videoRef.current;
    if (!video) return;

    let lastTimestamp = -1;

    function detectPose() {
      const pl = poseLandmarkerRef.current;
      if (!pl || !video || video.readyState < 2) {
        if (!videoNotReadyWarnedRef.current && video && video.readyState < 2) {
          console.warn("[MirrorV2:Pose] Video not ready, waiting...");
          videoNotReadyWarnedRef.current = true;
        }
        animFrameRef.current = requestAnimationFrame(detectPose);
        return;
      }

      const now = performance.now();
      if (now === lastTimestamp) {
        animFrameRef.current = requestAnimationFrame(detectPose);
        return;
      }
      lastTimestamp = now;

      try {
        const result = pl.detectForVideo(video, now);
        if (result.landmarks && result.landmarks.length > 0) {
          onPoseUpdateRef.current({
            landmarks: result.landmarks[0].map((lm) => ({
              x: 1 - lm.x,
              y: lm.y,
              z: lm.z,
              visibility: lm.visibility ?? 0,
            })),
            timestamp: now,
          });
        }
      } catch (err) {
        console.warn("[MirrorV2:Pose] Frame error:", err);
      }

      animFrameRef.current = requestAnimationFrame(detectPose);
    }

    animFrameRef.current = requestAnimationFrame(detectPose);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [isVideoReady, isLoading, videoRef]);

  return { isLoading, error };
}
