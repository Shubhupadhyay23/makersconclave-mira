"""Tests for user endpoints including DELETE."""

import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport
from main import app

transport = ASGITransport(app=app)


@pytest.mark.asyncio
async def test_delete_user_success():
    """DELETE /users/{id} returns 200 with status deleted."""
    mock_db = AsyncMock()
    mock_db.execute.return_value = [{"id": "abc-123"}]

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.delete("/users/abc-123")

    assert response.status_code == 200
    assert response.json() == {"status": "deleted"}
    mock_db.execute.assert_called_once()
    assert "DELETE FROM users" in mock_db.execute.call_args[0][0]


@pytest.mark.asyncio
async def test_delete_user_not_found():
    """DELETE /users/{id} returns 404 when user doesn't exist."""
    mock_db = AsyncMock()
    mock_db.execute.return_value = []

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.delete("/users/nonexistent-id")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_user_closes_db():
    """DELETE /users/{id} always closes the DB connection, even on errors."""
    mock_db = AsyncMock()
    mock_db.execute.side_effect = Exception("DB error")

    with patch("routers.users.NeonHTTPClient", return_value=mock_db):
        transport_err = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport_err, base_url="http://test") as ac:
            response = await ac.delete("/users/abc-123")

    assert response.status_code == 500
    mock_db.close.assert_called_once()
