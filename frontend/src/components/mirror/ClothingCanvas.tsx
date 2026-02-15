"use client";

import { useRef, useEffect, useState, useCallback } from 'react';
import type { PoseResult } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { getClothingQuad } from '@/lib/clothing-transform';
import { detectShoulderSeams, type ShoulderAnchors } from '@/lib/shoulder-seam-detection';
import { detectWaistband, type WaistbandAnchors } from '@/lib/waistband-detection';

export type FitMethod = 'precise' | 'fallback';

interface ClothingCanvasProps {
  pose: PoseResult | null;
  items: ClothingItem[];
  width: number;
  height: number;
  opacity?: number;
  onImageError?: (itemId: string, error: string) => void;
  onFitStatus?: (statuses: Map<string, FitMethod>) => void;
}

const CATEGORY_Z_ORDER = {
  bottoms: 0,
  tops: 1,
};

interface ImageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Detect the bounding box of non-transparent pixels in an image
 * This crops out empty transparent space
 */
function detectImageBounds(img: HTMLImageElement): ImageBounds {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { x: 0, y: 0, width: img.width, height: img.height };

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const pixels = imageData.data;

  let minX = img.width;
  let minY = img.height;
  let maxX = 0;
  let maxY = 0;

  // Scan for non-transparent pixels
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const alpha = pixels[(y * img.width + x) * 4 + 3];
      if (alpha > 10) { // Threshold for "visible"
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Add small padding
  const padding = 5;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(img.width, maxX + padding);
  maxY = Math.min(img.height, maxY + padding);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function ClothingCanvas({
  pose,
  items,
  width,
  height,
  opacity = 1.0,
  onImageError,
  onFitStatus,
}: ClothingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const boundsRef = useRef<Map<string, ImageBounds>>(new Map());
  const shoulderAnchorsRef = useRef<Map<string, ShoulderAnchors>>(new Map());
  const waistbandAnchorsRef = useRef<Map<string, WaistbandAnchors>>(new Map());
  const fitStatusRef = useRef<Map<string, FitMethod>>(new Map());
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const lastPoseRef = useRef<PoseResult | null>(null);

  // Preload images when items change
  useEffect(() => {
    // Clear cached anchors to force re-detection with new items
    shoulderAnchorsRef.current.clear();
    waistbandAnchorsRef.current.clear();
    fitStatusRef.current = new Map();

    const newImages = new Map<string, HTMLImageElement>();
    const loaded = new Set<string>();
    let mounted = true;

    const loadPromises = items.map((item) => {
      return new Promise<void>((resolve) => {
        // Reuse already loaded images
        if (imagesRef.current.has(item.id)) {
          const existingImg = imagesRef.current.get(item.id)!;
          newImages.set(item.id, existingImg);
          loaded.add(item.id);
          resolve();
          return;
        }

        // Load new image
        const img = new Image();
        // Only set crossOrigin for external URLs — data URLs don't need it
        // and it can cause tainted canvas errors in some browsers
        if (!item.imageUrl.startsWith('data:')) {
          img.crossOrigin = 'anonymous';
        }

        img.onload = () => {
          if (!mounted) { resolve(); return; }

          // Detect and store content bounds (crop transparent padding)
          try {
            const bounds = detectImageBounds(img);
            boundsRef.current.set(item.id, bounds);
          } catch (err) {
            console.warn("[MirrorV2:Canvas] Image bounds detection failed:", err);
            boundsRef.current.set(item.id, {
              x: 0, y: 0, width: img.width, height: img.height,
            });
          }

          // Detect anchor points based on category
          if (item.category === 'tops') {
            try {
              const shoulderAnchors = detectShoulderSeams(img);
              if (shoulderAnchors) {
                shoulderAnchorsRef.current.set(item.id, shoulderAnchors);
                fitStatusRef.current.set(item.id, 'precise');
              } else {
                fitStatusRef.current.set(item.id, 'fallback');
              }
            } catch (err) {
              console.warn("[MirrorV2:Canvas] Anchor detection failed, using fallback:", err);
              fitStatusRef.current.set(item.id, 'fallback');
            }
          } else if (item.category === 'bottoms') {
            try {
              const waistbandAnchors = detectWaistband(img);
              if (waistbandAnchors) {
                waistbandAnchorsRef.current.set(item.id, waistbandAnchors);
                fitStatusRef.current.set(item.id, 'precise');
              } else {
                fitStatusRef.current.set(item.id, 'fallback');
              }
            } catch (err) {
              console.warn("[MirrorV2:Canvas] Anchor detection failed, using fallback:", err);
              fitStatusRef.current.set(item.id, 'fallback');
            }
          }

          loaded.add(item.id);
          setLoadedImages(new Set(loaded));
          resolve();
        };

        img.onerror = (e) => {
          const urlPreview = item.imageUrl.startsWith('data:') ? `data:... (${item.imageUrl.length} chars)` : item.imageUrl;
          console.error(`[MirrorV2:Canvas] Image load FAILED for "${item.name}" (${item.category}): ${urlPreview}`, e);
          onImageError?.(item.id, `Failed to load: ${item.imageUrl}`);
          resolve();
        };

        img.src = item.imageUrl;
        newImages.set(item.id, img);
      });
    });

    Promise.all(loadPromises).then(() => {
      if (mounted) {
        imagesRef.current = newImages;
        setLoadedImages(new Set(loaded));
        onFitStatus?.(new Map(fitStatusRef.current));
      }
    });

    return () => {
      mounted = false;
    };
  }, [items, onImageError, onFitStatus]);

  // Render clothing overlays
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error("[MirrorV2:Canvas] getContext('2d') returned null");
      return;
    }

    // Use current pose or freeze at last known position
    const poseToRender = pose || lastPoseRef.current;
    if (!poseToRender) {
      ctx.clearRect(0, 0, width, height);
      return;
    }

    // Update last known pose
    if (pose) {
      lastPoseRef.current = pose;
    }

    ctx.clearRect(0, 0, width, height);

    // Sort items by z-order (bottoms first, then tops)
    const sortedItems = [...items].sort((a, b) => {
      return CATEGORY_Z_ORDER[a.category] - CATEGORY_Z_ORDER[b.category];
    });

    for (const item of sortedItems) {
      const img = imagesRef.current.get(item.id);
      if (!img || !loadedImages.has(item.id)) continue;

      const shoulderAnchors = shoulderAnchorsRef.current.get(item.id);
      const waistbandAnchors = waistbandAnchorsRef.current.get(item.id);

      const quad = getClothingQuad(
        poseToRender.landmarks,
        item.category,
        width,
        height
      );

      if (!quad) continue;

      const isFallback = fitStatusRef.current.get(item.id) === 'fallback';

      // Shoulder seam anchored rendering for tops
      if (item.category === 'tops' && shoulderAnchors) {
        const shirtLeftShoulder = {
          x: shoulderAnchors.leftShoulder.x * img.width,
          y: shoulderAnchors.leftShoulder.y * img.height,
        };
        const shirtRightShoulder = {
          x: shoulderAnchors.rightShoulder.x * img.width,
          y: shoulderAnchors.rightShoulder.y * img.height,
        };
        const shirtLeftHem = {
          x: shoulderAnchors.leftHem.x * img.width,
          y: shoulderAnchors.leftHem.y * img.height,
        };
        const shirtRightHem = {
          x: shoulderAnchors.rightHem.x * img.width,
          y: shoulderAnchors.rightHem.y * img.height,
        };

        const bodyLeftShoulder = quad.topLeft;
        const bodyRightShoulder = quad.topRight;
        const bodyLeftHip = quad.bottomLeft;
        const bodyRightHip = quad.bottomRight;

        const shirtShoulderWidth = Math.hypot(
          shirtRightShoulder.x - shirtLeftShoulder.x,
          shirtRightShoulder.y - shirtLeftShoulder.y
        );
        const shirtTorsoHeight = Math.hypot(
          shirtLeftHem.x - shirtLeftShoulder.x,
          shirtLeftHem.y - shirtLeftShoulder.y
        );

        const bodyShoulderWidth = Math.hypot(
          bodyRightShoulder.x - bodyLeftShoulder.x,
          bodyRightShoulder.y - bodyLeftShoulder.y
        );
        const bodyTorsoHeight = Math.hypot(
          bodyLeftHip.x - bodyLeftShoulder.x,
          bodyLeftHip.y - bodyLeftShoulder.y
        );

        const scaleX = bodyShoulderWidth / shirtShoulderWidth;
        const scaleY = bodyTorsoHeight / shirtTorsoHeight;
        const scale = (scaleX + scaleY) / 2;

        const shirtAnchorCenterX = (shirtLeftShoulder.x + shirtRightShoulder.x + shirtLeftHem.x + shirtRightHem.x) / 4;
        const shirtAnchorCenterY = (shirtLeftShoulder.y + shirtRightShoulder.y + shirtLeftHem.y + shirtRightHem.y) / 4;

        const bodyCenterX = (bodyLeftShoulder.x + bodyRightShoulder.x + bodyLeftHip.x + bodyRightHip.x) / 4;
        const bodyCenterY = (bodyLeftShoulder.y + bodyRightShoulder.y + bodyLeftHip.y + bodyRightHip.y) / 4;

        const imgCenterX = img.width / 2;
        const imgCenterY = img.height / 2;

        const offsetX = (shirtAnchorCenterX - imgCenterX) * scale;
        const offsetY = (shirtAnchorCenterY - imgCenterY) * scale;

        const finalCenterX = bodyCenterX - offsetX;
        const finalCenterY = bodyCenterY - offsetY;

        const rotation = Math.atan2(
          bodyRightShoulder.y - bodyLeftShoulder.y,
          bodyRightShoulder.x - bodyLeftShoulder.x
        );

        const renderWidth = img.width * scale;
        const renderHeight = img.height * scale;

        ctx.save();
        ctx.translate(finalCenterX, finalCenterY);
        ctx.rotate(rotation);
        ctx.globalAlpha = opacity;

        ctx.drawImage(
          img,
          0, 0, img.width, img.height,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        ctx.restore();
      } else if (item.category === 'bottoms' && waistbandAnchors && waistbandAnchors.topLeft) {
        // Waistband anchored rendering for bottoms
        const imgTopLeft = {
          x: waistbandAnchors.topLeft.x * img.width,
          y: waistbandAnchors.topLeft.y * img.height,
        };
        const imgTopRight = {
          x: waistbandAnchors.topRight.x * img.width,
          y: waistbandAnchors.topRight.y * img.height,
        };
        const imgBottomLeft = {
          x: waistbandAnchors.bottomLeft.x * img.width,
          y: waistbandAnchors.bottomLeft.y * img.height,
        };
        const imgBottomRight = {
          x: waistbandAnchors.bottomRight.x * img.width,
          y: waistbandAnchors.bottomRight.y * img.height,
        };

        const srcX = Math.min(imgTopLeft.x, imgBottomLeft.x);
        const srcY = Math.min(imgTopLeft.y, imgTopRight.y);
        const srcWidth = Math.max(imgTopRight.x, imgBottomRight.x) - srcX;
        const srcHeight = Math.max(imgBottomLeft.y, imgBottomRight.y) - srcY;

        const bodyLeftHip = quad.topLeft;
        const bodyRightHip = quad.topRight;
        const bodyLeftAnkle = quad.bottomLeft;
        const bodyRightAnkle = quad.bottomRight;

        const bodyWidth = Math.hypot(
          bodyRightHip.x - bodyLeftHip.x,
          bodyRightHip.y - bodyLeftHip.y
        );
        const bodyHeight = Math.hypot(
          bodyLeftAnkle.x - bodyLeftHip.x,
          bodyLeftAnkle.y - bodyLeftHip.y
        );

        const scaleXVal = bodyWidth / srcWidth;
        const scaleYVal = bodyHeight / srcHeight;
        const scale = Math.min(scaleXVal, scaleYVal) * 1.1;

        const renderWidth = srcWidth * scale;
        const renderHeight = srcHeight * scale;

        const bodyCenterX = (bodyLeftHip.x + bodyRightHip.x + bodyLeftAnkle.x + bodyRightAnkle.x) / 4;
        const bodyCenterY = (bodyLeftHip.y + bodyRightHip.y + bodyLeftAnkle.y + bodyRightAnkle.y) / 4;

        const rotation = Math.atan2(
          bodyRightHip.y - bodyLeftHip.y,
          bodyRightHip.x - bodyLeftHip.x
        );

        ctx.save();
        ctx.translate(bodyCenterX, bodyCenterY);
        ctx.rotate(rotation);
        ctx.globalAlpha = opacity;

        ctx.drawImage(
          img,
          srcX, srcY, srcWidth, srcHeight,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        ctx.restore();
      } else {
        // Fallback: standard quad rendering without anchor points
        const bounds = boundsRef.current.get(item.id) || {
          x: 0,
          y: 0,
          width: img.width,
          height: img.height,
        };

        const topWidth = Math.hypot(
          quad.topRight.x - quad.topLeft.x,
          quad.topRight.y - quad.topLeft.y
        );
        const bottomWidth = Math.hypot(
          quad.bottomRight.x - quad.bottomLeft.x,
          quad.bottomRight.y - quad.bottomLeft.y
        );
        const renderWidth = ((topWidth + bottomWidth) / 2) * 1.4;

        const leftHeight = Math.hypot(
          quad.bottomLeft.x - quad.topLeft.x,
          quad.bottomLeft.y - quad.topLeft.y
        );
        const rightHeight = Math.hypot(
          quad.bottomRight.x - quad.topRight.x,
          quad.bottomRight.y - quad.topRight.y
        );
        const renderHeight = ((leftHeight + rightHeight) / 2) * 1.4;

        const centerX = (quad.topLeft.x + quad.topRight.x + quad.bottomLeft.x + quad.bottomRight.x) / 4;
        const centerY = (quad.topLeft.y + quad.topRight.y + quad.bottomLeft.y + quad.bottomRight.y) / 4;

        const rotation = Math.atan2(
          quad.topRight.y - quad.topLeft.y,
          quad.topRight.x - quad.topLeft.x
        );

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(rotation);
        ctx.globalAlpha = opacity;

        ctx.drawImage(
          img,
          bounds.x, bounds.y, bounds.width, bounds.height,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        // Subtle dashed border for fallback items
        if (isFallback) {
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.3)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(
            -renderWidth / 2, -renderHeight / 2,
            renderWidth, renderHeight
          );
          ctx.setLineDash([]);
        }

        ctx.restore();
      }
    }
  }, [pose, items, width, height, loadedImages, opacity]);

  // Re-render when dependencies change
  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}
