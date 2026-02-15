"use client";

import { useState, useCallback, useEffect } from 'react';
import { useCamera } from '@/hooks/useCamera';
import { usePoseDetection } from '@/hooks/usePoseDetection';
import type { PoseResult } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { ClothingCanvas } from '@/components/mirror/ClothingCanvas';
import { DebugOverlay } from './components/DebugOverlay';
import { TestSidebar } from './components/TestSidebar';
import { DEFAULT_OUTFITS } from './lib/test-data';

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

interface ToastMessage {
  id: string;
  message: string;
  type: 'error' | 'success';
}

export default function MirrorTestPage() {
  // Camera and pose detection
  const { videoRef, isReady: isCameraReady, error: cameraError } = useCamera();
  const [currentPose, setCurrentPose] = useState<PoseResult | null>(null);

  // Outfit state
  const [outfits, setOutfits] = useState<ClothingItem[][]>(DEFAULT_OUTFITS);
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentOutfit = outfits[currentIndex] || [];

  // UI state
  const [debugMode, setDebugMode] = useState(true); // Default ON for testing
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Pose detection callback
  const handlePoseUpdate = useCallback((result: PoseResult) => {
    setCurrentPose(result);
  }, []);

  const { isLoading: isPoseLoading, error: poseError } = usePoseDetection({
    videoRef,
    isVideoReady: isCameraReady,
    onPoseUpdate: handlePoseUpdate,
  });

  // Toast management
  const showToast = useCallback((message: string, type: 'error' | 'success' = 'error') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  // Handle image errors
  const handleImageError = useCallback(
    (itemId: string, error: string) => {
      showToast(error, 'error');
    },
    [showToast]
  );

  // Add new clothing item
  const handleAddItem = useCallback((item: ClothingItem) => {
    setOutfits((prev) => [...prev, [item]]);
    setCurrentIndex(outfits.length); // Switch to new item
    showToast('Item added successfully', 'success');
  }, [outfits.length, showToast]);

  // Delete outfit
  const handleDeleteOutfit = useCallback((id: string) => {
    setOutfits((prev) => {
      const newOutfits = prev.filter((outfit) => {
        return !outfit.some((item) => item.id === id);
      });

      // Adjust current index if needed
      if (currentIndex >= newOutfits.length) {
        setCurrentIndex(Math.max(0, newOutfits.length - 1));
      }

      return newOutfits;
    });
  }, [currentIndex]);

  // Keyboard controls
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          setCurrentIndex((i) => Math.max(0, i - 1));
          break;

        case 'ArrowRight':
          setCurrentIndex((i) => Math.min(outfits.length - 1, i + 1));
          break;

        case 'd':
        case 'D':
          setDebugMode((d) => !d);
          break;

        case 'f':
        case 'F':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            document.documentElement.requestFullscreen();
          }
          break;

        case 'r':
        case 'R':
          setCurrentIndex(0);
          break;

        default:
          // Number keys 1-9
          const num = parseInt(e.key);
          if (num >= 1 && num <= 9 && num - 1 < outfits.length) {
            setCurrentIndex(num - 1);
          }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [outfits.length]);

  // Error state
  if (cameraError?.includes('Permission denied') || cameraError?.includes('NotAllowedError')) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          color: '#fff',
          flexDirection: 'column',
          gap: 24,
          padding: 40,
        }}
      >
        <h1 style={{ fontSize: '2rem', margin: 0 }}>Camera Access Required</h1>
        <p style={{ fontSize: '1.2rem', textAlign: 'center', maxWidth: 600 }}>
          This test page needs camera access to detect your body position and overlay clothing.
        </p>
        <details style={{ maxWidth: 600 }}>
          <summary style={{ cursor: 'pointer', fontSize: '1rem', marginBottom: 12 }}>
            How to enable camera
          </summary>
          <ul style={{ textAlign: 'left', lineHeight: 1.6 }}>
            <li><strong>Chrome:</strong> Click the camera icon in the address bar</li>
            <li><strong>Firefox:</strong> Click the crossed-out camera icon</li>
            <li><strong>Safari:</strong> Safari → Settings → Websites → Camera</li>
          </ul>
        </details>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '12px 24px',
            background: '#0070f3',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: '1rem',
            cursor: 'pointer',
            marginTop: 16,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (poseError) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          color: '#fff',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div style={{ fontSize: '2rem', color: '#ff4444' }}>MediaPipe Error</div>
        <div style={{ fontSize: '1.2rem', maxWidth: 600, textAlign: 'center' }}>
          {poseError}
        </div>
        <div style={{ fontSize: '1rem', color: '#999' }}>
          Try refreshing the page or check console for details
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '12px 24px',
            background: '#0070f3',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <main
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {/* Hidden video element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
        }}
      />

      {/* Canvas container (centered and scaled to fit viewport) */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 350, // Leave space for sidebar
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
          }}
        >
          {/* Clothing overlay canvas */}
          <ClothingCanvas
            pose={currentPose}
            items={currentOutfit}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onImageError={handleImageError}
          />

          {/* Debug overlay */}
          <DebugOverlay
            pose={currentPose}
            items={currentOutfit}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            visible={debugMode}
          />
        </div>
      </div>

      {/* Test sidebar */}
      <TestSidebar
        items={Array.from(new Map(outfits.flat().map(item => [item.id, item])).values())}
        currentIndex={currentIndex}
        onAdd={handleAddItem}
        onDelete={handleDeleteOutfit}
        debugMode={debugMode}
      />

      {/* Loading indicator */}
      {(isPoseLoading || !isCameraReady) && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#fff',
            fontSize: '1.5rem',
            zIndex: 50,
            textAlign: 'center',
          }}
        >
          <div style={{ marginBottom: 16 }}>Loading...</div>
          <div style={{ fontSize: '1rem', color: '#999' }}>
            {!isCameraReady && 'Initializing camera...'}
            {isCameraReady && isPoseLoading && 'Loading pose detection model...'}
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div
        style={{
          position: 'fixed',
          top: 20,
          right: 370, // Right of sidebar
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              padding: '12px 16px',
              background: toast.type === 'error' ? '#ff4444' : '#44ff44',
              color: '#000',
              borderRadius: 8,
              fontSize: '14px',
              fontWeight: 600,
              maxWidth: 300,
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              animation: 'fadeIn 200ms ease-out',
            }}
            onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {/* Current outfit indicator */}
      {currentOutfit.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            left: 20,
            padding: '8px 16px',
            background: 'rgba(0, 0, 0, 0.7)',
            borderRadius: 8,
            color: '#fff',
            fontSize: '14px',
          }}
        >
          Outfit {currentIndex + 1} / {outfits.length}
        </div>
      )}

      {/* Global styles */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </main>
  );
}
