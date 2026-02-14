import type { PoseLandmark } from '@/types/pose';
import { POSE_LANDMARKS } from '@/types/pose';
import type { ClothingCategory, ClothingTransform } from '@/types/clothing';

const MIN_VISIBILITY = 0.5;
const PADDING_FACTOR = 1.1; // 10% padding around clothing

interface PixelCoord {
  x: number;
  y: number;
}

/**
 * Convert normalized landmark coordinates to pixel coordinates
 */
export function landmarkToPixel(
  landmark: PoseLandmark,
  canvasWidth: number,
  canvasHeight: number
): PixelCoord {
  return {
    x: landmark.x * canvasWidth,
    y: landmark.y * canvasHeight,
  };
}

/**
 * Calculate distance between two pixel coordinates
 */
function distance(a: PixelCoord, b: PixelCoord): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Get the landmark indices needed for a clothing category
 */
function getCategoryLandmarks(category: ClothingCategory): number[] {
  switch (category) {
    case 'tops':
      return [
        POSE_LANDMARKS.LEFT_SHOULDER,
        POSE_LANDMARKS.RIGHT_SHOULDER,
        POSE_LANDMARKS.LEFT_ELBOW,
        POSE_LANDMARKS.RIGHT_ELBOW,
        POSE_LANDMARKS.LEFT_HIP,
        POSE_LANDMARKS.RIGHT_HIP,
      ];
    case 'bottoms':
      return [
        POSE_LANDMARKS.LEFT_HIP,
        POSE_LANDMARKS.RIGHT_HIP,
        POSE_LANDMARKS.LEFT_KNEE,
        POSE_LANDMARKS.RIGHT_KNEE,
        POSE_LANDMARKS.LEFT_ANKLE,
        POSE_LANDMARKS.RIGHT_ANKLE,
      ];
  }
}

/**
 * Check if all required landmarks for a category are visible
 */
export function areLandmarksVisible(
  landmarks: PoseLandmark[],
  category: ClothingCategory
): boolean {
  const requiredIndices = getCategoryLandmarks(category);
  return requiredIndices.every((idx) => landmarks[idx]?.visibility >= MIN_VISIBILITY);
}

/**
 * Calculate affine transform for tops (shirts, jackets, hoodies)
 * Uses 6-point anchor: shoulders + elbows + hips
 * Projects onto 4-corner rectangle: shoulders + hips
 */
function calculateTopTransform(
  landmarks: PoseLandmark[],
  canvasWidth: number,
  canvasHeight: number
): ClothingTransform | null {
  // Check visibility of all required landmarks
  if (!areLandmarksVisible(landmarks, 'tops')) {
    return null;
  }

  // Get landmarks
  const lShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];

  // Convert to pixels
  const tlPx = landmarkToPixel(lShoulder, canvasWidth, canvasHeight);
  const trPx = landmarkToPixel(rShoulder, canvasWidth, canvasHeight);
  const blPx = landmarkToPixel(lHip, canvasWidth, canvasHeight);
  const brPx = landmarkToPixel(rHip, canvasWidth, canvasHeight);

  // Calculate center point
  const centerX = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const centerY = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Calculate dimensions
  const topWidth = distance(tlPx, trPx);
  const bottomWidth = distance(blPx, brPx);
  const width = ((topWidth + bottomWidth) / 2) * PADDING_FACTOR;

  const leftHeight = distance(tlPx, blPx);
  const rightHeight = distance(trPx, brPx);
  const height = ((leftHeight + rightHeight) / 2) * PADDING_FACTOR;

  // Calculate rotation from shoulder line
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return { centerX, centerY, width, height, rotation };
}

/**
 * Calculate affine transform for bottoms (pants, shorts, skirts)
 * Uses 6-point anchor: hips + knees + ankles
 * Projects onto 4-corner rectangle: hips + ankles
 */
function calculateBottomTransform(
  landmarks: PoseLandmark[],
  canvasWidth: number,
  canvasHeight: number
): ClothingTransform | null {
  // Check visibility
  if (!areLandmarksVisible(landmarks, 'bottoms')) {
    return null;
  }

  // Get landmarks
  const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  const lAnkle = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
  const rAnkle = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

  // Convert to pixels
  const tlPx = landmarkToPixel(lHip, canvasWidth, canvasHeight);
  const trPx = landmarkToPixel(rHip, canvasWidth, canvasHeight);
  const blPx = landmarkToPixel(lAnkle, canvasWidth, canvasHeight);
  const brPx = landmarkToPixel(rAnkle, canvasWidth, canvasHeight);

  // Calculate center
  const centerX = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const centerY = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Calculate dimensions
  const topWidth = distance(tlPx, trPx);
  const bottomWidth = distance(blPx, brPx);
  const width = ((topWidth + bottomWidth) / 2) * PADDING_FACTOR;

  const leftHeight = distance(tlPx, blPx);
  const rightHeight = distance(trPx, brPx);
  const height = ((leftHeight + rightHeight) / 2) * PADDING_FACTOR;

  // Calculate rotation from hip line
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return { centerX, centerY, width, height, rotation };
}

/**
 * Calculate clothing transform for any category
 */
export function calculateClothingTransform(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number
): ClothingTransform | null {
  switch (category) {
    case 'tops':
      return calculateTopTransform(landmarks, canvasWidth, canvasHeight);
    case 'bottoms':
      return calculateBottomTransform(landmarks, canvasWidth, canvasHeight);
  }
}

/**
 * Scale image dimensions to fit target while maintaining aspect ratio
 */
export function scaleToFit(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number
): { width: number; height: number } {
  const imageAspect = imageWidth / imageHeight;
  const targetAspect = targetWidth / targetHeight;

  if (imageAspect > targetAspect) {
    // Image is wider - fit to width
    return {
      width: targetWidth,
      height: targetWidth / imageAspect,
    };
  } else {
    // Image is taller - fit to height
    return {
      width: targetHeight * imageAspect,
      height: targetHeight,
    };
  }
}
