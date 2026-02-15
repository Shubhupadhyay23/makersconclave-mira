"""Tests for outfit recommendations feature."""

import os
import uuid
from datetime import date, datetime, timedelta

import pytest
import pytest_asyncio
from dotenv import load_dotenv

from models.database import NeonHTTPClient
from services.user_data_service import (
    get_user_profile_and_purchases,
    is_new_user,
    save_onboarding_data,
)

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

DATABASE_URL = os.getenv("DATABASE_URL", "")


@pytest_asyncio.fixture(scope="session")
async def db():
    """Get database client (session-scoped to match event loop)."""
    client = NeonHTTPClient(DATABASE_URL)
    yield client
    await client.close()


@pytest_asyncio.fixture
async def test_user_with_purchases(db):
    """Create a test user with purchase history and style profile."""
    # Create user
    email = f"test_{uuid.uuid4().hex[:8]}@mirrorless.test"
    user_rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Test User", email],
    )
    user_id = str(user_rows[0]["id"])

    # Add style profile
    await db.execute(
        """
        INSERT INTO style_profiles (user_id, brands, price_range, style_tags, size_info)
        VALUES ($1, $2, $3, $4, $5)
        """,
        [
            user_id,
            ["Nike", "Zara", "Uniqlo", "H&M", "Adidas"],
            {"min": 30, "max": 200},
            ["casual", "streetwear", "minimalist"],
            {"top": "M", "bottom": "32", "shoe": "10"},
        ],
    )

    # Add purchase history (last 4 months)
    purchases = [
        ("Nike", "Air Max 90", "shoes", 129.99, date.today() - timedelta(days=30)),
        ("Zara", "Black Crew Neck Tee", "top", 19.99, date.today() - timedelta(days=45)),
        ("Uniqlo", "Slim Fit Jeans", "bottom", 49.99, date.today() - timedelta(days=60)),
        ("H&M", "Denim Jacket", "outerwear", 59.99, date.today() - timedelta(days=90)),
        ("Adidas", "Track Pants", "bottom", 65.00, date.today() - timedelta(days=120)),
        ("Nike", "Hoodie", "top", 75.00, date.today() - timedelta(days=15)),
    ]

    for brand, item, category, price, purchase_date in purchases:
        await db.execute(
            """
            INSERT INTO purchases (user_id, brand, item_name, category, price, date)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            [user_id, brand, item, category, price, purchase_date],
        )

    yield user_id

    # Cleanup
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


@pytest_asyncio.fixture
async def test_session(db, test_user_with_purchases):
    """Create an active session for the test user."""
    session_rows = await db.execute(
        "INSERT INTO sessions (user_id, status) VALUES ($1, $2) RETURNING id",
        [test_user_with_purchases, "active"],
    )
    session_id = str(session_rows[0]["id"])
    yield session_id
    # Session will be cleaned up via user cascade delete


async def test_get_user_profile_and_purchases(db, test_user_with_purchases):
    """Test fetching user data with purchase history."""
    user_data = await get_user_profile_and_purchases(db, test_user_with_purchases)

    assert user_data is not None
    assert user_data["user"]["name"] == "Test User"
    assert user_data["style_profile"] is not None
    assert "Nike" in user_data["style_profile"]["brands"]
    assert len(user_data["recent_purchases"]) == 6
    assert len(user_data["top_brands"]) <= 5
    # Nike should be top brand (2 purchases)
    assert "Nike" in user_data["top_brands"]


async def test_is_new_user(db, test_user_with_purchases):
    """Test new user detection."""
    # User with purchases should not be new
    is_new = await is_new_user(db, test_user_with_purchases)
    assert is_new is False

    # Create new user without purchases
    email = f"new_{uuid.uuid4().hex[:8]}@mirrorless.test"
    new_user_rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["New User", email],
    )
    new_user_id = str(new_user_rows[0]["id"])

    is_new = await is_new_user(db, new_user_id)
    assert is_new is True

    # Cleanup
    await db.execute("DELETE FROM users WHERE id = $1", [new_user_id])


async def test_save_onboarding_data(db):
    """Test saving onboarding questionnaire."""
    # Create new user
    email = f"onboard_{uuid.uuid4().hex[:8]}@mirrorless.test"
    user_rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Onboard User", email],
    )
    user_id = str(user_rows[0]["id"])

    # Save onboarding data
    questionnaire = {
        "favorite_brands": ["Nike", "Adidas", "Zara"],
        "price_range": {"min": 20, "max": 150},
        "style_preferences": ["casual", "athletic"],
        "size_info": {"top": "L", "bottom": "34"},
    }

    await save_onboarding_data(db, user_id, questionnaire)

    # Verify saved
    profile_rows = await db.execute(
        "SELECT * FROM style_profiles WHERE user_id = $1", [user_id]
    )
    assert len(profile_rows) == 1
    profile = profile_rows[0]
    assert "Nike" in profile["brands"]
    assert profile["price_range"]["min"] == 20
    assert "casual" in profile["style_tags"]

    # Cleanup
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


async def test_top_brands_calculation(db, test_user_with_purchases):
    """Test that top brands are correctly calculated by purchase frequency."""
    user_data = await get_user_profile_and_purchases(db, test_user_with_purchases)

    top_brands = user_data["top_brands"]
    # Nike has 2 purchases, should be first
    assert top_brands[0] == "Nike"


async def test_recent_purchases_filter(db, test_user_with_purchases):
    """Test that only recent purchases (6 months) are returned."""
    # Add an old purchase (8 months ago)
    old_date = date.today() - timedelta(days=240)
    await db.execute(
        """
        INSERT INTO purchases (user_id, brand, item_name, category, price, date)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        [test_user_with_purchases, "OldBrand", "Old Item", "misc", 99.99, old_date],
    )

    user_data = await get_user_profile_and_purchases(db, test_user_with_purchases)

    # Old purchase should not be in recent_purchases
    old_items = [p for p in user_data["recent_purchases"] if p["brand"] == "OldBrand"]
    assert len(old_items) == 0


