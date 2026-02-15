import { useEffect, useRef, useState } from "react";

interface UseCameraResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isReady: boolean;
  error: string | null;
}

/**
 * Detect if the camera feed is a stereo/dual-lens camera (side-by-side layout).
 * Stereo cameras typically output ~2:1 aspect ratio (e.g. 2560x960).
 */
function isStereoCamera(video: HTMLVideoElement): boolean {
  const aspectRatio = video.videoWidth / video.videoHeight;
  // Side-by-side stereo cameras have ~2.67:1 aspect ratio (2560/960)
  // Normal cameras are ~1.78:1 (16:9) or ~1.33:1 (4:3)
  return aspectRatio > 2.2;
}

export function useCamera(): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rawVideoRef = useRef<HTMLVideoElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropFrameRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        // Request high resolution to accommodate stereo cameras
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 2560 },
            height: { ideal: 960 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        // Create a hidden raw video element to receive the camera stream
        const rawVideo = document.createElement("video");
        rawVideo.setAttribute("autoplay", "");
        rawVideo.setAttribute("playsinline", "");
        rawVideo.setAttribute("muted", "");
        rawVideo.muted = true;
        rawVideo.srcObject = stream;
        rawVideoRef.current = rawVideo;

        await rawVideo.play();

        if (cancelled) return;

        console.log("[MirrorV2:Camera] Stream acquired, stereo:", isStereoCamera(rawVideo));

        if (isStereoCamera(rawVideo)) {
          // Stereo camera detected — crop to left lens
          console.log(
            `[MirrorV2:Camera] Stereo camera detected: ${rawVideo.videoWidth}x${rawVideo.videoHeight}, cropping to left lens`
          );

          const cropCanvas = document.createElement("canvas");
          cropCanvas.width = rawVideo.videoWidth / 2;
          cropCanvas.height = rawVideo.videoHeight;
          cropCanvasRef.current = cropCanvas;
          const ctx = cropCanvas.getContext("2d")!;

          // Draw loop: copy left half of raw video to crop canvas
          function drawCrop() {
            if (cancelled) return;
            ctx.drawImage(
              rawVideo,
              rawVideo.videoWidth / 2, 0, rawVideo.videoWidth / 2, rawVideo.videoHeight, // source: right half
              0, 0, cropCanvas.width, cropCanvas.height                                    // dest: full canvas
            );
            cropFrameRef.current = requestAnimationFrame(drawCrop);
          }
          drawCrop();

          // Create a stream from the cropped canvas and feed it to the output video
          const croppedStream = cropCanvas.captureStream(30);

          if (videoRef.current) {
            videoRef.current.srcObject = croppedStream;
            try {
              await videoRef.current.play();
            } catch (playErr) {
              console.error("[MirrorV2:Camera] play() rejected:", playErr instanceof Error ? playErr.message : playErr);
            }
            setIsReady(true);
            console.log("[MirrorV2:Camera] Ready");
          }
        } else {
          // Normal single-lens camera — use directly
          console.log(
            `[MirrorV2:Camera] Normal camera: ${rawVideo.videoWidth}x${rawVideo.videoHeight}`
          );

          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            try {
              await videoRef.current.play();
            } catch (playErr) {
              console.error("[MirrorV2:Camera] play() rejected:", playErr instanceof Error ? playErr.message : playErr);
            }
            setIsReady(true);
            console.log("[MirrorV2:Camera] Ready");
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[MirrorV2:Camera] getUserMedia failed:", err instanceof Error ? err.message : err);
          setError(err instanceof Error ? err.message : "Camera access denied");
        }
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      cancelAnimationFrame(cropFrameRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      rawVideoRef.current?.pause();
      rawVideoRef.current = null;
      cropCanvasRef.current = null;
      setIsReady(false);
    };
  }, []);

  return { videoRef, isReady, error };
}
