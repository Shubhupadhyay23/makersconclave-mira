export interface ClothingItem {
  title: string;
  source: string;
  price: string;
  price_numeric: number | null;
  image_url: string;
  flat_image_url?: string;
  link: string;
  product_id: string;
  rating: number | null;
}

export interface OutfitItem {
  type: string;
  item: ClothingItem;
}

export interface Outfit {
  id?: string;
  outfit_name: string;
  description: string;
  items: OutfitItem[];
  why_its_a_match?: string;
  mira_comment: string;
}

export interface RecommendationResponse {
  status: "success" | "needs_onboarding" | "error";
  data?: {
    greeting: string;
    style_analysis: string;
    outfits: Outfit[];
  };
  message?: string;
  error_type?: string;
  generation_time_ms?: number;
}

export interface OnboardingData {
  favorite_brands: string[];
  style_preferences: string[];
  price_range: { min: number; max: number };
  size_info: Record<string, string>;
  gender: string;
  occasions: string[];
}
