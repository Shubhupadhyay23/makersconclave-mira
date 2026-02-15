"use client";

import { useRef, useEffect, useState, useCallback } from 'react';
import type { PoseResult } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { getClothingQuad } from '../lib/clothing-transform';
import { detectShoulderSeams, type ShoulderAnchors } from '@/lib/shoulder-seam-detection';
import { detectWaistband, type WaistbandAnchors } from '@/lib/waistband-detection';

interface ClothingCanvasProps {
  pose: PoseResult | null;
  items: ClothingItem[];
  width: number;
  height: number;
  onImageError?: (itemId: string, error: string) => void;
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
  onImageError,
}: ClothingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const boundsRef = useRef<Map<string, ImageBounds>>(new Map());
  const shoulderAnchorsRef = useRef<Map<string, ShoulderAnchors>>(new Map());
  const waistbandAnchorsRef = useRef<Map<string, WaistbandAnchors>>(new Map());
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const lastPoseRef = useRef<PoseResult | null>(null);

  // Preload images when items change
  useEffect(() => {
    // Clear cached anchors to force re-detection with new format
    shoulderAnchorsRef.current.clear();
    waistbandAnchorsRef.current.clear();

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
        img.crossOrigin = 'anonymous';

        img.onload = async () => {
          if (mounted) {
            // Detect and store content bounds (crop transparent padding)
            const bounds = detectImageBounds(img);
            boundsRef.current.set(item.id, bounds);

            // Detect anchor points based on category
            if (item.category === 'tops') {
              try {
                console.log(`Detecting shoulder seams for ${item.id}...`);
                const shoulderAnchors = detectShoulderSeams(img);
                if (shoulderAnchors) {
                  shoulderAnchorsRef.current.set(item.id, shoulderAnchors);
                  console.log(`✓ Shoulder seams detected for ${item.id}:`, shoulderAnchors);
                } else {
                  console.warn(`Could not detect shoulder seams for ${item.id}, will use fallback`);
                }
              } catch (error) {
                console.error(`Shoulder seam detection failed for ${item.id}:`, error);
                // Continue without anchor points (will use fallback)
              }
            } else if (item.category === 'bottoms') {
              try {
                console.log(`Detecting waistband for ${item.id}...`);
                const waistbandAnchors = detectWaistband(img);
                if (waistbandAnchors) {
                  waistbandAnchorsRef.current.set(item.id, waistbandAnchors);
                  console.log(`✓ Waistband detected for ${item.id}:`, waistbandAnchors);
                } else {
                  console.warn(`Could not detect waistband for ${item.id}, will use fallback`);
                }
              } catch (error) {
                console.error(`Waistband detection failed for ${item.id}:`, error);
                // Continue without anchor points (will use fallback)
              }
            }

            loaded.add(item.id);
            setLoadedImages(new Set(loaded));
          }
          resolve();
        };

        img.onerror = () => {
          console.error(`Failed to load image: ${item.imageUrl}`);
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
      }
    });

    return () => {
      mounted = false;
    };
  }, [items, onImageError]);

  // Render clothing overlays
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use current pose or freeze at last known position
    const poseToRender = pose || lastPoseRef.current;
    if (!poseToRender) {
      // No pose yet - clear canvas
      ctx.clearRect(0, 0, width, height);
      return;
    }

    // Update last known pose
    if (pose) {
      lastPoseRef.current = pose;
    }

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Sort items by z-order (bottoms first, then tops)
    const sortedItems = [...items].sort((a, b) => {
      return CATEGORY_Z_ORDER[a.category] - CATEGORY_Z_ORDER[b.category];
    });

    // Render each clothing item
    for (const item of sortedItems) {
      const img = imagesRef.current.get(item.id);
      if (!img || !loadedImages.has(item.id)) continue;

      // Get anchor points based on category
      const shoulderAnchors = shoulderAnchorsRef.current.get(item.id);
      const waistbandAnchors = waistbandAnchorsRef.current.get(item.id);

      // Get quad points mapping clothing corners to body landmarks
      const quad = getClothingQuad(
        poseToRender.landmarks,
        item.category,
        width,
        height
      );

      if (!quad) {
        // Landmarks not visible for this category - skip rendering
        continue;
      }

      // Use shoulder seam detection for tops
      if (item.category === 'tops' && shoulderAnchors) {
        // Map shoulder seams → body shoulders, hem → body hips

        // Shirt anchor points in image (normalized 0-1, convert to pixels)
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

        // Body landmarks
        const bodyLeftShoulder = quad.topLeft;
        const bodyRightShoulder = quad.topRight;
        const bodyLeftHip = quad.bottomLeft;
        const bodyRightHip = quad.bottomRight;

        // Calculate shirt measurements
        const shirtShoulderWidth = Math.hypot(
          shirtRightShoulder.x - shirtLeftShoulder.x,
          shirtRightShoulder.y - shirtLeftShoulder.y
        );
        const shirtTorsoHeight = Math.hypot(
          shirtLeftHem.x - shirtLeftShoulder.x,
          shirtLeftHem.y - shirtLeftShoulder.y
        );

        // Calculate body measurements
        const bodyShoulderWidth = Math.hypot(
          bodyRightShoulder.x - bodyLeftShoulder.x,
          bodyRightShoulder.y - bodyLeftShoulder.y
        );
        const bodyTorsoHeight = Math.hypot(
          bodyLeftHip.x - bodyLeftShoulder.x,
          bodyLeftHip.y - bodyLeftShoulder.y
        );

        // Calculate scale factors
        const scaleX = bodyShoulderWidth / shirtShoulderWidth;
        const scaleY = bodyTorsoHeight / shirtTorsoHeight;
        const scale = (scaleX + scaleY) / 2;

        // Calculate anchor quad centers
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
        ) + Math.PI;

        const renderWidth = img.width * scale;
        const renderHeight = img.height * scale;

        ctx.save();
        ctx.translate(finalCenterX, finalCenterY);
        ctx.rotate(rotation);
        ctx.scale(-1, 1);
        ctx.globalAlpha = 1.0;

        ctx.drawImage(
          img,
          0, 0, img.width, img.height,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        ctx.restore();

        console.log(`[Render] Shoulder seams→shoulders, hem→hips | Scale: ${scale.toFixed(2)}`);
      } else if (item.category === 'bottoms' && waistbandAnchors && waistbandAnchors.topLeft) {
        // Direct corner-to-landmark mapping:
        // Image top-left → Body left hip
        // Image top-right → Body right hip
        // Image bottom-left → Body left ankle
        // Image bottom-right → Body right ankle

        // Image corner pixels (in image coordinates)
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

        // Calculate source region (bounding box of 4 corners)
        const srcX = Math.min(imgTopLeft.x, imgBottomLeft.x);
        const srcY = Math.min(imgTopLeft.y, imgTopRight.y);
        const srcWidth = Math.max(imgTopRight.x, imgBottomRight.x) - srcX;
        const srcHeight = Math.max(imgBottomLeft.y, imgBottomRight.y) - srcY;

        // Body landmarks
        const bodyLeftHip = quad.topLeft;
        const bodyRightHip = quad.topRight;
        const bodyLeftAnkle = quad.bottomLeft;
        const bodyRightAnkle = quad.bottomRight;

        // Calculate body dimensions
        const bodyWidth = Math.hypot(
          bodyRightHip.x - bodyLeftHip.x,
          bodyRightHip.y - bodyLeftHip.y
        );
        const bodyHeight = Math.hypot(
          bodyLeftAnkle.x - bodyLeftHip.x,
          bodyLeftAnkle.y - bodyLeftHip.y
        );

        // Calculate scale
        const scaleX = bodyWidth / srcWidth;
        const scaleY = bodyHeight / srcHeight;
        const scale = Math.min(scaleX, scaleY) * 1.1; // Expand by 10%

        // Render dimensions
        const renderWidth = srcWidth * scale;
        const renderHeight = srcHeight * scale;

        // Position at body quad center
        const bodyCenterX = (bodyLeftHip.x + bodyRightHip.x + bodyLeftAnkle.x + bodyRightAnkle.x) / 4;
        const bodyCenterY = (bodyLeftHip.y + bodyRightHip.y + bodyLeftAnkle.y + bodyRightAnkle.y) / 4;

        // Rotation from body hip line
        const rotation = Math.atan2(
          bodyRightHip.y - bodyLeftHip.y,
          bodyRightHip.x - bodyLeftHip.x
        ) + Math.PI;

        ctx.save();
        ctx.translate(bodyCenterX, bodyCenterY);
        ctx.rotate(rotation);
        ctx.scale(-1, 1); // Flip horizontally
        ctx.globalAlpha = 1.0;

        // Draw the detected region
        ctx.drawImage(
          img,
          srcX, srcY, srcWidth, srcHeight,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        ctx.restore();

        console.log(`[Render] 4-corner mapping | TL:(${imgTopLeft.x.toFixed(0)},${imgTopLeft.y.toFixed(0)}) → Hip, BR:(${imgBottomRight.x.toFixed(0)},${imgBottomRight.y.toFixed(0)}) → Ankle`);
      } else {
        // Fallback: use standard quad rendering without anchor points
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
        ) + Math.PI;

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(rotation);
        ctx.globalAlpha = 1.0;

        ctx.drawImage(
          img,
          bounds.x, bounds.y, bounds.width, bounds.height,
          -renderWidth / 2, -renderHeight / 2, renderWidth, renderHeight
        );

        ctx.restore();
      }
    }
  }, [pose, items, width, height, loadedImages]);

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
