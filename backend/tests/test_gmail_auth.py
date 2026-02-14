"""Tests for Gmail OAuth token exchange."""

import pytest
from unittest.mock import patch, MagicMock
from scraper.gmail_auth import exchange_auth_code, build_gmail_service


def test_exchange_auth_code_returns_credentials():
    """exchange_auth_code calls Google OAuth and returns token dict."""
    mock_flow = MagicMock()
    mock_flow.credentials.token = "access_token_123"
    mock_flow.credentials.refresh_token = "refresh_token_456"
    mock_flow.credentials.token_uri = "https://oauth2.googleapis.com/token"
    mock_flow.credentials.client_id = "client_id"
    mock_flow.credentials.client_secret = "client_secret"
    mock_flow.credentials.scopes = ["https://www.googleapis.com/auth/gmail.readonly"]

    with patch("scraper.gmail_auth.InstalledAppFlow") as MockFlow, \
         patch.dict("os.environ", {"GOOGLE_CLIENT_ID": "test_id", "GOOGLE_CLIENT_SECRET": "test_secret"}):
        MockFlow.from_client_config.return_value = mock_flow
        result = exchange_auth_code("fake_auth_code", redirect_uri="http://localhost:3000")

    assert result["access_token"] == "access_token_123"
    assert result["refresh_token"] == "refresh_token_456"
    assert "token_uri" in result


def test_build_gmail_service_returns_resource():
    """build_gmail_service creates a Gmail API resource from stored tokens."""
    token_data = {
        "access_token": "access_123",
        "refresh_token": "refresh_456",
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "cid",
        "client_secret": "csecret",
    }
    with patch("scraper.gmail_auth.build") as mock_build:
        mock_build.return_value = MagicMock()
        service = build_gmail_service(token_data)

    mock_build.assert_called_once()
    assert service is not None
