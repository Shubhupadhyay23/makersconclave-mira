import { describe, it, expect } from "vitest";
import { mapToClothingItems, type DisplayProductItem } from "@/lib/map-clothing-items";

describe("mapToClothingItems", () => {
  it("maps top and bottom items to ClothingItem with correct categories", () => {
    const items: DisplayProductItem[] = [
      {
        product_id: "p1",
        title: "Blue Shirt",
        type: "top",
        cleaned_image_url: "data:image/png;base64,abc",
      },
      {
        product_id: "p2",
        title: "Black Pants",
        type: "bottom",
        flat_image_url: "data:image/png;base64,def",
      },
    ];

    const result = mapToClothingItems(items);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: "p1",
        category: "tops",
        imageUrl: "data:image/png;base64,abc",
        name: "Blue Shirt",
      }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({
        id: "p2",
        category: "bottoms",
        imageUrl: "data:image/png;base64,def",
        name: "Black Pants",
      }),
    );
  });

  it("filters out items without flat lay images", () => {
    const items: DisplayProductItem[] = [
      {
        product_id: "p1",
        title: "Has Flat Lay",
        type: "top",
        cleaned_image_url: "data:image/png;base64,abc",
      },
      {
        product_id: "p2",
        title: "Raw Only",
        type: "bottom",
        image_url: "https://example.com/raw.jpg",
        // no cleaned_image_url or flat_image_url
      },
    ];

    const result = mapToClothingItems(items);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Has Flat Lay");
  });

  it("prefers cleaned_image_url over flat_image_url", () => {
    const items: DisplayProductItem[] = [
      {
        product_id: "p1",
        title: "Both URLs",
        type: "top",
        cleaned_image_url: "data:cleaned",
        flat_image_url: "data:flat",
      },
    ];

    const result = mapToClothingItems(items);

    expect(result).toHaveLength(1);
    expect(result[0].imageUrl).toBe("data:cleaned");
  });

  it("ignores non-clothing types like shoes and accessories", () => {
    const items: DisplayProductItem[] = [
      {
        product_id: "p1",
        title: "Sneakers",
        type: "shoes",
        cleaned_image_url: "data:shoes",
      },
      {
        product_id: "p2",
        title: "Watch",
        type: "accessory",
        cleaned_image_url: "data:watch",
      },
      {
        product_id: "p3",
        title: "T-Shirt",
        type: "top",
        cleaned_image_url: "data:shirt",
      },
    ];

    const result = mapToClothingItems(items);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("T-Shirt");
  });

  it("returns empty array for empty input", () => {
    expect(mapToClothingItems([])).toEqual([]);
  });
});
