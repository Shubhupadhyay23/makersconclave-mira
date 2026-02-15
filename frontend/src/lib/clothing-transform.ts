import type { PoseLandmark } from '@/types/pose';
import { POSE_LANDMARKS } from '@/types/pose';
import type { ClothingCategory, ClothingTransform, ClothingQuad, ClothingAnchorPoints } from '@/types/clothing';

const MIN_VISIBILITY = 0.5;
const PADDING_FACTOR = 1.5; // 50% padding around clothing for better coverage
const SIZE_MULTIPLIER = 1.3; // Additional scale multiplier to compensate for square crops

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

  // Calculate dimensions - use shoulder width as reference to maintain aspect ratio
  const shoulderWidth = distance(tlPx, trPx);
  const scale = shoulderWidth * PADDING_FACTOR * SIZE_MULTIPLIER;

  // Both width and height use the same scale to maintain aspect ratio
  const width = scale;
  const height = scale;

  // Calculate rotation from shoulder line
  // Add PI to flip 180 degrees (clothing images are typically oriented top-down)
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x) + Math.PI;

  return {
    centerX,
    centerY,
    width,
    height,
    rotation
  };
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

  // Calculate dimensions - use hip width as reference to maintain aspect ratio
  const hipWidth = distance(tlPx, trPx);
  const scale = hipWidth * PADDING_FACTOR * SIZE_MULTIPLIER;

  // Both width and height use the same scale to maintain aspect ratio
  const width = scale;
  const height = scale;

  // Calculate rotation from hip line
  // Add PI to flip 180 degrees (clothing images are typically oriented top-down)
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x) + Math.PI;

  return {
    centerX,
    centerY,
    width,
    height,
    rotation
  };
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

/**
 * Get the 4 corner points for clothing quad mapping
 * This maps clothing image corners directly to body landmarks
 * If anchor points are provided, uses them for precise mapping
 */
export function getClothingQuad(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number,
  anchorPoints?: ClothingAnchorPoints
): ClothingQuad | null {
  // Check visibility
  if (!areLandmarksVisible(landmarks, category)) {
    return null;
  }

  // If anchor points provided and valid, use them for direct mapping
  if (anchorPoints && anchorPoints.leftShoulder && anchorPoints.rightShoulder) {
    console.log('Using detected anchor points for precise alignment');
    return mapAnchorsToBody(landmarks, category, anchorPoints, canvasWidth, canvasHeight);
  }

  // Fallback to landmark-based quad (original behavior)
  if (category === 'tops') {
    const lShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];

    return {
      topLeft: landmarkToPixel(lShoulder, canvasWidth, canvasHeight),
      topRight: landmarkToPixel(rShoulder, canvasWidth, canvasHeight),
      bottomLeft: landmarkToPixel(lHip, canvasWidth, canvasHeight),
      bottomRight: landmarkToPixel(rHip, canvasWidth, canvasHeight),
    };
  } else {
    // bottoms
    const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const lAnkle = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
    const rAnkle = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

    return {
      topLeft: landmarkToPixel(lHip, canvasWidth, canvasHeight),
      topRight: landmarkToPixel(rHip, canvasWidth, canvasHeight),
      bottomLeft: landmarkToPixel(lAnkle, canvasWidth, canvasHeight),
      bottomRight: landmarkToPixel(rAnkle, canvasWidth, canvasHeight),
    };
  }
}

/**
 * Map detected clothing anchor points to body landmarks
 * Direct mapping: clothing shoulders -> body shoulders exactly
 */
function mapAnchorsToBody(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  anchors: ClothingAnchorPoints,
  canvasWidth: number,
  canvasHeight: number
): ClothingQuad {
  if (category === 'tops') {
    // Direct mapping: clothing shoulders -> body shoulders
    const lShoulderLandmark = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rShoulderLandmark = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];

    // Convert body landmarks to pixels
    const bodyTopLeft = landmarkToPixel(lShoulderLandmark, canvasWidth, canvasHeight);
    const bodyTopRight = landmarkToPixel(rShoulderLandmark, canvasWidth, canvasHeight);
    const bodyBottomLeft = landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight);
    const bodyBottomRight = landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight);

    return {
      topLeft: bodyTopLeft,
      topRight: bodyTopRight,
      bottomLeft: bodyBottomLeft,
      bottomRight: bodyBottomRight,
    };
  } else {
    // Bottoms: waistband -> hips, hem -> ankles
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const lAnkleLandmark = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
    const rAnkleLandmark = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

    return {
      topLeft: landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight),
      topRight: landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight),
      bottomLeft: landmarkToPixel(lAnkleLandmark, canvasWidth, canvasHeight),
      bottomRight: landmarkToPixel(rAnkleLandmark, canvasWidth, canvasHeight),
    };
  }
}
