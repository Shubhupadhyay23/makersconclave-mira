import { describe, it, expect } from "vitest";
import { processToolResult, type ToolResultData } from "@/lib/process-tool-result";

describe("processToolResult", () => {
  it("display_product with flat lays returns canvasItems", () => {
    const data: ToolResultData = {
      type: "display_product",
      items: [
        {
          product_id: "p1",
          title: "Blue Shirt",
          price: "$49.99",
          image_url: "https://example.com/shirt.jpg",
          type: "top",
          cleaned_image_url: "data:image/png;base64,flatlay1",
        },
        {
          product_id: "p2",
          title: "Black Pants",
          price: "$79.99",
          image_url: "https://example.com/pants.jpg",
          type: "bottom",
          flat_image_url: "data:image/png;base64,flatlay2",
        },
      ],
      outfit_name: "Casual Friday",
    };

    const result = processToolResult(data);

    expect(result).not.toBeNull();
    expect(result!.canvasItems).toHaveLength(2);
    expect(result!.canvasItems[0]).toEqual(
      expect.objectContaining({ id: "p1", category: "tops" }),
    );
    expect(result!.canvasItems[1]).toEqual(
      expect.objectContaining({ id: "p2", category: "bottoms" }),
    );
    expect(result!.carouselCards).toHaveLength(2);
    expect(result!.priceInfo).toHaveLength(2);
    expect(result!.outfitName).toBe("Casual Friday");
  });

  it("display_product without flat lays falls back to carouselCards", () => {
    const data: ToolResultData = {
      type: "display_product",
      items: [
        {
          product_id: "p1",
          title: "Blue Shirt",
          price: "$49.99",
          image_url: "https://example.com/shirt.jpg",
          type: "top",
          // no cleaned_image_url or flat_image_url
        },
        {
          product_id: "p2",
          title: "Black Pants",
          price: "$79.99",
          image_url: "https://example.com/pants.jpg",
          type: "bottom",
          // no flat lays
        },
      ],
      outfit_name: "Smart Casual",
    };

    const result = processToolResult(data);

    expect(result).not.toBeNull();
    expect(result!.canvasItems).toHaveLength(0);
    expect(result!.carouselCards).toHaveLength(2);
    expect(result!.carouselCards[0]).toEqual(
      expect.objectContaining({
        product_id: "p1",
        title: "Blue Shirt",
        price: "$49.99",
        image_url: "https://example.com/shirt.jpg",
      }),
    );
    expect(result!.priceInfo).toHaveLength(2);
    expect(result!.outfitName).toBe("Smart Casual");
  });

  it("clothing_results maps to carouselCards", () => {
    const data: ToolResultData = {
      type: "clothing_results",
      items: [
        {
          product_id: "c1",
          title: "Nike Air Max",
          price: "$120",
          image_url: "https://example.com/nike.jpg",
          link: "https://nike.com/air-max",
          source: "Nike",
        },
        {
          product_id: "c2",
          title: "Adidas Ultraboost",
          price: "$180",
          image_url: "https://example.com/adidas.jpg",
          link: "https://adidas.com/ultraboost",
          source: "Adidas",
        },
      ],
    };

    const result = processToolResult(data);

    expect(result).not.toBeNull();
    expect(result!.canvasItems).toHaveLength(0);
    expect(result!.carouselCards).toHaveLength(2);
    expect(result!.carouselCards[0].product_id).toBe("c1");
    expect(result!.carouselCards[1].source).toBe("Adidas");
    expect(result!.priceInfo).toHaveLength(0);
  });

  it("returns null for unknown type", () => {
    const data: ToolResultData = {
      type: "voice_message",
      items: [{ title: "Test", image_url: "https://example.com/img.jpg" }],
    };

    expect(processToolResult(data)).toBeNull();
  });

  it("returns null for empty items", () => {
    expect(processToolResult({ type: "display_product", items: [] })).toBeNull();
    expect(processToolResult({ type: "clothing_results", items: [] })).toBeNull();
    expect(processToolResult({ type: "display_product" })).toBeNull();
  });

  it("clothing_results filters out items without image_url", () => {
    const data: ToolResultData = {
      type: "clothing_results",
      items: [
        { title: "Has Image", image_url: "https://example.com/img.jpg", product_id: "a" },
        { title: "No Image" },
      ],
    };

    const result = processToolResult(data);

    expect(result).not.toBeNull();
    expect(result!.carouselCards).toHaveLength(1);
    expect(result!.carouselCards[0].title).toBe("Has Image");
  });

  it("clothing_results returns null when all items lack image_url", () => {
    const data: ToolResultData = {
      type: "clothing_results",
      items: [
        { title: "No Image 1" },
        { title: "No Image 2" },
      ],
    };

    expect(processToolResult(data)).toBeNull();
  });
});
