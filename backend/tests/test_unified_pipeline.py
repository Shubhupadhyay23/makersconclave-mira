"""Tests for the unified recommendation pipeline.

Verifies that both REST and agent paths produce display_product payloads
that the mirror's ClothingCanvas can consume.
"""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.orchestrator import (
    SessionState,
    _outfits_to_display_payloads,
)


# --- _outfits_to_display_payloads ---


def _make_outfit(items, outfit_name="Test Outfit"):
    """Helper to build an outfit dict matching the REST pipeline format."""
    return {
        "outfit_name": outfit_name,
        "items": [
            {
                "type": item_type,
                "item": {
                    "title": title,
                    "price": "$50",
                    "image_url": "https://example.com/raw.jpg",
                    "product_id": f"pid-{i}",
                    "link": "https://example.com",
                    "source": "test",
                    **(extra or {}),
                },
            }
            for i, (item_type, title, extra) in enumerate(items)
        ],
    }


class TestOutfitsToDisplayPayloads:
    def test_converts_outfits_with_flat_lays(self):
        """Items with flat lay images are included in the payload."""
        outfits = [
            _make_outfit([
                ("top", "Blue Shirt", {"cleaned_image_url": "data:image/png;base64,abc"}),
                ("bottom", "Black Pants", {"flat_image_url": "data:image/png;base64,def"}),
            ])
        ]
        payloads = _outfits_to_display_payloads(outfits)

        assert len(payloads) == 1
        assert payloads[0]["type"] == "display_product"
        assert payloads[0]["outfit_name"] == "Test Outfit"
        assert len(payloads[0]["items"]) == 2
        assert payloads[0]["items"][0]["title"] == "Blue Shirt"
        assert payloads[0]["items"][0]["type"] == "top"
        assert payloads[0]["items"][1]["title"] == "Black Pants"

    def test_skips_items_without_flat_lays(self):
        """Items with only raw image_url (no flat lay) are excluded."""
        outfits = [
            _make_outfit([
                ("top", "Has Flat Lay", {"cleaned_image_url": "data:image/png;base64,abc"}),
                ("bottom", "No Flat Lay", {}),  # no cleaned_image_url or flat_image_url
            ])
        ]
        payloads = _outfits_to_display_payloads(outfits)

        assert len(payloads) == 1
        assert len(payloads[0]["items"]) == 1
        assert payloads[0]["items"][0]["title"] == "Has Flat Lay"

    def test_empty_when_no_flat_lays(self):
        """Returns empty list when no items have flat lay images."""
        outfits = [
            _make_outfit([
                ("top", "Raw Only", {}),
                ("bottom", "Also Raw", {}),
            ])
        ]
        payloads = _outfits_to_display_payloads(outfits)
        assert payloads == []

    def test_multiple_outfits(self):
        """Each outfit becomes a separate payload."""
        outfits = [
            _make_outfit(
                [("top", "Shirt A", {"cleaned_image_url": "data:a"})],
                outfit_name="Outfit A",
            ),
            _make_outfit(
                [("bottom", "Pants B", {"flat_image_url": "data:b"})],
                outfit_name="Outfit B",
            ),
        ]
        payloads = _outfits_to_display_payloads(outfits)
        assert len(payloads) == 2
        assert payloads[0]["outfit_name"] == "Outfit A"
        assert payloads[1]["outfit_name"] == "Outfit B"

    def test_empty_outfits_list(self):
        """Empty input returns empty output."""
        assert _outfits_to_display_payloads([]) == []


# --- Voice message caching ---


class TestVoiceMessageCaching:
    def test_voice_messages_field_exists(self):
        """SessionState has a voice_messages list."""
        session = SessionState()
        assert isinstance(session.voice_messages, list)
        assert len(session.voice_messages) == 0

    @pytest.mark.asyncio
    async def test_voice_message_cached_in_handle_tool_calls(self):
        """After processing send_voice_to_client, the message is cached."""
        from agent.orchestrator import MiraOrchestrator

        orchestrator = MiraOrchestrator(socket_io=None)
        session = SessionState(user_id="test-user")
        orchestrator.sessions["test-user"] = session

        # Create a mock tool_use block
        tool_use = MagicMock()
        tool_use.name = "send_voice_to_client"
        tool_use.id = "tool-123"
        tool_use.input = {"text": "Hello there!", "emotion": "happy"}

        # Mock execute_tool to return a voice result
        with patch("agent.orchestrator.execute_tool", new_callable=AsyncMock) as mock_exec:
            mock_exec.return_value = {
                "sent": True,
                "text": "Hello there!",
                "emotion": "happy",
                "frontend_payload": {
                    "type": "voice_message",
                    "text": "Hello there!",
                    "emotion": "happy",
                },
            }

            # Mock _call_claude to prevent recursion
            with patch.object(orchestrator, "_call_claude", new_callable=AsyncMock):
                await orchestrator._handle_tool_calls(session, [tool_use])

        assert len(session.voice_messages) == 1
        assert session.voice_messages[0]["text"] == "Hello there!"
        assert session.voice_messages[0]["emotion"] == "happy"
        assert "timestamp" in session.voice_messages[0]


