"use client";

import { useRef, useEffect, useState, useCallback } from 'react';
import type { PoseResult } from '@/types/pose';
import type { ClothingItem } from '@/types/clothing';
import { calculateClothingTransform, scaleToFit } from '../lib/clothing-transform';

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

export function ClothingCanvas({
  pose,
  items,
  width,
  height,
  onImageError,
}: ClothingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
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

      // Calculate transform for this item
      const transform = calculateClothingTransform(
        poseToRender.landmarks,
        item.category,
        width,
        height
      );

      if (!transform) {
        // Landmarks not visible for this category - skip rendering
        continue;
      }

      // Calculate scaled dimensions maintaining aspect ratio
      const { width: drawWidth, height: drawHeight } = scaleToFit(
        img.width,
        img.height,
        transform.width,
        transform.height
      );

      // Apply transform and render
      ctx.save();
      ctx.translate(transform.centerX, transform.centerY);
      ctx.rotate(transform.rotation);
      ctx.globalAlpha = 1.0; // Fully opaque

      ctx.drawImage(
        img,
        -drawWidth / 2,
        -drawHeight / 2,
        drawWidth,
        drawHeight
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
