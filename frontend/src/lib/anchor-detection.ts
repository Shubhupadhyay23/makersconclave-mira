/**
 * Clothing anchor point detection using OpenCV.js
 * Detects shoulders, collar, armpits, waistband, hem from clothing images
 */

import type { ClothingCategory, ClothingAnchorPoints } from '@/types/clothing';
import {
  isOpenCVReady,
  imageToMat,
  preprocessImage,
  detectEdges,
  findContours,
  getLargestContour,
  contourToPoints,
  getBoundingRect,
  calculateCurvature,
  measureContourComplexity,
  detectColoredPixels,
  calculateConvexHull,
  normalizePoint,
  cleanup,
} from './opencv-utils';

// Cache for detected anchor points
const anchorCache = new Map<string, ClothingAnchorPoints>();

// Detection thresholds
const SYMMETRY_THRESHOLD = 0.7;
const MIN_CONFIDENCE = 0.5;

interface DetectionInput {
  image: HTMLImageElement;
  category?: ClothingCategory;
}

/**
 * Main entry point: Detect clothing anchor points from an image
 */
export async function detectClothingAnchors(
  input: DetectionInput
): Promise<ClothingAnchorPoints> {
  const cacheKey = input.image.src;

  // Check cache first
  if (anchorCache.has(cacheKey)) {
    console.log('Using cached anchor points for:', cacheKey);
    return anchorCache.get(cacheKey)!;
  }

  try {
    // Perform detection
    const anchors = await performDetection(input);

    // Cache result
    anchorCache.set(cacheKey, anchors);

    return anchors;
  } catch (error) {
    console.error('Anchor detection failed:', error);

    // Fallback to colored pixel detection
    const detectedType = input.category || 'tops';
    return fallbackColoredPixelDetection(input.image, detectedType);
  }
}

/**
 * Clear the anchor point cache
 */
export function clearAnchorCache() {
  anchorCache.clear();
}

/**
 * Perform the actual detection
 */
async function performDetection(input: DetectionInput): Promise<ClothingAnchorPoints> {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const { image, category } = input;

  // Convert image to OpenCV Mat
  const src = imageToMat(image);

  // Preprocess: grayscale + contrast enhancement + blur
  const processed = preprocessImage(src, true);

  // Detect edges
  const edges = detectEdges(processed);

  // Find contours
  const { contours, hierarchy } = findContours(edges);

  // Get largest contour (main clothing item)
  const largestContour = getLargestContour(contours);

  if (!largestContour) {
    cleanup(src, processed, edges, contours, hierarchy);
    throw new Error('No contour detected');
  }

  // Convert contour to points
  const contourPoints = contourToPoints(largestContour);

  // Detect clothing type if not provided
  const detectedType = category || classifyClothingType(contourPoints, image.height);

  // Detect anchor points based on type
  let anchors: ClothingAnchorPoints;

  if (detectedType === 'tops') {
    anchors = detectTopAnchors(contourPoints, image.width, image.height);
  } else {
    anchors = detectBottomAnchors(contourPoints, image.width, image.height);
  }

  // Cleanup OpenCV matrices
  cleanup(src, processed, edges, contours, hierarchy);

  return anchors;
}

/**
 * Classify clothing type from contour shape
 */
function classifyClothingType(
  points: Array<{ x: number; y: number }>,
  imageHeight: number
): ClothingCategory {
  if (points.length < 10) return 'tops'; // Default fallback

  const bounds = {
    minX: Math.min(...points.map(p => p.x)),
    maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxY: Math.max(...points.map(p => p.y)),
  };

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const aspectRatio = height / width;

  // Analyze contour complexity at different heights
  const topComplexity = measureContourComplexity(points, imageHeight, 0, 0.3);
  const bottomComplexity = measureContourComplexity(points, imageHeight, 0.7, 1.0);

  // Detect features
  const hasCollar = detectCollarFeature(points, bounds);
  const hasLegs = detectLegSplit(points, bounds);

  // Classification logic
  if (hasCollar || (topComplexity > 0.1 && aspectRatio < 1.5)) {
    return 'tops';
  }

  if (hasLegs || bottomComplexity > 0.15) {
    return 'bottoms';
  }

  // Default based on aspect ratio
  return aspectRatio < 1.3 ? 'tops' : 'bottoms';
}

/**
 * Detect if contour has a collar feature (concave region at top)
 */
