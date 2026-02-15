import type { ClothingItem } from '@/types/clothing';

/**
 * Default test clothing items
 * Images should be transparent PNGs with background removed
 */
export const DEFAULT_TEST_CLOTHES: ClothingItem[] = [
  {
    id: 't1',
    category: 'tops',
    imageUrl: '/test-images/tops/white-tshirt.png',
    name: 'White T-Shirt',
  },
  {
    id: 'b1',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/blue-jeans.png',
    name: 'Blue Jeans',
  },
];

/**
 * Default outfit combinations
 */
export const DEFAULT_OUTFITS: ClothingItem[][] = [
  [DEFAULT_TEST_CLOTHES[0]], // White tee only
  [DEFAULT_TEST_CLOTHES[1]], // Blue jeans only
  [DEFAULT_TEST_CLOTHES[0], DEFAULT_TEST_CLOTHES[1]], // Full outfit
];
