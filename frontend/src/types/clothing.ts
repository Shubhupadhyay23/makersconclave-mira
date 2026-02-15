/**
 * Clothing overlay types for mirror display test page
 */

export type ClothingCategory = 'tops' | 'bottoms';

export interface ClothingItem {
  id: string;
  category: ClothingCategory;
  imageUrl: string;  // Transparent PNG with background removed
  name?: string;     // Display name
  brand?: string;    // Brand name
}

/**
 * Transform data for rendering clothing on canvas
 */
export interface ClothingTransform {
  centerX: number;    // Center X position in pixels
  centerY: number;    // Center Y position in pixels
  width: number;      // Width in pixels
  height: number;     // Height in pixels
  rotation: number;   // Rotation in radians
}

/**
 * 4-point mapping for precise clothing corner to body landmark alignment
 */
export interface ClothingQuad {
  topLeft: { x: number; y: number };      // Maps to left shoulder (tops) or left hip (bottoms)
  topRight: { x: number; y: number };     // Maps to right shoulder (tops) or right hip (bottoms)
  bottomLeft: { x: number; y: number };   // Maps to left hip (tops) or left ankle (bottoms)
  bottomRight: { x: number; y: number };  // Maps to right hip (tops) or right ankle (bottoms)
}

/**
 * Detected anchor points from clothing image analysis
 */
export interface ClothingAnchorPoints {
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
