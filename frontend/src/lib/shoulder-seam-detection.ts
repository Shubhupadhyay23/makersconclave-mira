/**
 * Detect shoulder seams by scanning for significant pixel width changes
 * This finds where sleeves start to spread out from the body
 */

export interface ShoulderAnchors {
  leftShoulder: { x: number; y: number };  // Normalized 0-1 - shoulder seam left
  rightShoulder: { x: number; y: number }; // Normalized 0-1 - shoulder seam right
  leftHem: { x: number; y: number };       // Normalized 0-1 - bottom left of shirt
  rightHem: { x: number; y: number };      // Normalized 0-1 - bottom right of shirt
  shoulderY: number; // Y-coordinate of shoulder line (normalized)
  neckY: number; // Top of garment (normalized)
  hemY: number; // Bottom of garment (normalized)
}

/**
 * Scan image from top to bottom to find shoulder seams
 * Detects where colored pixels significantly widen (sleeve separation)
 */
export function detectShoulderSeams(image: HTMLImageElement): ShoulderAnchors | null {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');

  if (!ctx) return null;

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  // Scan each row to find left/right bounds of colored pixels
  interface RowData {
    y: number;
    leftmost: number;
    rightmost: number;
    width: number;
    pixelCount: number;
  }

  const rows: RowData[] = [];

  for (let y = 0; y < canvas.height; y++) {
    let leftmost = canvas.width;
    let rightmost = 0;
    let pixelCount = 0;

    for (let x = 0; x < canvas.width; x++) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];

      if (alpha > 10) {
        pixelCount++;
        if (x < leftmost) leftmost = x;
        if (x > rightmost) rightmost = x;
      }
    }

    if (pixelCount > 0) {
      rows.push({
        y,
        leftmost,
        rightmost,
        width: rightmost - leftmost,
        pixelCount,
      });
    }
  }

  if (rows.length === 0) {
    console.error('[ShoulderSeam] No colored pixels found');
    return null;
  }

  const neckY = rows[0].y;

  // Calculate moving average of width to smooth out noise
  const windowSize = 5;
  const smoothedRows = rows.map((row, i) => {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(rows.length, i + windowSize + 1);
    const window = rows.slice(start, end);
    const avgWidth = window.reduce((sum, r) => sum + r.width, 0) / window.length;

    return {
      ...row,
      smoothedWidth: avgWidth,
    };
  });

  // Find where width increases most significantly (shoulder seam)
  let maxWidthIncrease = 0;
  let shoulderRowIndex = 0;

  for (let i = 10; i < smoothedRows.length - 10; i++) {
    const prevWidth = smoothedRows[i - 5].smoothedWidth;
    const currentWidth = smoothedRows[i].smoothedWidth;
    const widthIncrease = currentWidth - prevWidth;

    if (widthIncrease > maxWidthIncrease) {
      maxWidthIncrease = widthIncrease;
      shoulderRowIndex = i;
    }
  }

  const shoulderRow = rows[shoulderRowIndex];

  if (!shoulderRow) {
    console.error('[ShoulderSeam] Could not find shoulder row');
    return null;
  }

  const hemRow = rows[rows.length - 1];

  const leftShoulder = {
    x: shoulderRow.leftmost / canvas.width,
    y: shoulderRow.y / canvas.height,
  };

  const rightShoulder = {
    x: shoulderRow.rightmost / canvas.width,
    y: shoulderRow.y / canvas.height,
  };

  const leftHem = {
    x: hemRow.leftmost / canvas.width,
    y: hemRow.y / canvas.height,
  };

  const rightHem = {
    x: hemRow.rightmost / canvas.width,
    y: hemRow.y / canvas.height,
  };

  const shoulderY = shoulderRow.y / canvas.height;
  const normalizedNeckY = neckY / canvas.height;
  const hemY = hemRow.y / canvas.height;

  console.log('[ShoulderSeam] Left shoulder:', leftShoulder);
  console.log('[ShoulderSeam] Right shoulder:', rightShoulder);
  console.log('[ShoulderSeam] Left hem:', leftHem);
  console.log('[ShoulderSeam] Right hem:', rightHem);

  return {
    leftShoulder,
    rightShoulder,
    leftHem,
    rightHem,
    shoulderY,
    neckY: normalizedNeckY,
    hemY,
  };
}

/**
 * Calculate uniform scale factor to match anchor points
 * Returns scale that should be applied to BOTH width and height
 */
export function calculateUniformScale(
  shirtAnchors: ShoulderAnchors,
  shirtImageWidth: number,
  bodyShoulderWidthPixels: number
): number {
  // Calculate shirt shoulder width in pixels
  const shirtShoulderWidthNormalized = shirtAnchors.rightShoulder.x - shirtAnchors.leftShoulder.x;
  const shirtShoulderWidthPixels = shirtShoulderWidthNormalized * shirtImageWidth;

  // Scale factor to match body shoulders
  const scale = bodyShoulderWidthPixels / shirtShoulderWidthPixels;

  console.log('[Scale] Shirt shoulder width:', shirtShoulderWidthPixels, 'px');
  console.log('[Scale] Body shoulder width:', bodyShoulderWidthPixels, 'px');
  console.log('[Scale] Uniform scale factor:', scale);

  return scale;
}
