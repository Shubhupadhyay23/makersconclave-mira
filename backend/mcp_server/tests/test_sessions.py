"""Tests for Poke MCP server session tools."""

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def mock_pool():
    """Create a mock asyncpg pool with an async-context-manager acquire().

    asyncpg's pool.acquire() is a synchronous call that returns an async
    context manager, so we use MagicMock for the pool and configure the
    return value to support ``async with``.
    """
    pool = MagicMock()
    conn = AsyncMock()
    # pool.acquire() returns an object with __aenter__ / __aexit__
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=False)
    pool.acquire.return_value = ctx
    return pool, conn


# ---------------------------------------------------------------------------
# get_past_sessions tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_past_sessions_returns_liked_items_with_product_details(mock_pool):
    """Happy path: user has sessions with liked items and a summary."""
    from mcp_server.server import _get_past_sessions

    pool, conn = mock_pool

    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    item_id_1 = uuid.uuid4()
    item_id_2 = uuid.uuid4()

    # 1) fetchrow for user lookup
    conn.fetchrow.return_value = {"id": user_id, "phone": "+15551234567"}

    # 2) First fetch call: sessions
    sessions_rows = [
        {
            "id": session_id,
            "started_at": "2025-01-15T10:00:00+00:00",
            "ended_at": "2025-01-15T10:30:00+00:00",
            "status": "completed",
        }
    ]

    # 3) Second fetch call: outfits for that session
    outfits_rows = [
        {
            "id": uuid.uuid4(),
            "reaction": "liked",
            "outfit_data": {},
            "clothing_items": [item_id_1, item_id_2],
        },
        {
            "id": uuid.uuid4(),
            "reaction": "summary",
            "outfit_data": {"summary": "Great session with bold choices"},
            "clothing_items": [],
        },
    ]

    # 4) Third fetch call: clothing items for liked outfit
    clothing_rows = [
        {
            "id": item_id_1,
            "name": "Blue Jacket",
            "brand": "Nike",
            "price": 120.00,
            "image_url": "https://example.com/jacket.jpg",
            "buy_url": "https://example.com/buy/jacket",
            "category": "outerwear",
        },
        {
            "id": item_id_2,
            "name": "Black Jeans",
            "brand": "Levi's",
            "price": 80.00,
            "image_url": "https://example.com/jeans.jpg",
            "buy_url": "https://example.com/buy/jeans",
            "category": "bottoms",
        },
    ]

    conn.fetch.side_effect = [sessions_rows, outfits_rows, clothing_rows]

    result = await _get_past_sessions(pool, "+15551234567", limit=10)

    assert result["ok"] is True
    assert len(result["sessions"]) == 1

    session = result["sessions"][0]
    assert session["session_id"] == str(session_id)
    assert session["status"] == "completed"

    # Flat liked_items array with full product details
    assert len(session["liked_items"]) == 2
    assert session["liked_items"][0]["name"] == "Blue Jacket"
    assert session["liked_items"][0]["brand"] == "Nike"
    assert session["liked_items"][0]["price"] == 120.00
    assert session["liked_items"][0]["image_url"] == "https://example.com/jacket.jpg"
    assert session["liked_items"][0]["buy_url"] == "https://example.com/buy/jacket"
    assert session["liked_items"][1]["name"] == "Black Jeans"

    # Top-level summary string
    assert session["summary"] == "Great session with bold choices"


@pytest.mark.asyncio
async def test_get_past_sessions_user_not_found(mock_pool):
    """Phone number does not match any user."""
    from mcp_server.server import _get_past_sessions

    pool, conn = mock_pool

    conn.fetchrow.return_value = None

    result = await _get_past_sessions(pool, "+15559999999", limit=10)

    assert result["ok"] is False
    assert "not found" in result["error"].lower()


@pytest.mark.asyncio
async def test_get_past_sessions_no_sessions(mock_pool):
    """User exists but has no sessions."""
    from mcp_server.server import _get_past_sessions

    pool, conn = mock_pool

    user_id = uuid.uuid4()
    conn.fetchrow.return_value = {"id": user_id, "phone": "+15551234567"}
    conn.fetch.return_value = []

    result = await _get_past_sessions(pool, "+15551234567", limit=10)

    assert result["ok"] is True
    assert result["sessions"] == []


# ---------------------------------------------------------------------------
# save_session tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_save_session_inserts_summary(mock_pool):
    """Happy path: save a session summary."""
    from mcp_server.server import _save_session

    pool, conn = mock_pool

    user_id = uuid.uuid4()
    session_id = uuid.uuid4()

    # 1) fetchrow for user lookup
    # 2) fetchrow for session lookup
    conn.fetchrow.side_effect = [
        {"id": user_id, "phone": "+15551234567"},
        {"id": session_id, "user_id": user_id},
    ]

    conn.execute.return_value = "INSERT 0 1"

    result = await _save_session(
        pool, "+15551234567", str(session_id), "Loved the outfit suggestions"
    )

    assert result["ok"] is True
    assert result["session_id"] == str(session_id)

    # Verify the INSERT was called
    conn.execute.assert_called_once()
    call_args = conn.execute.call_args
    assert "INSERT INTO session_outfits" in call_args[0][0]
    assert call_args[0][1] == session_id  # session_id param
    assert "summary" in str(call_args[0][2])  # outfit_data JSON contains summary


@pytest.mark.asyncio
async def test_save_session_wrong_user(mock_pool):
    """Session exists but belongs to a different user."""
    from mcp_server.server import _save_session

    pool, conn = mock_pool

    user_id = uuid.uuid4()
    other_user_id = uuid.uuid4()
    session_id = uuid.uuid4()

    conn.fetchrow.side_effect = [
        {"id": user_id, "phone": "+15551234567"},
        {"id": session_id, "user_id": other_user_id},  # different user
    ]

    result = await _save_session(
        pool, "+15551234567", str(session_id), "Summary text"
    )

    assert result["ok"] is False
    assert "does not belong" in result["error"].lower() or "not belong" in result["error"].lower()


@pytest.mark.asyncio
async def test_save_session_user_not_found(mock_pool):
    """Phone number does not match any user."""
    from mcp_server.server import _save_session

    pool, conn = mock_pool

    conn.fetchrow.return_value = None

    result = await _save_session(
        pool, "+15559999999", str(uuid.uuid4()), "Summary text"
    )

    assert result["ok"] is False
    assert "not found" in result["error"].lower()