function detectCollarFeature(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
): boolean {
  const height = bounds.maxY - bounds.minY;
  const topPoints = points.filter(p => p.y < bounds.minY + height * 0.2);

  if (topPoints.length < 5) return false;

  // Check for concave curvature
  for (let i = 2; i < topPoints.length - 2; i++) {
    const curvature = calculateCurvature(
      topPoints[i - 2],
      topPoints[i],
      topPoints[i + 2]
    );
    if (curvature < -50) return true; // Significant concave region
  }

  return false;
}

/**
 * Detect if contour has leg split (two vertical segments at bottom)
 */
function detectLegSplit(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
): boolean {
  const height = bounds.maxY - bounds.minY;
  const bottomPoints = points.filter(p => p.y > bounds.minY + height * 0.7);

  if (bottomPoints.length < 10) return false;

  // Check for gap in the middle (indicates leg split)
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerRegion = bottomPoints.filter(p => Math.abs(p.x - centerX) < 20);

  return centerRegion.length < 3; // Gap in center = leg split
}

/**
 * Detect anchor points for tops (shirts, jackets, hoodies)
 */
function detectTopAnchors(
  points: Array<{ x: number; y: number }>,
  imageWidth: number,
  imageHeight: number
): ClothingAnchorPoints {
  const bounds = {
    minX: Math.min(...points.map(p => p.x)),
    maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxY: Math.max(...points.map(p => p.y)),
    width: 0,
    height: 0,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  // Detect shoulders
  const shoulders = detectShoulders(points, bounds);

  // Detect collar
  const collar = detectCollar(points, bounds);

  // Detect armpits
  const armpits = detectArmpits(points, bounds);

  // Validate symmetry
  const symmetryRatio = shoulders ? validateSymmetry(
    shoulders.left,
    shoulders.right,
    bounds
  ) : 0;

  const confidence = Math.min(1.0, symmetryRatio * 1.2);

  return {
    leftShoulder: shoulders ? normalizePoint(shoulders.left, imageWidth, imageHeight) : undefined,
    rightShoulder: shoulders ? normalizePoint(shoulders.right, imageWidth, imageHeight) : undefined,
    collarCenter: collar?.center ? normalizePoint(collar.center, imageWidth, imageHeight) : undefined,
    collarLeft: collar?.left ? normalizePoint(collar.left, imageWidth, imageHeight) : undefined,
    collarRight: collar?.right ? normalizePoint(collar.right, imageWidth, imageHeight) : undefined,
    leftArmpit: armpits?.left ? normalizePoint(armpits.left, imageWidth, imageHeight) : undefined,
    rightArmpit: armpits?.right ? normalizePoint(armpits.right, imageWidth, imageHeight) : undefined,
    detectedType: 'tops',
    confidence,
    method: 'feature-detection',
    contentBounds: {
      x: bounds.minX / imageWidth,
      y: bounds.minY / imageHeight,
      width: bounds.width / imageWidth,
      height: bounds.height / imageHeight,
    },
  };
}

/**
 * Detect shoulder points (topmost left/right corners)
 */
function detectShoulders(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): { left: { x: number; y: number }; right: { x: number; y: number } } | null {
  // Search in top 20% of garment
  const searchBottom = bounds.minY + bounds.height * 0.2;
  const topPoints = points.filter(p => p.y <= searchBottom);

  if (topPoints.length < 5) return null;

  // Find leftmost and rightmost points
  const leftmost = topPoints.reduce((left, p) => p.x < left.x ? p : left);
  const rightmost = topPoints.reduce((right, p) => p.x > right.x ? p : right);

  return { left: leftmost, right: rightmost };
}

/**
 * Detect collar/neckline points (highest concave region)
 */
function detectCollar(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): { center: { x: number; y: number }; left: { x: number; y: number }; right: { x: number; y: number } } | null {
  // Search in top 15% of garment
  const searchBottom = bounds.minY + bounds.height * 0.15;
  const topEdge = points.filter(p => p.y <= searchBottom);

  if (topEdge.length < 10) return null;

  // Sort by x coordinate
  topEdge.sort((a, b) => a.x - b.x);

  // Find concave points
  const concavePoints: Array<{ point: { x: number; y: number }; curvature: number }> = [];

  for (let i = 2; i < topEdge.length - 2; i++) {
    const curvature = calculateCurvature(
      topEdge[i - 2],
      topEdge[i],
      topEdge[i + 2]
    );

    if (curvature < -10) { // Concave threshold
      concavePoints.push({ point: topEdge[i], curvature });
    }
  }

  // Find center point (use most concave near center if found, otherwise highest center point)
  const centerX = bounds.minX + bounds.width / 2;
  let collarCenter: { x: number; y: number };

  if (concavePoints.length > 0) {
    collarCenter = concavePoints.reduce((best, curr) => {
      const distToCenter = Math.abs(curr.point.x - centerX);
      const bestDistToCenter = Math.abs(best.point.x - centerX);
      return distToCenter < bestDistToCenter ? curr : best;
    }).point;
  } else {
    collarCenter = topEdge.reduce((closest, p) =>
      Math.abs(p.x - centerX) < Math.abs(closest.x - centerX) ? p : closest
    );
  }

  return {
    center: collarCenter,
    left: topEdge[0],
    right: topEdge[topEdge.length - 1],
  };
}

/**
 * Detect armpit/sleeve junction points
 */
function detectArmpits(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): { left: { x: number; y: number }; right: { x: number; y: number } } | null {
  // Search region: 20%-50% down from top
  const searchTop = bounds.minY + bounds.height * 0.2;
  const searchBottom = bounds.minY + bounds.height * 0.5;

  // Scan horizontal slices and find widest point
  const slices: Array<{ y: number; leftX: number; rightX: number; width: number }> = [];

  for (let y = searchTop; y < searchBottom; y += 5) {
    const pointsAtY = points.filter(p => Math.abs(p.y - y) < 3);
    if (pointsAtY.length < 2) continue;

    const leftX = Math.min(...pointsAtY.map(p => p.x));
    const rightX = Math.max(...pointsAtY.map(p => p.x));
    slices.push({ y, leftX, rightX, width: rightX - leftX });
  }

  if (slices.length < 2) return null;

  // Find widest slice (likely at armpit level)
  const widestSlice = slices.reduce((max, s) => s.width > max.width ? s : max);

  return {
    left: { x: widestSlice.leftX, y: widestSlice.y },
    right: { x: widestSlice.rightX, y: widestSlice.y },
  };
}

/**
 * Detect anchor points for bottoms (pants, skirts)
 */
function detectBottomAnchors(
  points: Array<{ x: number; y: number }>,
  imageWidth: number,
  imageHeight: number
): ClothingAnchorPoints {
  const bounds = {
    minX: Math.min(...points.map(p => p.x)),
    maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxY: Math.max(...points.map(p => p.y)),
    width: 0,
    height: 0,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  // Detect waistband
  const waistband = detectWaistband(points, bounds);

  // Detect hem
  const hem = detectHem(points, bounds);

  return {
    waistbandLeft: waistband?.left ? normalizePoint(waistband.left, imageWidth, imageHeight) : undefined,
    waistbandRight: waistband?.right ? normalizePoint(waistband.right, imageWidth, imageHeight) : undefined,
    waistbandCenter: waistband?.center ? normalizePoint(waistband.center, imageWidth, imageHeight) : undefined,
    hemLeft: hem?.left ? normalizePoint(hem.left, imageWidth, imageHeight) : undefined,
    hemRight: hem?.right ? normalizePoint(hem.right, imageWidth, imageHeight) : undefined,
    detectedType: 'bottoms',
    confidence: (waistband && hem) ? 0.8 : 0.5,
    method: 'feature-detection',
    contentBounds: {
      x: bounds.minX / imageWidth,
      y: bounds.minY / imageHeight,
      width: bounds.width / imageWidth,
      height: bounds.height / imageHeight,
    },
  };
}

/**
 * Detect waistband points (top edge of bottoms)
 */
function detectWaistband(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): { left: { x: number; y: number }; right: { x: number; y: number }; center: { x: number; y: number } } | null {
  // Search in top 15% of garment
  const searchBottom = bounds.minY + bounds.height * 0.15;
  const topLine = points.filter(p => p.y <= searchBottom);

  if (topLine.length < 5) return null;

  // Sort by x coordinate
  topLine.sort((a, b) => a.x - b.x);

  const leftmost = topLine[0];
  const rightmost = topLine[topLine.length - 1];
  const centerX = (leftmost.x + rightmost.x) / 2;
  const centerPoint = topLine.reduce((closest, p) =>
    Math.abs(p.x - centerX) < Math.abs(closest.x - centerX) ? p : closest
  );

  return {
    left: leftmost,
    right: rightmost,
    center: centerPoint,
  };
}

/**
 * Detect hem points (bottom edge of bottoms)
 */
function detectHem(
  points: Array<{ x: number; y: number }>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): { left: { x: number; y: number }; right: { x: number; y: number } } | null {
  // Search in bottom 10% of garment
  const searchTop = bounds.minY + bounds.height * 0.9;
  const bottomPoints = points.filter(p => p.y >= searchTop);

  if (bottomPoints.length < 3) return null;

  const leftmost = bottomPoints.reduce((left, p) => p.x < left.x ? p : left);
  const rightmost = bottomPoints.reduce((right, p) => p.x > right.x ? p : right);

  return { left: leftmost, right: rightmost };
}

/**
 * Validate shoulder symmetry
 */
function validateSymmetry(
  leftPoint: { x: number; y: number },
  rightPoint: { x: number; y: number },
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
): number {
  const centerX = bounds.minX + bounds.width / 2;
  const leftDistance = Math.abs(leftPoint.x - centerX);
  const rightDistance = Math.abs(rightPoint.x - centerX);

  const symmetryRatio = Math.min(leftDistance, rightDistance) / Math.max(leftDistance, rightDistance);
  return symmetryRatio;
}

/**
 * Fallback: Detect anchor points from colored pixel region
 */
function fallbackColoredPixelDetection(
  image: HTMLImageElement,
  detectedType: ClothingCategory
): ClothingAnchorPoints {
  console.log('Using fallback colored pixel detection');

  // Find all colored (non-transparent) pixels
  const coloredPixels = detectColoredPixels(image);

  if (coloredPixels.length === 0) {
    throw new Error('No colored pixels detected in image');
  }

  // Calculate convex hull
  const hull = calculateConvexHull(coloredPixels);

  // Find bounds
  const bounds = {
    minX: Math.min(...hull.map(p => p.x)),
    maxX: Math.max(...hull.map(p => p.x)),
    minY: Math.min(...hull.map(p => p.y)),
    maxY: Math.max(...hull.map(p => p.y)),
    width: 0,
    height: 0,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  if (detectedType === 'tops') {
    // Find widest points near top (shoulders)
    const topRegion = hull.filter(p => p.y < bounds.minY + bounds.height * 0.2);
    const leftShoulder = topRegion.reduce((leftmost, p) => p.x < leftmost.x ? p : leftmost, topRegion[0]);
    const rightShoulder = topRegion.reduce((rightmost, p) => p.x > rightmost.x ? p : rightmost, topRegion[0]);

    return {
      leftShoulder: normalizePoint(leftShoulder, image.width, image.height),
      rightShoulder: normalizePoint(rightShoulder, image.width, image.height),
      detectedType: 'tops',
      confidence: 0.5,
      method: 'fallback',
      contentBounds: {
        x: bounds.minX / image.width,
        y: bounds.minY / image.height,
        width: bounds.width / image.width,
        height: bounds.height / image.height,
      },
    };
  } else {
    // Bottoms: top corners = waistband, bottom corners = hem
    const topLeft = hull.reduce((best, p) =>
      (p.y < best.y || (p.y === best.y && p.x < best.x)) ? p : best
    );
    const topRight = hull.reduce((best, p) =>
      (p.y < best.y || (p.y === best.y && p.x > best.x)) ? p : best
    );
    const bottomLeft = hull.reduce((best, p) =>
      (p.y > best.y || (p.y === best.y && p.x < best.x)) ? p : best
    );
    const bottomRight = hull.reduce((best, p) =>
      (p.y > best.y || (p.y === best.y && p.x > best.x)) ? p : best
    );

    return {
      waistbandLeft: normalizePoint(topLeft, image.width, image.height),
      waistbandRight: normalizePoint(topRight, image.width, image.height),
      waistbandCenter: normalizePoint({
        x: (topLeft.x + topRight.x) / 2,
        y: (topLeft.y + topRight.y) / 2,
      }, image.width, image.height),
      hemLeft: normalizePoint(bottomLeft, image.width, image.height),
      hemRight: normalizePoint(bottomRight, image.width, image.height),
      detectedType: 'bottoms',
      confidence: 0.5,
      method: 'fallback',
      contentBounds: {
        x: bounds.minX / image.width,
        y: bounds.minY / image.height,
        width: bounds.width / image.width,
        height: bounds.height / image.height,
      },
    };
  }
}