# Integration test (requires API keys)
@pytest.mark.skipif(
    not os.getenv("SERPER_API_KEY") or not os.getenv("ANTHROPIC_API_KEY"),
    reason="Requires SERPER_API_KEY and ANTHROPIC_API_KEY",
)
async def test_generate_recommendations_integration(db, test_user_with_purchases, test_session):
    """Integration test for full recommendation flow (requires API keys)."""
    from agent.orchestrator import generate_outfit_recommendations

    result = await generate_outfit_recommendations(
        test_user_with_purchases, test_session, db
    )

    assert result["status"] == "success", f"Got error: {result}"
    assert "data" in result
    assert "outfits" in result["data"]
    assert len(result["data"]["outfits"]) >= 3
    assert result["generation_time_ms"] > 0
    assert result["generation_time_ms"] < 60000  # Should be under 1 minute

    # Verify outfit structure
    first_outfit = result["data"]["outfits"][0]
    assert "outfit_name" in first_outfit
    assert "description" in first_outfit
    assert "items" in first_outfit
    assert len(first_outfit["items"]) >= 2  # At least top + bottom


@pytest.mark.skipif(
    not os.getenv("SERPER_API_KEY"),
    reason="Requires SERPER_API_KEY",
)
async def test_serper_batch_fetching():
    """Test Serper batch fetching functionality."""
    from services.serper_search import build_brand_queries, fetch_clothing_batch

    # Build queries
    brands = ["Nike", "Adidas"]
    queries = build_brand_queries(brands, gender="mens")

    assert "tops" in queries
    assert "bottoms" in queries
    assert len(queries["tops"]) >= 2
    assert len(queries["bottoms"]) >= 2

    # Fetch batch
    all_queries = queries["tops"][:2] + queries["bottoms"][:2]  # Limit for speed
    api_key = os.getenv("SERPER_API_KEY")
    results = await fetch_clothing_batch(all_queries, api_key, num_results_per_query=5)

    assert len(results) > 0
    # Verify item structure
    first_item = results[0]
    assert "title" in first_item
    assert "price" in first_item
    assert "link" in first_item
    assert "product_id" in first_item


async def test_serper_cache():
    """Test session cache functionality."""
    from services.serper_cache import SerperCache

    cache = SerperCache(ttl_seconds=2)

    session_id = "test-session-123"
    test_data = [{"product_id": "123", "title": "Test Item"}]

    # Set and get
    cache.set(session_id, test_data)
    cached = cache.get(session_id)
    assert cached == test_data

    # Test expiration
    import asyncio
    await asyncio.sleep(3)
    expired = cache.get(session_id)
    assert expired is None

    # Test invalidation
    cache.set(session_id, test_data)
    cache.invalidate(session_id)
    invalidated = cache.get(session_id)
    assert invalidated is None
