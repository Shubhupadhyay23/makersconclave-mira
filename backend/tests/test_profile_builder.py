"""Tests for style profile builder."""

from scraper.profile_builder import build_style_profile


def test_build_style_profile_aggregates():
    """Aggregates purchases and brand frequencies into a style profile."""
    purchases = [
        {"brand": "Nike", "item_name": "Air Max 90", "category": "shoes", "price": 129.99},
        {"brand": "Nike", "item_name": "Dri-FIT Tee", "category": "tops", "price": 35.00},
        {"brand": "Zara", "item_name": "Slim Fit Jeans", "category": "bottoms", "price": 49.90},
        {"brand": "Aritzia", "item_name": "Babaton Blazer", "category": "outerwear", "price": 198.00},
    ]
    brand_freq = {"Nike": 5, "Zara": 3, "Aritzia": 2}

    profile = build_style_profile(purchases, brand_freq)

    assert "Nike" in profile["brands"]
    assert "Zara" in profile["brands"]
    assert profile["price_range"]["min"] == 35.00
    assert profile["price_range"]["max"] == 198.00
    assert len(profile["style_tags"]) > 0
    assert profile["narrative_summary"] is not None


def test_build_style_profile_empty():
    """Empty purchases still returns valid profile structure."""
    profile = build_style_profile([], {})
    assert profile["brands"] == []
    assert profile["price_range"] == {"min": 0, "max": 0, "avg": 0}
    assert profile["style_tags"] == []
