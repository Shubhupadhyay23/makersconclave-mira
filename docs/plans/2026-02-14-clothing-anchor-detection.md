# Clothing Anchor Point Detection - Technical Specification

**Date**: 2026-02-14
**Purpose**: Automatically detect clothing anchor points (shoulders, collar, etc.) using computer vision for precise body-to-garment alignment
**Scope**: Frontend image processing module for mirror display test page

## Overview

Create an intelligent anchor point detection system that analyzes clothing images to find precise alignment points (shoulders, collar, waistband, etc.) using OpenCV.js edge detection and contour analysis. This replaces the current bounding-box-based approach with pixel-accurate anchor detection, enabling perfect shoulder-to-shoulder alignment and proper garment draping.

## Problem Statement

**Current System**: Uses transparent pixel bounding box to determine clothing boundaries, then stretches to fit body region. This works but:
- Doesn't align clothing features (shoulders) to body landmarks (shoulder points)
- Assumes clothing is centered and uniformly distributed in the image
- Cannot handle garments with unusual shapes or off-center positioning
- Results in misaligned clothing where shirt shoulders don't match body shoulders

**Proposed Solution**: Use computer vision to detect actual clothing features (shoulder seams, collar points, waistband) and map them directly to corresponding body landmarks for pixel-perfect alignment.

## Goals

1. **Accurate shoulder alignment** - Clothing shoulder points match body shoulder landmarks exactly
2. **Category awareness** - Different detection logic for tops vs bottoms vs dresses
3. **Robust fallback** - Graceful degradation to colored-pixel analysis if feature detection fails
4. **Fast detection** - Process images in <200ms to avoid UI lag
5. **Visual debugging** - Clear visualization of detected anchor points for troubleshooting

## System Architecture

### Component Structure

```
frontend/src/lib/
├── anchor-detection.ts          # Main detection module (new)
│   ├── detectClothingAnchors()  # Entry point function
│   ├── classifyClothingType()   # Auto-detect tops/bottoms/dress
│   ├── detectTopAnchors()       # Shoulder/collar/armpit detection
│   ├── detectBottomAnchors()    # Waistband/hem detection
│   └── fallbackColoredPixelDetection() # Robust fallback
├── opencv-utils.ts               # OpenCV helpers (new)
│   ├── preprocessImage()        # Contrast enhancement
│   ├── detectEdges()            # Canny edge detection
│   ├── findContours()           # Contour extraction
│   └── analyzeContourComplexity() # Shape analysis
└── clothing-transform.ts         # Updated to use anchor points
    └── getClothingQuad()        # Modified to accept anchor points
```

### Data Flow

```
Clothing Image (PNG with transparency)
    ↓
Preprocess (contrast enhancement)
    ↓
Detect edges (Canny) + Find contours
    ↓
Classify clothing type (tops/bottoms/dress)
    ↓
    ├─→ If tops: Detect shoulders, collar, armpits
    ├─→ If bottoms: Detect waistband, hem, center
    └─→ If dress: Detect shoulders + hem
    ↓
Validate anchor points (symmetry check)
    ↓
    ├─→ Pass: Return normalized anchor coordinates
    └─→ Fail: Fallback to colored-pixel shape analysis
    ↓
Map anchor points → body landmarks
    ↓
Render clothing with precise alignment
```

## Technical Specifications

### Input

```typescript
interface DetectionInput {
  image: HTMLImageElement;           // Loaded clothing image
  category?: ClothingCategory;       // Optional hint (auto-detect if not provided)
}
```

### Output

```typescript
interface ClothingAnchorPoints {
  // For tops
  leftShoulder?: { x: number; y: number };    // 0-1 normalized coords
  rightShoulder?: { x: number; y: number };
  collarCenter?: { x: number; y: number };
  collarLeft?: { x: number; y: number };
  collarRight?: { x: number; y: number };
  leftArmpit?: { x: number; y: number };
  rightArmpit?: { x: number; y: number };

  // For bottoms
  waistbandLeft?: { x: number; y: number };
  waistbandRight?: { x: number; y: number };
  waistbandCenter?: { x: number; y: number };
  hemLeft?: { x: number; y: number };
  hemRight?: { x: number; y: number };

  // Metadata
  detectedType: 'tops' | 'bottoms' | 'dress';
  confidence: number;                          // 0-1 detection confidence
  method: 'feature-detection' | 'fallback';    // Which method was used
  contentBounds: {                             // Bounding box of colored pixels
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
```

## Core Algorithms

### 1. Clothing Type Classification

**Goal**: Automatically determine if image contains tops, bottoms, or dress

**Method**: Analyze contour shape characteristics

