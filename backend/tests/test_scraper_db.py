"""Tests for scraper database operations (unit tests with mocked DB)."""

import pytest
from unittest.mock import AsyncMock
from scraper.db import store_purchases, store_style_profile, get_user_token


@pytest.mark.asyncio
async def test_store_purchases_inserts_rows():
    """store_purchases inserts each purchase into the purchases table."""
    db = AsyncMock()
    db.execute.return_value = []

    purchases = [
        {
            "brand": "Nike",
            "item_name": "Air Max 90",
            "category": "shoes",
            "price": 129.99,
            "date": "2026-01-15",
            "source_email_id": "msg1",
            "merchant": "Nike",
            "order_status": "confirmed",
            "tracking_number": None,
            "receipt_text": "Your Nike order...",
        },
        {
            "brand": "Zara",
            "item_name": "Slim Jeans",
            "category": "bottoms",
            "price": 49.90,
            "date": "2026-02-01",
            "source_email_id": "msg2",
            "merchant": "Zara",
            "order_status": "shipped",
            "tracking_number": "1Z999AA10123456784",
            "receipt_text": "Your Zara order has shipped...",
        },
    ]
    await store_purchases(db, "user-uuid-123", purchases)
    assert db.execute.call_count == 2


@pytest.mark.asyncio
async def test_store_purchases_includes_new_columns():
    """store_purchases INSERT includes merchant, order_status, tracking_number, receipt_text."""
    db = AsyncMock()
    db.execute.return_value = []

    purchases = [
        {
            "brand": "Nike",
            "item_name": "Air Max 90",
            "category": "shoes",
            "price": 129.99,
            "date": "2026-01-15",
            "source_email_id": "msg1",
            "merchant": "Amazon",
            "order_status": "delivered",
            "tracking_number": "1Z999AA10123456784",
            "receipt_text": "Your order of Nike Air Max 90 has been delivered.",
        },
    ]
    await store_purchases(db, "user-uuid-123", purchases)
    call_args = db.execute.call_args
    sql = call_args[0][0]
    params = call_args[0][1]
    assert "merchant" in sql
    assert "order_status" in sql
    assert "tracking_number" in sql
    assert "receipt_text" in sql
    assert "ON CONFLICT" in sql
    assert "DO NOTHING" in sql
    assert params[7] == "Amazon"       # merchant
    assert params[8] == "delivered"    # order_status
    assert params[9] == "1Z999AA10123456784"  # tracking_number
    assert params[10] == "Your order of Nike Air Max 90 has been delivered."  # receipt_text


@pytest.mark.asyncio
async def test_store_purchases_truncates_receipt_text():
    """store_purchases truncates receipt_text to 500 chars."""
    db = AsyncMock()
    db.execute.return_value = []

    long_text = "x" * 1000
    purchases = [
        {
            "brand": "Nike",
            "item_name": "Shoes",
            "category": "shoes",
            "price": 100,
            "date": "2026-01-15",
            "source_email_id": "msg1",
            "merchant": None,
            "order_status": None,
            "tracking_number": None,
            "receipt_text": long_text,
        },
    ]
    await store_purchases(db, "user-uuid-123", purchases)
    call_args = db.execute.call_args
    params = call_args[0][1]
    assert len(params[10]) == 500


@pytest.mark.asyncio
async def test_store_purchases_handles_missing_new_fields():
    """store_purchases works when new fields are absent (backwards compat)."""
    db = AsyncMock()
    db.execute.return_value = []

    purchases = [
        {
            "brand": "Nike",
            "item_name": "Air Max 90",
            "category": "shoes",
            "price": 129.99,
            "date": "2026-01-15",
            "source_email_id": "msg1",
        },
    ]
    await store_purchases(db, "user-uuid-123", purchases)
    call_args = db.execute.call_args
    params = call_args[0][1]
    assert params[7] is None   # merchant
    assert params[8] is None   # order_status
    assert params[9] is None   # tracking_number
    assert params[10] is None  # receipt_text


@pytest.mark.asyncio
async def test_store_style_profile_upserts():
    """store_style_profile upserts into style_profiles table."""
    db = AsyncMock()
    db.execute.return_value = []

    profile = {
        "brands": ["Nike", "Zara"],
        "price_range": {"min": 49.90, "max": 129.99, "avg": 89.95},
        "style_tags": ["casual", "sneakerhead"],
        "narrative_summary": "Shops at Nike and Zara.",
    }
    await store_style_profile(db, "user-uuid-123", profile)
    db.execute.assert_called_once()
    call_args = db.execute.call_args
    assert "INSERT INTO style_profiles" in call_args[0][0]
    assert "ON CONFLICT" in call_args[0][0]


@pytest.mark.asyncio
async def test_get_user_token_returns_token_data():
    """get_user_token fetches google_oauth_token from users table."""
    db = AsyncMock()
    db.execute.return_value = [{"google_oauth_token": {"access_token": "abc"}}]

    result = await get_user_token(db, "user-uuid-123")
    assert result["access_token"] == "abc"
