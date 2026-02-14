import type { ClothingItem } from '@/types/clothing';

/**
 * Default test clothing items
 * Images should be transparent PNGs with background removed
 */
export const DEFAULT_TEST_CLOTHES: ClothingItem[] = [
  // Tops
  {
    id: 't1',
    category: 'tops',
    imageUrl: '/test-images/tops/white-tshirt.png',
    name: 'White T-Shirt',
  },
  {
    id: 't2',
    category: 'tops',
    imageUrl: '/test-images/tops/black-hoodie.png',
    name: 'Black Hoodie',
  },
  {
    id: 't3',
    category: 'tops',
    imageUrl: '/test-images/tops/denim-jacket.png',
    name: 'Denim Jacket',
  },

  // Bottoms
  {
    id: 'b1',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/blue-jeans.png',
    name: 'Blue Jeans',
  },
  {
    id: 'b2',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/black-pants.png',
    name: 'Black Pants',
  },
  {
    id: 'b3',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/khaki-shorts.png',
    name: 'Khaki Shorts',
  },
];

/**
 * Default outfit combinations (top + bottom)
 */
export const DEFAULT_OUTFITS: ClothingItem[][] = [
  [DEFAULT_TEST_CLOTHES[0], DEFAULT_TEST_CLOTHES[3]], // White tee + blue jeans
  [DEFAULT_TEST_CLOTHES[1], DEFAULT_TEST_CLOTHES[4]], // Hoodie + black pants
  [DEFAULT_TEST_CLOTHES[2], DEFAULT_TEST_CLOTHES[3]], // Jacket + blue jeans
  [DEFAULT_TEST_CLOTHES[0], DEFAULT_TEST_CLOTHES[5]], // White tee + khaki shorts
  [DEFAULT_TEST_CLOTHES[1], DEFAULT_TEST_CLOTHES[3]], // Hoodie + blue jeans
  [DEFAULT_TEST_CLOTHES[2], DEFAULT_TEST_CLOTHES[4]], // Jacket + black pants
];