```typescript
function classifyClothingType(contour: Contour): ClothingType {
  // 1. Calculate aspect ratio
  const bounds = getBoundingRect(contour);
  const aspectRatio = bounds.height / bounds.width;

  // 2. Analyze presence of features
  const hasCollar = detectCollarFeature(contour);
  const hasLegs = detectLegSplit(contour);        // Two vertical splits at bottom
  const hasWaistband = detectWaistband(contour);  // Horizontal line near top

  // 3. Measure contour complexity at different heights
  const topComplexity = measureComplexity(contour, 0, 0.3);      // Top 30%
  const middleComplexity = measureComplexity(contour, 0.3, 0.7); // Middle 40%
  const bottomComplexity = measureComplexity(contour, 0.7, 1.0); // Bottom 30%

  // Decision logic
  if (hasCollar || (topComplexity > threshold && aspectRatio < 1.5)) {
    return 'tops';
  }
  if (hasLegs || (hasWaistband && bottomComplexity > threshold)) {
    return 'bottoms';
  }
  if (aspectRatio > 2.0 && hasCollar) {
    return 'dress';
  }

  // Default fallback based on aspect ratio
  return aspectRatio < 1.3 ? 'tops' : 'bottoms';
}
```

**Contour Complexity Metric**:
```typescript
function measureComplexity(contour: Contour, startY: number, endY: number): number {
  // Count inflection points (direction changes) in the contour within Y range
  // More inflection points = more complex shape
  // Legs create high complexity at bottom, collars at top
  let inflectionCount = 0;
  let prevDirection = 0;

  for (let i = 1; i < contour.length - 1; i++) {
    const y = contour[i].y / imageHeight; // Normalize
    if (y < startY || y > endY) continue;

    const direction = Math.sign(contour[i+1].x - contour[i].x);
    if (direction !== prevDirection && prevDirection !== 0) {
      inflectionCount++;
    }
    prevDirection = direction;
  }

  return inflectionCount / contour.length; // Normalized complexity score
}
```

### 2. Shoulder Detection (Tops)

**Goal**: Find left and right shoulder points

**Method**: Find topmost left/right corners of garment contour

```typescript
function detectShoulders(contour: Contour): { left: Point; right: Point } | null {
  // 1. Find content bounding box
  const bounds = getColoredPixelBounds(contour);

  // 2. Define shoulder search region (top 20% of garment)
  const searchHeight = bounds.height * 0.2;

  // 3. Find leftmost and rightmost points in search region
  let leftmost: Point | null = null;
  let rightmost: Point | null = null;

  for (const point of contour) {
    const relativeY = (point.y - bounds.y) / bounds.height;
    if (relativeY > 0.2) continue; // Outside search region

    if (!leftmost || point.x < leftmost.x) {
      leftmost = point;
    }
    if (!rightmost || point.x > rightmost.x) {
      rightmost = point;
    }
  }

  // 4. Validate symmetry
  if (!leftmost || !rightmost) return null;

  const centerX = (bounds.x + bounds.width / 2);
  const leftDistance = Math.abs(leftmost.x - centerX);
  const rightDistance = Math.abs(rightmost.x - centerX);
  const symmetryRatio = Math.min(leftDistance, rightDistance) / Math.max(leftDistance, rightDistance);

  // Require at least 70% symmetry
  if (symmetryRatio < 0.7) {
    console.warn('Shoulder symmetry check failed:', symmetryRatio);
    // Still return but flag low confidence
  }

  return {
    left: normalizePoint(leftmost, bounds),
    right: normalizePoint(rightmost, bounds)
  };
}
```

### 3. Collar/Neckline Detection (Tops)

**Goal**: Find collar center and edge points

**Method**: Detect highest concave region in top contour

