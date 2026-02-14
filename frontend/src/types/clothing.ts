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
