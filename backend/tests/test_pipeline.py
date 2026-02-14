"""Tests for the scraping pipeline orchestrator."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from scraper.pipeline import fast_scrape, ScrapeResult


def _mock_gmail_service():
    svc = MagicMock()
    # search_emails mock
    list_mock = MagicMock()
    list_mock.execute.return_value = {
        "messages": [{"id": "msg1"}],
    }
    svc.users.return_value.messages.return_value.list.return_value = list_mock

    # get_message_content mock
    get_mock = MagicMock()
    get_mock.execute.return_value = {
        "id": "msg1",
        "payload": {
            "headers": [
                {"name": "Subject", "value": "Your Nike order: Air Max 90"},
                {"name": "From", "value": "auto-confirm@amazon.com"},
                {"name": "Date", "value": "Mon, 10 Feb 2026 12:00:00 -0800"},
            ],
            "mimeType": "text/plain",
            "body": {"data": "TmlrZSBBaXIgTWF4IDkwIC0gJDEyOS45OQ=="},
        },
    }
    svc.users.return_value.messages.return_value.get.return_value = get_mock
    return svc


@pytest.mark.asyncio
async def test_fast_scrape_returns_result():
    """fast_scrape returns a ScrapeResult with purchases and brand_freq."""
    mock_svc = _mock_gmail_service()

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        result = await fast_scrape(token_data={"access_token": "test"})

    assert isinstance(result, ScrapeResult)
    assert isinstance(result.purchases, list)
    assert isinstance(result.brand_freq, dict)
    assert isinstance(result.profile, dict)


@pytest.mark.asyncio
async def test_fast_scrape_returns_profile_with_brands():
    """fast_scrape profile includes detected brands."""
    mock_svc = _mock_gmail_service()

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        result = await fast_scrape(token_data={"access_token": "test"})

    assert "brands" in result.profile
    assert "price_range" in result.profile