```typescript
function detectCollar(contour: Contour): { center: Point; left: Point; right: Point } | null {
  const bounds = getColoredPixelBounds(contour);

  // 1. Sample top edge of contour (top 15%)
  const topEdge: Point[] = [];
  for (const point of contour) {
    const relativeY = (point.y - bounds.y) / bounds.height;
    if (relativeY <= 0.15) {
      topEdge.push(point);
    }
  }

  if (topEdge.length < 10) return null; // Not enough points

  // 2. Find concave regions (inward curves)
  // Calculate curvature at each point using neighbors
  const concavePoints: Array<{ point: Point; curvature: number }> = [];

  for (let i = 2; i < topEdge.length - 2; i++) {
    const prev = topEdge[i - 2];
    const curr = topEdge[i];
    const next = topEdge[i + 2];

    // Calculate curvature (positive = convex, negative = concave)
    const curvature = calculateCurvature(prev, curr, next);

    if (curvature < -0.1) { // Concave threshold
      concavePoints.push({ point: curr, curvature });
    }
  }

  if (concavePoints.length === 0) {
    // No collar detected, use highest center point as fallback
    const centerX = bounds.x + bounds.width / 2;
    const centerPoint = topEdge.reduce((closest, p) =>
      Math.abs(p.x - centerX) < Math.abs(closest.x - centerX) ? p : closest
    );
    return {
      center: normalizePoint(centerPoint, bounds),
      left: normalizePoint(topEdge[0], bounds),
      right: normalizePoint(topEdge[topEdge.length - 1], bounds)
    };
  }

  // 3. Find the most concave point near center (likely the collar)
  const centerX = bounds.x + bounds.width / 2;
  const collarCenter = concavePoints.reduce((best, curr) => {
    const distToCenter = Math.abs(curr.point.x - centerX);
    const bestDistToCenter = Math.abs(best.point.x - centerX);
    return distToCenter < bestDistToCenter ? curr : best;
  });

  // 4. Find collar edges (leftmost and rightmost points near collar center height)
  const collarY = collarCenter.point.y;
  const collarLeft = topEdge.reduce((leftmost, p) =>
    Math.abs(p.y - collarY) < 5 && p.x < leftmost.x ? p : leftmost
  , topEdge[0]);
  const collarRight = topEdge.reduce((rightmost, p) =>
    Math.abs(p.y - collarY) < 5 && p.x > rightmost.x ? p : rightmost
  , topEdge[topEdge.length - 1]);

  return {
    center: normalizePoint(collarCenter.point, bounds),
    left: normalizePoint(collarLeft, bounds),
    right: normalizePoint(collarRight, bounds)
  };
}

function calculateCurvature(p1: Point, p2: Point, p3: Point): number {
  // Calculate curvature using three points
  // Negative = concave (inward), Positive = convex (outward)
  const v1 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
  const crossProduct = v1.x * v2.y - v1.y * v2.x;
  return crossProduct;
}
```

### 4. Armpit/Sleeve Junction Detection (Tops)

**Goal**: Find where sleeves connect to torso

**Method**: Detect the widest horizontal span transitioning to narrower (sleeve start)

```typescript
function detectArmpits(contour: Contour, shoulders: { left: Point; right: Point }): { left: Point; right: Point } | null {
  const bounds = getColoredPixelBounds(contour);

  // Search in region between shoulders and mid-torso (20%-50% down)
  const searchTop = bounds.y + bounds.height * 0.2;
  const searchBottom = bounds.y + bounds.height * 0.5;

  // Scan horizontal slices and find where width decreases significantly
  const sliceWidth: Array<{ y: number; width: number; leftX: number; rightX: number }> = [];

  for (let y = searchTop; y < searchBottom; y += 2) {
    const pointsAtY = contour.filter(p => Math.abs(p.y - y) < 2);
    if (pointsAtY.length < 2) continue;

    const leftX = Math.min(...pointsAtY.map(p => p.x));
    const rightX = Math.max(...pointsAtY.map(p => p.x));
    sliceWidth.push({ y, width: rightX - leftX, leftX, rightX });
  }

  if (sliceWidth.length < 3) return null;

  // Find where width starts decreasing (transition from shoulders to torso)
  let maxWidthIdx = 0;
  for (let i = 1; i < sliceWidth.length; i++) {
    if (sliceWidth[i].width > sliceWidth[maxWidthIdx].width) {
      maxWidthIdx = i;
    }
  }

  // Armpits are at the max width slice (where shoulders end)
  const armpitSlice = sliceWidth[maxWidthIdx];

  return {
    left: normalizePoint({ x: armpitSlice.leftX, y: armpitSlice.y }, bounds),
    right: normalizePoint({ x: armpitSlice.rightX, y: armpitSlice.y }, bounds)
  };
}
```

### 5. Waistband Detection (Bottoms)

**Goal**: Find waistband left, right, and center points

**Method**: Detect horizontal line near top of garment

```typescript
function detectWaistband(contour: Contour): { left: Point; right: Point; center: Point } | null {
  const bounds = getColoredPixelBounds(contour);

  // Search in top 15% of garment
  const searchBottom = bounds.y + bounds.height * 0.15;

  // Find the topmost relatively straight horizontal line
  const topLine: Point[] = [];
  for (const point of contour) {
    if (point.y <= searchBottom) {
      topLine.push(point);
    }
  }

  if (topLine.length < 10) return null;

  // Sort by x coordinate
  topLine.sort((a, b) => a.x - b.x);

  // Find leftmost, rightmost, and center
  const leftmost = topLine[0];
  const rightmost = topLine[topLine.length - 1];
  const centerX = (leftmost.x + rightmost.x) / 2;
  const centerPoint = topLine.reduce((closest, p) =>
    Math.abs(p.x - centerX) < Math.abs(closest.x - centerX) ? p : closest
  );

  return {
    left: normalizePoint(leftmost, bounds),
    right: normalizePoint(rightmost, bounds),
    center: normalizePoint(centerPoint, bounds)
  };
}
```

