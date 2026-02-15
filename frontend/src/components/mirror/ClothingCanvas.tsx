"use client";

import { useRef, useEffect, useState, useCallback } from 'react';
import type { PoseResult } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { getClothingQuad } from '@/lib/clothing-transform';

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
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const lastPoseRef = useRef<PoseResult | null>(null);

  // Preload images when items change
  useEffect(() => {
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

        img.onload = () => {
          if (mounted) {
            // Detect and store content bounds (crop transparent padding)
            const bounds = detectImageBounds(img);
            boundsRef.current.set(item.id, bounds);

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

      // Use standard quad-based rendering
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
