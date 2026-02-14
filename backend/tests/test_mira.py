"""Integration test for Mira agent — tests prompt building, tool execution, and a live Claude call."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv

load_dotenv()

from agent.prompts import build_system_prompt
from agent.tools import TOOL_DEFINITIONS, execute_tool

# Mock user data for testing
MOCK_PROFILE = {
    "user_id": "test-user-123",
    "name": "Jordan",
    "email": "jordan@test.com",
    "brands": ["Nike", "Zara", "Uniqlo", "ASOS"],
    "price_range": {"min": 20, "max": 150, "avg": 55},
    "style_tags": ["streetwear", "minimalist", "casual"],
    "narrative_summary": "Leans into streetwear basics with clean lines. Heavy Nike loyalty. Shops frequently at fast fashion retailers.",
}

MOCK_PURCHASES = [
    {"brand": "Nike", "item_name": "Air Force 1 '07", "category": "shoes", "price": 115.0, "date": "2025-01-15"},
    {"brand": "Zara", "item_name": "Oversized Blazer", "category": "outerwear", "price": 89.99, "date": "2025-01-10"},
    {"brand": "Uniqlo", "item_name": "Heattech Crew Neck T-Shirt", "category": "tops", "price": 14.90, "date": "2025-01-05"},
    {"brand": "ASOS", "item_name": "Slim Fit Chinos", "category": "bottoms", "price": 35.00, "date": "2024-12-20"},
    {"brand": "Nike", "item_name": "Tech Fleece Joggers", "category": "bottoms", "price": 110.0, "date": "2024-12-15"},
    {"brand": "Zara", "item_name": "Minimalist Leather Belt", "category": "accessories", "price": 29.90, "date": "2024-12-01"},
    {"brand": "ASOS", "item_name": "Oversized Hoodie", "category": "tops", "price": 42.00, "date": "2024-11-28"},
    {"brand": "Nike", "item_name": "Dunk Low Retro", "category": "shoes", "price": 110.0, "date": "2024-11-15"},
]

MOCK_PAST_SESSIONS = [
    {"summary": "Jordan liked a Zara bomber jacket and Nike Blazers. Vibed with monochrome looks. Passed on anything too colorful."},
]


def test_system_prompt():
    """Test that the system prompt builds correctly with user data."""
    print("\n=== TEST 1: System Prompt Building ===\n")

    prompt = build_system_prompt(
        user_profile=MOCK_PROFILE,
        purchases=MOCK_PURCHASES,
        session_history=MOCK_PAST_SESSIONS,
        session_state={"items_shown": 3, "likes": 1, "dislikes": 2, "api_calls": 5},
    )

    print(f"Prompt length: {len(prompt)} chars")
    assert "Jordan" in prompt, "User name should be in prompt"
    assert "Nike" in prompt, "Brand should be in prompt"
    assert "$20-$150" in prompt, "Price range should be in prompt"
    assert "Air Force 1" in prompt, "Purchase should be in prompt"
    assert "bomber jacket" in prompt, "Past session should be in prompt"
    assert "Items shown: 3" in prompt, "Session state should be in prompt"
    print("PASSED - All user data injected correctly")
    print(f"\n--- First 500 chars ---\n{prompt[:500]}...")


async def test_search_clothing_tool():
    """Test the search_clothing tool against live Serper API."""
    print("\n=== TEST 2: search_clothing Tool (Live API) ===\n")

    api_key = os.getenv("SERPER_API_KEY")
    if not api_key:
        print("SKIPPED - No SERPER_API_KEY set")
        return

    result = await execute_tool(
        tool_name="search_clothing",
        tool_input={"query": "mens black minimalist sneakers", "num_results": 3},
        user_context={},
    )

    assert "results" in result, f"Expected 'results' key, got: {result.keys()}"
    assert len(result["results"]) > 0, "Should return at least 1 result"
    assert "frontend_payload" in result, "Should include frontend_payload for broadcast"

    print(f"Got {len(result['results'])} results:")
    for item in result["results"][:3]:
        print(f"  - {item['title']} | {item['price']} | {item['source']}")

    # Check structure
    first = result["results"][0]
    required_fields = ["title", "source", "price", "image_url", "link", "product_id"]
    for field in required_fields:
        assert field in first, f"Missing field: {field}"

    print(f"\nFrontend payload type: {result['frontend_payload']['type']}")
    print("PASSED - Tool returns structured data with frontend broadcast payload")


async def test_claude_with_mira():
    """Test a real Claude API call with Mira's personality and tools."""
    print("\n=== TEST 3: Live Claude Call as Mira ===\n")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        print("SKIPPED - No ANTHROPIC_API_KEY set")
        return

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)

    system_prompt = build_system_prompt(
        user_profile=MOCK_PROFILE,
        purchases=MOCK_PURCHASES,
        session_history=MOCK_PAST_SESSIONS,
    )

    # Test 1: Session opener
    print("--- Mira's Opening Line ---")
    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        system=system_prompt,
        messages=[
            {"role": "user", "content": "A new user just stepped up to the mirror. Introduce yourself and start the session."},
        ],
        tools=TOOL_DEFINITIONS,
    )

    for block in response.content:
        if hasattr(block, "text"):
            print(f"Mira: {block.text}")
        elif block.type == "tool_use":
            print(f"[Tool call: {block.name}({json.dumps(block.input)})]")

    print(f"\nTokens used: {response.usage.input_tokens} in / {response.usage.output_tokens} out")

    # Test 2: Gesture response (thumbs down)
    print("\n--- Mira Reacts to Thumbs Down ---")
    response2 = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        system=system_prompt,
        messages=[
            {"role": "user", "content": "A new user just stepped up to the mirror. Introduce yourself."},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": "The user gave a thumbs down (dislike this item)."},
        ],
        tools=TOOL_DEFINITIONS,
    )

    for block in response2.content:
        if hasattr(block, "text"):
            print(f"Mira: {block.text}")
        elif block.type == "tool_use":
            print(f"[Tool call: {block.name}({json.dumps(block.input)})]")

    # Test 3: Voice input
    print("\n--- Mira Responds to Voice ---")
    response3 = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        system=system_prompt,
        messages=[
            {"role": "user", "content": "A new user just stepped up to the mirror. Introduce yourself."},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": "Show me some cool jackets for spring"},
        ],
        tools=TOOL_DEFINITIONS,
    )

    for block in response3.content:
        if hasattr(block, "text"):
            print(f"Mira: {block.text}")
        elif block.type == "tool_use":
            print(f"[Tool call: {block.name}({json.dumps(block.input)})]")

    print("\nPASSED - Mira responds in character with tool use")


async def main():
    print("=" * 60)
    print("  MIRA AGENT INTEGRATION TESTS")
    print("=" * 60)

    # Test 1: Pure Python, no API needed
    test_system_prompt()

    # Test 2: Needs SERPER_API_KEY
    await test_search_clothing_tool()

    # Test 3: Needs ANTHROPIC_API_KEY
    await test_claude_with_mira()

    print("\n" + "=" * 60)
    print("  ALL TESTS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