### 6. Hem Detection (Bottoms)

**Goal**: Find hem left and right anchor points

**Method**: Find bottom corners of garment

```typescript
function detectHem(contour: Contour): { left: Point; right: Point } | null {
  const bounds = getColoredPixelBounds(contour);

  // Search in bottom 10% of garment
  const searchTop = bounds.y + bounds.height * 0.9;

  let leftmost: Point | null = null;
  let rightmost: Point | null = null;

  for (const point of contour) {
    if (point.y < searchTop) continue;

    if (!leftmost || point.x < leftmost.x) {
      leftmost = point;
    }
    if (!rightmost || point.x > rightmost.x) {
      rightmost = point;
    }
  }

  if (!leftmost || !rightmost) return null;

  return {
    left: normalizePoint(leftmost, bounds),
    right: normalizePoint(rightmost, bounds)
  };
}
```

### 7. Fallback: Colored Pixel Shape Analysis

**Goal**: When feature detection fails, analyze colored pixel distribution to estimate anchor points

**Method**: Find convex hull of colored region and identify extrema

```typescript
function fallbackColoredPixelDetection(
  image: HTMLImageElement,
  detectedType: ClothingType
): ClothingAnchorPoints {
  // 1. Find all colored (non-transparent) pixels
  const coloredPixels = detectColoredPixels(image);

  if (coloredPixels.length === 0) {
    throw new Error('No colored pixels detected in image');
  }

  // 2. Calculate convex hull of colored region
  const hull = calculateConvexHull(coloredPixels);

  // 3. Find extrema points
  const bounds = getBoundingBox(coloredPixels);
  const extrema = findExtrema(hull, bounds);

  // 4. Generate anchor points based on clothing type
  if (detectedType === 'tops') {
    // Find widest points near top (shoulders)
    const topRegion = hull.filter(p => p.y < bounds.y + bounds.height * 0.2);
    const leftShoulder = topRegion.reduce((leftmost, p) => p.x < leftmost.x ? p : leftmost);
    const rightShoulder = topRegion.reduce((rightmost, p) => p.x > rightmost.x ? p : rightmost);

    return {
      leftShoulder: normalizePoint(leftShoulder, image),
      rightShoulder: normalizePoint(rightShoulder, image),
      detectedType: 'tops',
      confidence: 0.5,
      method: 'fallback',
      contentBounds: bounds
    };
  } else {
    // Bottoms: top corners = waistband, bottom corners = hem
    const topLeft = hull.reduce((best, p) =>
      p.y < best.y || (p.y === best.y && p.x < best.x) ? p : best
    );
    const topRight = hull.reduce((best, p) =>
      p.y < best.y || (p.y === best.y && p.x > best.x) ? p : best
    );
    const bottomLeft = hull.reduce((best, p) =>
      p.y > best.y || (p.y === best.y && p.x < best.x) ? p : best
    );
    const bottomRight = hull.reduce((best, p) =>
      p.y > best.y || (p.y === best.y && p.x > best.x) ? p : best
    );

    return {
      waistbandLeft: normalizePoint(topLeft, image),
      waistbandRight: normalizePoint(topRight, image),
      waistbandCenter: normalizePoint({
        x: (topLeft.x + topRight.x) / 2,
        y: (topLeft.y + topRight.y) / 2
      }, image),
      hemLeft: normalizePoint(bottomLeft, image),
      hemRight: normalizePoint(bottomRight, image),
      detectedType: 'bottoms',
      confidence: 0.5,
      method: 'fallback',
      contentBounds: bounds
    };
  }
}
```

## OpenCV.js Integration

### Library Setup

**Loading Strategy**: Load OpenCV.js on page initialization

```typescript
// In page.tsx or app initialization
useEffect(() => {
  async function loadOpenCV() {
    if (window.cv) return; // Already loaded

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/opencv.js@4.9.0/opencv.js';
    script.async = true;

    script.onload = () => {
      // Wait for cv to be ready
      cv['onRuntimeInitialized'] = () => {
        console.log('OpenCV.js loaded successfully');
        setOpenCVReady(true);
      };
    };

    script.onerror = () => {
      console.error('Failed to load OpenCV.js');
    };

    document.body.appendChild(script);
  }

  loadOpenCV();
}, []);
```

**Library Size**: ~8MB download, ~20MB memory usage when loaded

### Preprocessing Pipeline

```typescript
function preprocessImage(src: cv.Mat): cv.Mat {
  // 1. Convert to grayscale
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // 2. Contrast enhancement (CLAHE - Contrast Limited Adaptive Histogram Equalization)
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const enhanced = new cv.Mat();
  clahe.apply(gray, enhanced);

  // 3. Gaussian blur to reduce noise (optional, mild)
  const blurred = new cv.Mat();
  cv.GaussianBlur(enhanced, blurred, new cv.Size(3, 3), 0);

  // Cleanup
  gray.delete();
  enhanced.delete();

  return blurred;
}
```