# --- display_product tool generates flat lays ---


class TestDisplayProduct:
    @pytest.mark.asyncio
    async def test_display_product_calls_gemini(self):
        """_display_product calls Gemini and maps flat lay URLs onto items."""
        from agent.tools import _display_product

        mock_flat_lays = {"pid-1": "data:image/png;base64,flatlay1"}

        mock_module = MagicMock()
        mock_module.generate_flat_lays_batch = AsyncMock(return_value=mock_flat_lays)

        with patch.dict("sys.modules", {"services.gemini_flatlay": mock_module}):
            result = await _display_product({
                "items": [
                    {"image_url": "https://img.com/1.jpg", "title": "Test Shirt", "product_id": "pid-1", "type": "top"},
                ],
                "outfit_name": "Test Outfit",
            })

        assert result["displayed"] == 1
        assert result["items"][0]["cleaned_image_url"] == "data:image/png;base64,flatlay1"
        assert result["items"][0]["flat_image_url"] == "data:image/png;base64,flatlay1"
        assert result["frontend_payload"]["type"] == "display_product"
        assert result["frontend_payload"]["outfit_name"] == "Test Outfit"


# --- give_recommendation caching ---


class TestGiveRecommendationCache:
    @pytest.mark.asyncio
    async def test_caches_serper_results(self):
        """execute_give_recommendation stores results in serper_cache, second call hits cache."""
        from agent.tools import execute_give_recommendation
        from services.serper_cache import serper_cache

        session_id = "test-session-cache"
        serper_cache._cache.pop(session_id, None)  # ensure clean state

        mock_items = [
            {"title": "Shirt", "price": "$30", "image_url": "https://img.com/1.jpg",
             "product_id": "p1", "link": "https://example.com", "source": "Serper",
             "rating": None, "clothing_category": "top"},
        ]

        with patch("agent.tools.fetch_clothing_batch", new_callable=AsyncMock, return_value=mock_items):
            result1 = await execute_give_recommendation({"brands": ["Nike"], "gender": "mens"}, session_id)

        # Second call should hit cache (no fetch_clothing_batch call needed)
        with patch("agent.tools.fetch_clothing_batch", new_callable=AsyncMock) as mock_fetch:
            result2 = await execute_give_recommendation({"brands": ["Nike"], "gender": "mens"}, session_id)
            mock_fetch.assert_not_called()

        assert "Shirt" in result1
        assert "Shirt" in result2

        # Cleanup
        serper_cache._cache.pop(session_id, None)


# --- session_started socket handler ---


class TestSessionStartedHandler:
    @pytest.mark.asyncio
    async def test_emits_display_product_not_outfits_ready(self):
        """session_started handler emits tool_result events, not outfits_ready."""
        from main import session_started

        mock_sio = AsyncMock()

        outfits = [
            _make_outfit([
                ("top", "Test Top", {"cleaned_image_url": "data:top"}),
                ("bottom", "Test Bottom", {"flat_image_url": "data:bottom"}),
            ], outfit_name="Casual Look"),
        ]

        mock_result = {
            "status": "success",
            "data": {"outfits": outfits, "greeting": "Hey!", "style_analysis": "Cool"},
        }

        with patch("main.get_neon_client", new_callable=AsyncMock) as mock_db, \
             patch("main.generate_outfit_recommendations", new_callable=AsyncMock, return_value=mock_result), \
             patch("main.sio", mock_sio):
            mock_db.return_value = AsyncMock()

            await session_started("sid-123", {"session_id": "sess-1", "user_id": "user-1"})

        # Should NOT have emitted outfits_ready
        outfits_ready_calls = [
            c for c in mock_sio.emit.call_args_list
            if c.args[0] == "outfits_ready"
        ]
        assert len(outfits_ready_calls) == 0

        # Should have emitted tool_result with display_product type
        tool_result_calls = [
            c for c in mock_sio.emit.call_args_list
            if c.args[0] == "tool_result"
        ]
        assert len(tool_result_calls) >= 1
        payload = tool_result_calls[0].args[1]
        assert payload["type"] == "display_product"
        assert payload["outfit_name"] == "Casual Look"
        assert len(payload["items"]) == 2
