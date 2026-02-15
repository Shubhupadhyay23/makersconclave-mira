"""Tests for the LiveAvatar token endpoint."""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from httpx import AsyncClient, ASGITransport
from main import app

transport = ASGITransport(app=app)

MOCK_SUCCESS_RESPONSE = {
    "code": 1000,
    "data": {
        "session_token": "la_token_abc",
        "session_id": "sess_123",
    },
    "message": None,
}


def _mock_client(mock_response):
    """Create a mock httpx.AsyncClient context manager."""
    instance = AsyncMock()
    instance.post.return_value = mock_response
    instance.__aenter__ = AsyncMock(return_value=instance)
    instance.__aexit__ = AsyncMock(return_value=False)
    return instance


@pytest.mark.asyncio
async def test_create_liveavatar_token_success():
    """POST /api/heygen/token returns session_token and session_id."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = MOCK_SUCCESS_RESPONSE

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        MockClient.return_value = _mock_client(mock_response)

        with patch.dict("os.environ", {
            "HEYGEN_API_KEY": "test_key",
            "LIVEAVATAR_AVATAR_ID": "avatar_abc",
        }):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post("/api/heygen/token")

    assert response.status_code == 200
    body = response.json()
    assert body["session_token"] == "la_token_abc"
    assert body["session_id"] == "sess_123"


@pytest.mark.asyncio
async def test_create_liveavatar_token_sends_mode_lite():
    """Request payload includes mode=LITE for direct speech control."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = MOCK_SUCCESS_RESPONSE

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        mock_instance = _mock_client(mock_response)
        MockClient.return_value = mock_instance

        with patch.dict("os.environ", {
            "HEYGEN_API_KEY": "test_key",
            "LIVEAVATAR_AVATAR_ID": "avatar_abc",
        }):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                await ac.post("/api/heygen/token")

    call_kwargs = mock_instance.post.call_args
    payload = call_kwargs.kwargs["json"]
    assert payload["mode"] == "LITE"
    assert payload["avatar_id"] == "avatar_abc"


@pytest.mark.asyncio
async def test_create_liveavatar_token_missing_api_key():
    """Returns 500 when HEYGEN_API_KEY is not set."""
    with patch.dict("os.environ", {}, clear=True):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post("/api/heygen/token")

    assert response.status_code == 500
    assert "HEYGEN_API_KEY" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_liveavatar_token_missing_avatar_id():
    """Returns 500 when LIVEAVATAR_AVATAR_ID is not set and not in sandbox mode."""
    with patch.dict("os.environ", {"HEYGEN_API_KEY": "test_key"}, clear=True):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post("/api/heygen/token")

    assert response.status_code == 500
    assert "LIVEAVATAR_AVATAR_ID" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_liveavatar_token_sandbox_mode():
    """Sandbox mode uses fixed Wayne avatar ID and sets is_sandbox=true in payload."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "code": 1000,
        "data": {"session_token": "sandbox_token", "session_id": "sandbox_sess"},
        "message": None,
    }

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        mock_instance = _mock_client(mock_response)
        MockClient.return_value = mock_instance

        with patch.dict("os.environ", {"HEYGEN_API_KEY": "test_key"}, clear=True):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/api/heygen/token",
                    json={"is_sandbox": True},
                )

    assert response.status_code == 200
    assert response.json()["session_token"] == "sandbox_token"

    call_kwargs = mock_instance.post.call_args
    payload = call_kwargs.kwargs["json"]
    assert payload["avatar_id"] == "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"
    assert payload["is_sandbox"] is True


@pytest.mark.asyncio
async def test_create_liveavatar_token_api_error():
    """Returns 502 when LiveAvatar API returns an error."""
    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.text = "Unauthorized"

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        MockClient.return_value = _mock_client(mock_response)

        with patch.dict("os.environ", {
            "HEYGEN_API_KEY": "bad_key",
            "LIVEAVATAR_AVATAR_ID": "avatar_abc",
        }):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post("/api/heygen/token")

    assert response.status_code == 502
    assert "LiveAvatar API error" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_liveavatar_token_sends_voice_and_context():
    """Optional LIVEAVATAR_VOICE_ID and LIVEAVATAR_CONTEXT_ID go in avatar_persona."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = MOCK_SUCCESS_RESPONSE

    with patch("routers.heygen.httpx.AsyncClient") as MockClient:
        mock_instance = _mock_client(mock_response)
        MockClient.return_value = mock_instance

        with patch.dict("os.environ", {
            "HEYGEN_API_KEY": "test_key",
            "LIVEAVATAR_AVATAR_ID": "avatar_abc",
            "LIVEAVATAR_VOICE_ID": "voice_xyz",
            "LIVEAVATAR_CONTEXT_ID": "ctx_123",
        }):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                await ac.post("/api/heygen/token")

    call_kwargs = mock_instance.post.call_args
    payload = call_kwargs.kwargs["json"]
    assert payload["avatar_persona"]["voice_id"] == "voice_xyz"
    assert payload["avatar_persona"]["context_id"] == "ctx_123"
    assert payload["avatar_persona"]["language"] == "en"


@pytest.mark.asyncio
async def test_create_liveavatar_token_live_sandbox():
    """Integration test: actually hits the LiveAvatar API in sandbox mode.

    Requires HEYGEN_API_KEY env var. Skipped if not set.
    """
    import os
    api_key = os.environ.get("HEYGEN_API_KEY")
    if not api_key:
        pytest.skip("HEYGEN_API_KEY not set — skipping live API test")

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post(
            "/api/heygen/token",
            json={"is_sandbox": True},
        )

    assert response.status_code == 200
    body = response.json()
    assert "session_token" in body
    assert "session_id" in body
    assert len(body["session_token"]) > 50  # JWT token