### Edge Detection

```typescript
function detectEdges(src: cv.Mat): cv.Mat {
  const edges = new cv.Mat();

  // Canny edge detection
  // Low threshold: 50, High threshold: 150
  cv.Canny(src, edges, 50, 150);

  return edges;
}
```

### Contour Finding

```typescript
function findContours(edges: cv.Mat): cv.MatVector {
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

  hierarchy.delete();

  return contours;
}
```

### Largest Contour Selection

```typescript
function getLargestContour(contours: cv.MatVector): cv.Mat | null {
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

  return contours.get(largestIdx);
}
```

## Integration with Existing Code

### Modified getClothingQuad()

```typescript
// In clothing-transform.ts
export function getClothingQuad(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number,
  anchorPoints?: ClothingAnchorPoints  // NEW: Optional anchor points
): ClothingQuad | null {
  // Check visibility
  if (!areLandmarksVisible(landmarks, category)) {
    return null;
  }

  // NEW: If anchor points provided, use them for precise mapping
  if (anchorPoints && anchorPoints.leftShoulder && anchorPoints.rightShoulder) {
    return mapAnchorsToBody(landmarks, category, anchorPoints, canvasWidth, canvasHeight);
  }

  // Fallback to original landmark-based quad (existing code)
  // ... existing implementation
}

function mapAnchorsToBody(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  anchors: ClothingAnchorPoints,
  canvasWidth: number,
  canvasHeight: number
): ClothingQuad {
  if (category === 'tops') {
    // Direct mapping: clothing shoulders → body shoulders
    const lShoulderLandmark = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rShoulderLandmark = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];

    // Convert body landmarks to pixels
    const bodyTopLeft = landmarkToPixel(lShoulderLandmark, canvasWidth, canvasHeight);
    const bodyTopRight = landmarkToPixel(rShoulderLandmark, canvasWidth, canvasHeight);
    const bodyBottomLeft = landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight);
    const bodyBottomRight = landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight);

    // Note: anchorPoints are normalized (0-1), body landmarks are in pixels
    // The quad corners should align:
    // - Clothing top-left (left shoulder) → Body left shoulder
    // - Clothing top-right (right shoulder) → Body right shoulder
    // - Clothing bottom-left → Body left hip
    // - Clothing bottom-right → Body right hip

    return {
      topLeft: bodyTopLeft,
      topRight: bodyTopRight,
      bottomLeft: bodyBottomLeft,
      bottomRight: bodyBottomRight
    };
  } else {
    // Bottoms: waistband → hips, hem → ankles
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const lAnkleLandmark = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
    const rAnkleLandmark = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

    return {
      topLeft: landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight),
      topRight: landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight),
      bottomLeft: landmarkToPixel(lAnkleLandmark, canvasWidth, canvasHeight),
      bottomRight: landmarkToPixel(rAnkleLandmark, canvasWidth, canvasHeight)
    };
  }
}
```

### Updated ClothingCanvas Rendering

```typescript
// In ClothingCanvas.tsx

// Add state for anchor points
const anchorPointsRef = useRef<Map<string, ClothingAnchorPoints>>(new Map());

// Detect anchor points when image loads
img.onload = () => {
  if (mounted) {
    // Detect content bounds (existing code)
    const bounds = detectImageBounds(img);
    boundsRef.current.set(item.id, bounds);

    // NEW: Detect anchor points
    detectClothingAnchors({ image: img, category: item.category })
      .then(anchors => {
        anchorPointsRef.current.set(item.id, anchors);
        console.log('Anchor points detected:', anchors);
      })
      .catch(err => {
        console.error('Anchor detection failed:', err);
      });

    loaded.add(item.id);
    setLoadedImages(new Set(loaded));
  }
  resolve();
};

// Use anchor points in rendering
const anchors = anchorPointsRef.current.get(item.id);

const quad = getClothingQuad(
  poseToRender.landmarks,
  item.category,
  width,
  height,
  anchors  // NEW: Pass anchor points
);
```

### Caching Strategy

**Memory caching per image URL**:

```typescript
// In anchor-detection.ts

const anchorCache = new Map<string, ClothingAnchorPoints>();

export async function detectClothingAnchors(
  input: DetectionInput
): Promise<ClothingAnchorPoints> {
  const cacheKey = input.image.src;

  // Check cache first
  if (anchorCache.has(cacheKey)) {
    console.log('Using cached anchor points for:', cacheKey);
    return anchorCache.get(cacheKey)!;
  }

  // Perform detection
  const anchors = await performDetection(input);

  // Cache result
  anchorCache.set(cacheKey, anchors);

  return anchors;
}

// Optional: Clear cache when needed
export function clearAnchorCache() {
  anchorCache.clear();
}
```

