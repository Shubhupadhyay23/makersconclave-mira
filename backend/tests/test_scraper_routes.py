"""Tests for scraping API routes."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from httpx import AsyncClient, ASGITransport
from main import app
from scraper.pipeline import ScrapeResult


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.execute.return_value = []
    return db


@pytest.mark.asyncio
async def test_exchange_token_endpoint(mock_db):
    """POST /api/scrape/auth exchanges auth code and stores token."""
    mock_token = {"access_token": "abc", "refresh_token": "def"}

    with (
        patch("scraper.routes.get_neon_client", return_value=mock_db),
        patch("scraper.routes.exchange_auth_code", return_value=mock_token),
    ):
        mock_db.execute.return_value = [{"id": "user-123"}]
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/scrape/auth",
                json={"user_id": "user-123", "auth_code": "code123", "redirect_uri": "http://localhost:3000"},
            )
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_start_scrape_returns_started(mock_db):
    """POST /api/scrape/start returns immediately with {status: 'started'}."""
    mock_db.execute.return_value = [{"google_oauth_token": {"access_token": "abc"}}]

    with (
        patch("scraper.routes.get_neon_client", return_value=mock_db),
        patch("scraper.routes.asyncio.create_task") as mock_task,
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/scrape/start",
                json={"user_id": "user-123"},
            )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "started"
    mock_task.assert_called_once()


@pytest.mark.asyncio
async def test_start_scrape_no_token(mock_db):
    """POST /api/scrape/start returns 400 if user has no OAuth token."""
    mock_db.execute.return_value = [{"google_oauth_token": None}]

    with patch("scraper.routes.get_neon_client", return_value=mock_db):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/scrape/start",
                json={"user_id": "user-123"},
            )
    assert resp.status_code == 400
