import type { ClothingItem } from "@/types/clothing";

export interface DisplayProductItem {
  product_id?: string;
  title?: string;
  type?: string;
  cleaned_image_url?: string;
  flat_image_url?: string;
  image_url?: string;
}

/**
 * Map display_product items to ClothingItem[] for canvas overlay.
 * Only includes tops/bottoms with flat lay images (raw product photos
 * with model bodies look wrong on the body overlay).
 */
export function mapToClothingItems(items: DisplayProductItem[]): ClothingItem[] {
  const catMap: Record<string, "tops" | "bottoms"> = { top: "tops", bottom: "bottoms" };
  return items
    .filter((i) => i.type === "top" || i.type === "bottom")
    .filter((i) => i.cleaned_image_url || i.flat_image_url) // flat lays only
    .map((i) => ({
      id: i.product_id || crypto.randomUUID(),
      category: catMap[i.type!],
      imageUrl: i.cleaned_image_url || i.flat_image_url || "",
      name: i.title,
    }));
}