## Debug Visualization

### Anchor Point Overlay

```typescript
// New component: DebugAnchorOverlay.tsx

interface DebugAnchorOverlayProps {
  image: HTMLImageElement;
  anchors: ClothingAnchorPoints;
  visible: boolean;
}

export function DebugAnchorOverlay({ image, anchors, visible }: DebugAnchorOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw original image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    // Draw anchor points
    const drawPoint = (point: { x: number; y: number } | undefined, color: string, label: string) => {
      if (!point) return;

      const x = point.x * canvas.width;
      const y = point.y * canvas.height;

      // Draw circle
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();

      // Draw label
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.font = '14px sans-serif';
      ctx.strokeText(label, x + 12, y + 5);
      ctx.fillText(label, x + 12, y + 5);
    };

    // Shoulders
    drawPoint(anchors.leftShoulder, '#ff0000', 'L Shoulder');
    drawPoint(anchors.rightShoulder, '#ff0000', 'R Shoulder');

    // Collar
    drawPoint(anchors.collarCenter, '#00ff00', 'Collar');
    drawPoint(anchors.collarLeft, '#00ff00', 'C-L');
    drawPoint(anchors.collarRight, '#00ff00', 'C-R');

    // Armpits
    drawPoint(anchors.leftArmpit, '#0000ff', 'L Armpit');
    drawPoint(anchors.rightArmpit, '#0000ff', 'R Armpit');

    // Waistband
    drawPoint(anchors.waistbandLeft, '#ff00ff', 'W-L');
    drawPoint(anchors.waistbandCenter, '#ff00ff', 'Waist');
    drawPoint(anchors.waistbandRight, '#ff00ff', 'W-R');

    // Hem
    drawPoint(anchors.hemLeft, '#ffff00', 'Hem-L');
    drawPoint(anchors.hemRight, '#ffff00', 'Hem-R');

    // Draw content bounds
    if (anchors.contentBounds) {
      const b = anchors.contentBounds;
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        b.x * canvas.width,
        b.y * canvas.height,
        b.width * canvas.width,
        b.height * canvas.height
      );
    }

    // Draw metadata
    ctx.fillStyle = '#000';
    ctx.fillRect(10, 10, 300, 80);
    ctx.fillStyle = '#fff';
    ctx.font = '14px monospace';
    ctx.fillText(`Type: ${anchors.detectedType}`, 20, 30);
    ctx.fillText(`Confidence: ${(anchors.confidence * 100).toFixed(0)}%`, 20, 50);
    ctx.fillText(`Method: ${anchors.method}`, 20, 70);

  }, [image, anchors, visible]);

  if (!visible) return null;

  return (
    <canvas
      ref={canvasRef}
      width={image.width}
      height={image.height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 100,
        border: '2px solid cyan',
      }}
    />
  );
}
```

### Contour Visualization

```typescript
// Function to render detected contours for debugging

function visualizeContours(
  image: HTMLImageElement,
  contours: cv.MatVector,
  selectedIdx: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  // Convert image to cv.Mat
  const src = cv.imread(image);

  // Draw all contours in gray
  cv.drawContours(src, contours, -1, new cv.Scalar(128, 128, 128), 1);

  // Draw selected contour in green
  cv.drawContours(src, contours, selectedIdx, new cv.Scalar(0, 255, 0), 2);

  // Render to canvas
  cv.imshow(canvas, src);

  // Cleanup
  src.delete();

  return canvas;
}
```

## Testing Strategy

### Visual Test Page

Create a side-by-side comparison view:

```
┌─────────────────────────┬─────────────────────────┐
│  Original Image         │  Detected Anchors       │
│  (raw clothing photo)   │  (with overlay)         │
├─────────────────────────┼─────────────────────────┤
│  Edge Detection         │  Contours               │
│  (Canny output)         │  (detected outlines)    │
├─────────────────────────┴─────────────────────────┤
│  Final Render on Body                             │
│  (clothing mapped to body with anchors)           │
└───────────────────────────────────────────────────┘
```

**Test Controls**:
- Upload clothing image button
- Detection method toggle (feature / fallback)
- Preprocessing options checkboxes
- Re-detect button
- Export anchor points JSON

### Test Images

Curate a test set covering:
- Standard flat-lay shirts (easy)
- Asymmetric designs (challenging)
- Patterned clothing (noise)
- Folded/wrinkled garments (difficult)
- Bottoms: jeans, skirts, shorts
- Dresses (full-body)

## Performance Targets

