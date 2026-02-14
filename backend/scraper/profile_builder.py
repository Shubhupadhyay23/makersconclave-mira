"""Build a style profile from purchase data and brand frequencies."""

from collections import Counter

# Map categories to style tags
CATEGORY_STYLE_MAP = {
    "shoes": ["sneakerhead", "athletic"],
    "tops": ["casual"],
    "bottoms": ["casual"],
    "outerwear": ["layered", "polished"],
    "accessories": ["accessorized"],
    "dresses": ["feminine", "occasion-ready"],
}

# Map price ranges to style tags
PRICE_STYLE_MAP = [
    (0, 50, "budget-friendly"),
    (50, 150, "mid-range"),
    (150, 500, "premium"),
    (500, float("inf"), "luxury"),
]


def build_style_profile(
    purchases: list[dict],
    brand_freq: dict[str, int],
) -> dict:
    """Aggregate purchases and brand frequencies into a style profile.

    Returns dict matching StyleProfileUpdate schema:
    {brands, price_range, style_tags, narrative_summary}
    """
    if not purchases and not brand_freq:
        return {
            "brands": [],
            "price_range": {"min": 0, "max": 0, "avg": 0},
            "style_tags": [],
            "narrative_summary": None,
        }

    # Brands: merge from purchases + frequency scan, ordered by frequency
    brand_counts = Counter(brand_freq)
    for p in purchases:
        brand_counts[p["brand"]] += 1
    brands = [b for b, _ in brand_counts.most_common()]

    # Price range
    prices = [p["price"] for p in purchases if p.get("price") is not None]
    price_range = {
        "min": min(prices) if prices else 0,
        "max": max(prices) if prices else 0,
        "avg": round(sum(prices) / len(prices), 2) if prices else 0,
    }

    # Style tags from categories
    style_tags = set()
    category_counts = Counter(p.get("category") for p in purchases if p.get("category"))
    for cat, count in category_counts.items():
        if cat in CATEGORY_STYLE_MAP:
            style_tags.update(CATEGORY_STYLE_MAP[cat])

    # Style tags from price range
    avg_price = price_range["avg"]
    for low, high, tag in PRICE_STYLE_MAP:
        if low <= avg_price < high:
            style_tags.add(tag)
            break

    # Narrative summary
    top_brands = ", ".join(brands[:3]) if brands else "various brands"
    cat_summary = ", ".join(
        f"{cat} ({count})" for cat, count in category_counts.most_common(3)
    )
    narrative = (
        f"Shops primarily at {top_brands}. "
        f"Most purchased categories: {cat_summary or 'mixed'}. "
        f"Typical spending: ${price_range['avg']:.0f} per item "
        f"(range ${price_range['min']:.0f}-${price_range['max']:.0f})."
    )

    return {
        "brands": brands,
        "price_range": price_range,
        "style_tags": sorted(style_tags),
        "narrative_summary": narrative,
    }
