import type { ClothingItem } from "@/types/clothing";
import type { PriceStripItem } from "@/components/mirror/PriceStrip";
import type { ProductCard } from "@/components/mirror/ProductCarousel";
import { mapToClothingItems } from "@/lib/map-clothing-items";

export interface ToolResultData {
  type?: string;
  items?: Array<{
    title: string;
    price?: string;
    image_url?: string;
    link?: string;
    source?: string;
    product_id?: string;
    type?: string;
    cleaned_image_url?: string;
    flat_image_url?: string;
    [key: string]: unknown;
  }>;
  outfit_name?: string;
}

export interface ProcessedToolResult {
  canvasItems: ClothingItem[];
  carouselCards: ProductCard[];
  priceInfo: PriceStripItem[];
  outfitName: string;
}

/**
 * Process a tool_result Socket.io event into display-ready data.
 *
 * Handles tool result types:
 * - `display_product`: tries flat lay overlay first, falls back to ProductCarousel cards
 * - `clothing_results`: (legacy) always maps to ProductCarousel cards
 *
 * Returns null for unknown types or empty items.
 */
export function processToolResult(data: ToolResultData): ProcessedToolResult | null {
  if (!data.items || data.items.length === 0) {
    console.warn("[MirrorV2:ToolResult] No items in:", data.type);
    return null;
  }

  if (data.type === "display_product") {
    console.log(`[MirrorV2:ToolResult] display_product received ${data.items.length} items, outfit: "${data.outfit_name}"`);
    // Log raw item data for debugging the pipeline
    for (const it of data.items) {
      console.log(`[MirrorV2:ToolResult]   → "${it.title}" type=${it.type ?? "MISSING"} image_url=${it.image_url ? "yes" : "no"} cleaned=${it.cleaned_image_url ? "yes" : "no"} flat=${it.flat_image_url ? "yes" : "no"}`);
    }

    const canvasItems = mapToClothingItems(data.items);
    const priceInfo: PriceStripItem[] = data.items.map((it) => ({
      title: it.title,
      price: it.price,
    }));
    const outfitName = data.outfit_name || "";

    // Always populate carousel cards for immediate visual feedback
    const carouselCards = mapItemsToCards(data.items);

    if (canvasItems.length === 0 && data.items.length > 0) {
      console.warn(`[MirrorV2:ToolResult] ⚠ ALL ${data.items.length} items filtered out by mapToClothingItems! Canvas will be empty. Likely causes: missing type field, or no cleaned_image_url/flat_image_url (Gemini flat lay generation may have failed).`);
    }

    return { canvasItems, carouselCards, priceInfo, outfitName };
  }

  if (data.type === "clothing_results") {
    const carouselCards = mapItemsToCards(data.items);
    if (carouselCards.length === 0) return null;
    return { canvasItems: [], carouselCards, priceInfo: [], outfitName: "" };
  }

  console.warn("[MirrorV2:ToolResult] Unknown tool type:", data.type);
  return null;
}

/** Map raw tool result items to ProductCard format for the carousel. */
function mapItemsToCards(
  items: NonNullable<ToolResultData["items"]>,
): ProductCard[] {
  return items
    .filter((it) => it.image_url)
    .map((it) => ({
      product_id: it.product_id || crypto.randomUUID(),
      title: it.title,
      price: it.price || "",
      image_url: it.image_url!,
      link: it.link || "",
      source: it.source || "",
    }));
}