- **Detection time**: <200ms per image on typical hardware
- **Memory usage**: <50MB additional RAM during detection
- **Cache hit rate**: >80% (most images detected once, cached thereafter)
- **Accuracy**: >85% of test images detect shoulders within 5% of manual annotation

## Error Handling

### Detection Failures

```typescript
try {
  const anchors = await detectClothingAnchors({ image, category });
  return anchors;
} catch (error) {
  console.error('Anchor detection failed:', error);

  // Graceful fallback to colored pixel detection
  return fallbackColoredPixelDetection(image, category);
}
```

### Invalid Contours

```typescript
if (!contours || contours.size() === 0) {
  throw new Error('No contours detected - image may be blank or all transparent');
}

const largestContour = getLargestContour(contours);
if (!largestContour || cv.contourArea(largestContour) < MIN_AREA_THRESHOLD) {
  throw new Error('Contour too small - likely not a clothing item');
}
```

### Symmetry Validation Failure

```typescript
const symmetryRatio = validateShoulderSymmetry(leftShoulder, rightShoulder);

if (symmetryRatio < SYMMETRY_THRESHOLD) {
  console.warn(`Low symmetry detected: ${symmetryRatio}. May be asymmetric garment or detection error.`);

  // Still return points but flag low confidence
  return {
    ...anchors,
    confidence: Math.min(anchors.confidence, symmetryRatio),
    warnings: ['Low shoulder symmetry']
  };
}
```

## Edge Cases

### Asymmetric Clothing

**Problem**: One-shoulder tops, asymmetric hems fail symmetry check

**Solution**: Relax symmetry requirement or detect asymmetry pattern

```typescript
// Detect if garment is intentionally asymmetric
function detectAsymmetry(contour: Contour): boolean {
  // Check if one side is significantly different from the other
  const leftHalf = contour.filter(p => p.x < centerX);
  const rightHalf = contour.filter(p => p.x >= centerX);

  const leftComplexity = calculateComplexity(leftHalf);
  const rightComplexity = calculateComplexity(rightHalf);

  return Math.abs(leftComplexity - rightComplexity) > ASYMMETRY_THRESHOLD;
}

// If asymmetric, skip symmetry validation
if (detectAsymmetry(contour)) {
  console.log('Asymmetric garment detected - skipping symmetry check');
  return detectAnchorsWithoutSymmetry(contour);
}
```

### Patterned Clothing

**Problem**: Internal patterns create false edges

**Solution**: Stronger preprocessing + focus on outer contour only

```typescript
// Use morphological closing to fill pattern gaps
const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
const closed = new cv.Mat();
cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);

// Use RETR_EXTERNAL to get only outer contour
cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
```

### Transparent/Sheer Sections

**Problem**: Internal transparent regions detected as holes

**Solution**: Use contour hierarchy to identify and ignore holes

```typescript
// Get only parent contours (ignore holes/children)
for (let i = 0; i < contours.size(); i++) {
  const hierarchyData = hierarchy.intAt(0, i);
  const hasNoParent = hierarchyData[3] === -1;

  if (hasNoParent) {
    // This is a parent contour (outer boundary)
    validContours.push(contours.get(i));
  }
}
```

## Quality Thresholds

### Acceptance Criteria

```typescript
const QUALITY_THRESHOLDS = {
  // Minimum requirements to use detected anchors
  PERMISSIVE: {
    requiredAnchors: ['leftShoulder', 'rightShoulder'],
    minConfidence: 0.5,
    minSymmetry: 0.6
  },

  // Higher quality bar (future)
  STRICT: {
    requiredAnchors: ['leftShoulder', 'rightShoulder', 'collarCenter'],
    minConfidence: 0.7,
    minSymmetry: 0.8
  }
};

function validateAnchorQuality(
  anchors: ClothingAnchorPoints,
  threshold: 'PERMISSIVE' | 'STRICT' = 'PERMISSIVE'
): boolean {
  const config = QUALITY_THRESHOLDS[threshold];

  // Check required anchors present
  for (const required of config.requiredAnchors) {
    if (!anchors[required]) {
      console.warn(`Missing required anchor: ${required}`);
      return false;
    }
  }

  // Check confidence
  if (anchors.confidence < config.minConfidence) {
    console.warn(`Confidence too low: ${anchors.confidence}`);
    return false;
  }

  // Check symmetry
  if (anchors.leftShoulder && anchors.rightShoulder) {
    const symmetry = calculateSymmetryRatio(anchors.leftShoulder, anchors.rightShoulder);
    if (symmetry < config.minSymmetry) {
      console.warn(`Symmetry too low: ${symmetry}`);
      return false;
    }
  }

  return true;
}
```

## Implementation Phases

### Phase 1: Core Infrastructure ✅
- Set up OpenCV.js loading
- Create anchor-detection.ts module
- Implement preprocessing pipeline (contrast enhancement)
- Implement edge detection + contour finding
- Add memory caching

