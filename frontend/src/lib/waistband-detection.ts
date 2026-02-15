/**
 * Detect the exact 4 corner pixels of clothing
 * Finds first colored pixel from each corner
 */

export interface WaistbandAnchors {
  topLeft: { x: number; y: number };      // Normalized 0-1 - top-left corner pixel
  topRight: { x: number; y: number };     // Normalized 0-1 - top-right corner pixel
  bottomLeft: { x: number; y: number };   // Normalized 0-1 - bottom-left corner pixel
  bottomRight: { x: number; y: number };  // Normalized 0-1 - bottom-right corner pixel
}

/**
 * Find the exact 4 corner pixels of the clothing
 * Scans from each corner inward to find first colored pixel
 */
export function detectWaistband(image: HTMLImageElement): WaistbandAnchors | null {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');

  if (!ctx) return null;

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  const isVisible = (x: number, y: number): boolean => {
    const alpha = pixels[(y * canvas.width + x) * 4 + 3];
    return alpha > 10;
  };

  // Find TOP-LEFT corner: scan from top-left inward
  let topLeft: { x: number; y: number } | null = null;
  outerTopLeft: for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (isVisible(x, y)) {
        topLeft = { x, y };
        break outerTopLeft;
      }
    }
  }

  // Find TOP-RIGHT corner: scan from top-right inward
  let topRight: { x: number; y: number } | null = null;
  outerTopRight: for (let y = 0; y < canvas.height; y++) {
    for (let x = canvas.width - 1; x >= 0; x--) {
      if (isVisible(x, y)) {
        topRight = { x, y };
        break outerTopRight;
      }
    }
  }

  // Find BOTTOM-LEFT corner: scan from bottom-left inward
  let bottomLeft: { x: number; y: number } | null = null;
  outerBottomLeft: for (let y = canvas.height - 1; y >= 0; y--) {
    for (let x = 0; x < canvas.width; x++) {
      if (isVisible(x, y)) {
        bottomLeft = { x, y };
        break outerBottomLeft;
      }
    }
  }

  // Find BOTTOM-RIGHT corner: scan from bottom-right inward
  let bottomRight: { x: number; y: number } | null = null;
  outerBottomRight: for (let y = canvas.height - 1; y >= 0; y--) {
    for (let x = canvas.width - 1; x >= 0; x--) {
      if (isVisible(x, y)) {
        bottomRight = { x, y };
        break outerBottomRight;
      }
    }
  }

  if (!topLeft || !topRight || !bottomLeft || !bottomRight) {
    console.error('[CornerDetection] Could not find all 4 corners');
    return null;
  }

  // Normalize to 0-1
  const result = {
    topLeft: {
      x: topLeft.x / canvas.width,
      y: topLeft.y / canvas.height,
    },
    topRight: {
      x: topRight.x / canvas.width,
      y: topRight.y / canvas.height,
    },
    bottomLeft: {
      x: bottomLeft.x / canvas.width,
      y: bottomLeft.y / canvas.height,
    },
    bottomRight: {
      x: bottomRight.x / canvas.width,
      y: bottomRight.y / canvas.height,
    },
  };

  console.log('[CornerDetection] Top-left:', result.topLeft);
  console.log('[CornerDetection] Top-right:', result.topRight);
  console.log('[CornerDetection] Bottom-left:', result.bottomLeft);
  console.log('[CornerDetection] Bottom-right:', result.bottomRight);

  return result;
}
