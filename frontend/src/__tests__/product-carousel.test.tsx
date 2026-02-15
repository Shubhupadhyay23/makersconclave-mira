import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ProductCarousel from "@/components/mirror/ProductCarousel";

const mockItems = [
  {
    product_id: "p1",
    title: "Nike Air Max 90",
    price: "$129.99",
    image_url: "https://example.com/shoe.jpg",
    link: "https://example.com/shoe",
    source: "Nordstrom",
  },
  {
    product_id: "p2",
    title: "Zara Oversized Blazer",
    price: "$89.00",
    image_url: "https://example.com/blazer.jpg",
    link: "https://example.com/blazer",
    source: "Zara",
  },
];

describe("ProductCarousel", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(
      <ProductCarousel items={[]} onGesture={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders product cards with title and price", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Nike Air Max 90")).toBeDefined();
    expect(screen.getByText("$129.99")).toBeDefined();
    expect(screen.getByText("Zara Oversized Blazer")).toBeDefined();
  });

  it("renders source labels on cards", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Nordstrom")).toBeDefined();
    expect(screen.getByText("Zara")).toBeDefined();
  });

  it("renders product images with correct src", () => {
    render(<ProductCarousel items={mockItems} onGesture={vi.fn()} />);

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute("src")).toContain("shoe.jpg");
  });

  it("calls onGesture when gesture event is received", () => {
    const onGesture = vi.fn();
    render(<ProductCarousel items={mockItems} onGesture={onGesture} />);

    // Simulate a swipe_right on the first item
    onGesture("swipe_right", mockItems[0]);
    expect(onGesture).toHaveBeenCalledWith("swipe_right", mockItems[0]);
  });

  it("replaces items when new items prop arrives", () => {
    const { rerender } = render(
      <ProductCarousel items={mockItems} onGesture={vi.fn()} />,
    );

    const newItems = [
      { ...mockItems[0], title: "Adidas Ultraboost", product_id: "p3" },
    ];
    rerender(<ProductCarousel items={newItems} onGesture={vi.fn()} />);

    expect(screen.getByText("Adidas Ultraboost")).toBeDefined();
    expect(screen.queryByText("Nike Air Max 90")).toBeNull();
  });
});