### Phase 2: Tops Detection ✅
- Implement classifyClothingType() (basic version)
- Implement detectShoulders() (topmost corners)
- Implement detectCollar() (concave region)
- Implement detectArmpits() (width analysis)
- Add symmetry validation

### Phase 3: Bottoms Detection ✅
- Extend classifyClothingType() for bottoms
- Implement detectWaistband()
- Implement detectHem()
- Handle pants vs skirts differentiation

### Phase 4: Fallback System ✅
- Implement fallbackColoredPixelDetection()
- Calculate convex hull
- Find extrema points
- Generate estimated anchor points

### Phase 5: Integration ✅
- Modify getClothingQuad() to accept anchor points
- Implement mapAnchorsToBody()
- Update ClothingCanvas to detect and use anchors
- Add anchor points to rendering pipeline

### Phase 6: Debug Visualization ✅
- Create DebugAnchorOverlay component
- Implement side-by-side test view
- Add contour visualization
- Add detection metadata display

### Phase 7: Testing & Refinement ✅
- Test with diverse clothing images
- Tune thresholds and parameters
- Handle edge cases
- Performance optimization

## File Structure

```
frontend/src/
├── lib/
│   ├── anchor-detection.ts              # Main detection module (NEW)
│   │   ├── detectClothingAnchors()      # Entry point
│   │   ├── classifyClothingType()
│   │   ├── detectTopAnchors()
│   │   ├── detectBottomAnchors()
│   │   ├── detectShoulders()
│   │   ├── detectCollar()
│   │   ├── detectArmpits()
│   │   ├── detectWaistband()
│   │   ├── detectHem()
│   │   └── fallbackColoredPixelDetection()
│   │
│   ├── opencv-utils.ts                  # OpenCV helpers (NEW)
│   │   ├── preprocessImage()
│   │   ├── detectEdges()
│   │   ├── findContours()
│   │   ├── getLargestContour()
│   │   ├── calculateCurvature()
│   │   └── analyzeContourComplexity()
│   │
│   └── clothing-transform.ts            # MODIFIED
│       ├── getClothingQuad()            # Updated to accept anchor points
│       └── mapAnchorsToBody()           # NEW
│
├── app/mirror/test/
│   ├── components/
│   │   ├── ClothingCanvas.tsx           # MODIFIED (detect + use anchors)
│   │   └── DebugAnchorOverlay.tsx       # NEW (debug visualization)
│   │
│   └── page.tsx                         # MODIFIED (load OpenCV.js)
│
└── types/
    └── clothing.ts                      # MODIFIED (add ClothingAnchorPoints)
```

## Deliverables

### Core Functions
- ✅ `detectClothingAnchors()` - Main entry point
- ✅ `classifyClothingType()` - Auto-detect clothing category
- ✅ `detectTopAnchors()` - Shoulder/collar/armpit detection
- ✅ `detectBottomAnchors()` - Waistband/hem detection
- ✅ `fallbackColoredPixelDetection()` - Robust fallback

### Integration
- ✅ Modified `getClothingQuad()` to accept anchor points
- ✅ Updated `ClothingCanvas` to detect and use anchor points
- ✅ Direct mapping: clothing anchors → body landmarks

### OpenCV.js Setup
- ✅ Library loading on page init
- ✅ Preprocessing pipeline (contrast enhancement)
- ✅ Edge detection + contour finding
- ✅ Caching system (memory-based)

### Debug Tools
- ✅ Anchor point overlay visualization
- ✅ Contour visualization
- ✅ Side-by-side test view

## Success Criteria

**MVP Complete When**:
1. ✅ Clothing anchor points detected for tops and bottoms
2. ✅ Shoulders align pixel-perfectly with body shoulder landmarks
3. ✅ Auto-detection classifies clothing type correctly >80% of time
4. ✅ Fallback system handles detection failures gracefully
5. ✅ Detection completes in <200ms per image
6. ✅ Debug visualization shows anchor points clearly
7. ✅ Integration with ClothingCanvas works seamlessly

## Future Enhancements (Out of Scope)

- Machine learning-based keypoint detection (higher accuracy)
- Support for accessories (hats, bags, jewelry)
- 3D pose-aware warping (not just 2D affine)
- Real-time video anchor tracking (track points frame-to-frame)
- User-assisted anchor point correction UI
- Automatic anchor point quality scoring and feedback

## Notes

- OpenCV.js is large (~8MB) - consider lazy loading if page load time is critical
- Canny edge detection parameters (50, 150) may need tuning for different image types
- Symmetry threshold (0.7) can be relaxed for intentionally asymmetric designs
- Fallback colored pixel detection is robust but less accurate than feature detection
- Direct mapping (clothing shoulders → body shoulders) assumes clothing fits the body shape
