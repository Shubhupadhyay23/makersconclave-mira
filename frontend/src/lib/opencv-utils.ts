/**
 * OpenCV.js utility functions for image processing
 * Requires OpenCV.js to be loaded globally
 */

declare const cv: any;

/**
 * Check if OpenCV is available
 */
export function isOpenCVReady(): boolean {
  return typeof window !== 'undefined' && !!(window as any).cv && !!(window as any).cv.Mat;
}

/**
 * Convert HTMLImageElement to cv.Mat
 */
export function imageToMat(image: HTMLImageElement): any {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.drawImage(image, 0, 0);
  return cv.imread(canvas);
}

/**
 * Preprocess image for edge detection
 * - Convert to grayscale
 * - Apply contrast enhancement (CLAHE)
 * - Optional Gaussian blur
 */
export function preprocessImage(src: any, applyBlur: boolean = true): any {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  // Convert to grayscale
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Contrast enhancement using CLAHE
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const enhanced = new cv.Mat();
  clahe.apply(gray, enhanced);
  clahe.delete();

  // Optional Gaussian blur to reduce noise
  if (applyBlur) {
    const blurred = new cv.Mat();
    cv.GaussianBlur(enhanced, blurred, new cv.Size(3, 3), 0);
    gray.delete();
    enhanced.delete();
    return blurred;
  }

  gray.delete();
  return enhanced;
}

/**
 * Detect edges using Canny edge detection
 */
export function detectEdges(src: any, lowThreshold: number = 50, highThreshold: number = 150): any {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const edges = new cv.Mat();
  cv.Canny(src, edges, lowThreshold, highThreshold);
  return edges;
}

/**
 * Find contours in edge-detected image
 */
export function findContours(edges: any): { contours: any; hierarchy: any } {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Find external contours only (ignore holes)
  cv.findContours(
    edges,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );

  return { contours, hierarchy };
}

/**
 * Get the largest contour by area
 */
export function getLargestContour(contours: any): any | null {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  if (contours.size() === 0) return null;

  let largestIdx = 0;
  let largestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area > largestArea) {
      largestArea = area;
      largestIdx = i;
    }
  }

  return largestArea > 100 ? contours.get(largestIdx) : null; // Minimum area threshold
}

/**
 * Convert contour to array of points
 */
export function contourToPoints(contour: any): Array<{ x: number; y: number }> {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < contour.data32S.length; i += 2) {
    points.push({
      x: contour.data32S[i],
      y: contour.data32S[i + 1],
    });
  }
  return points;
}

/**
 * Calculate bounding rectangle of contour
 */
export function getBoundingRect(contour: any): { x: number; y: number; width: number; height: number } {
  if (!isOpenCVReady()) {
    throw new Error('OpenCV.js is not loaded');
  }

  const rect = cv.boundingRect(contour);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Calculate curvature at a point using neighbors
 * Negative = concave (inward), Positive = convex (outward)
 */
export function calculateCurvature(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number }
): number {
  const v1 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
  const crossProduct = v1.x * v2.y - v1.y * v2.x;
  return crossProduct;
}

/**
 * Analyze contour complexity in a vertical region
 * Returns number of inflection points (direction changes)
 */
export function measureContourComplexity(
  points: Array<{ x: number; y: number }>,
  imageHeight: number,
  startY: number,
  endY: number
): number {
  let inflectionCount = 0;
  let prevDirection = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const y = points[i].y / imageHeight; // Normalize
    if (y < startY || y > endY) continue;

    const direction = Math.sign(points[i + 1].x - points[i].x);
    if (direction !== prevDirection && prevDirection !== 0) {
      inflectionCount++;
    }
    prevDirection = direction;
  }

  return points.length > 0 ? inflectionCount / points.length : 0;
}

/**
 * Detect colored (non-transparent) pixels in an image
 */
export function detectColoredPixels(image: HTMLImageElement): Array<{ x: number; y: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, image.width, image.height);
  const pixels = imageData.data;

  const coloredPixels: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const alpha = pixels[(y * image.width + x) * 4 + 3];
      if (alpha > 10) { // Threshold for "visible"
        coloredPixels.push({ x, y });
      }
    }
  }

  return coloredPixels;
}

/**
 * Calculate convex hull of points
 */
export function calculateConvexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (!isOpenCVReady() || points.length < 3) {
    return points;
  }

  // Convert points to cv.Mat
  const pointsMat = cv.matFromArray(points.length, 1, cv.CV_32SC2, points.flatMap(p => [p.x, p.y]));

  const hull = new cv.Mat();
  cv.convexHull(pointsMat, hull, false, true);

  // Convert back to array
  const hullPoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < hull.data32S.length; i += 2) {
    hullPoints.push({
      x: hull.data32S[i],
      y: hull.data32S[i + 1],
    });
  }

  pointsMat.delete();
  hull.delete();

  return hullPoints;
}

/**
 * Normalize point coordinates relative to image dimensions
 */
export function normalizePoint(
  point: { x: number; y: number },
  imageWidth: number,
  imageHeight: number
): { x: number; y: number } {
  return {
    x: point.x / imageWidth,
    y: point.y / imageHeight,
  };
}

/**
 * Cleanup OpenCV matrices
 */
export function cleanup(...mats: any[]) {
  for (const mat of mats) {
    if (mat && typeof mat.delete === 'function') {
      try {
        mat.delete();
      } catch (e) {
        console.warn('Failed to delete cv.Mat:', e);
      }
    }
  }
}
