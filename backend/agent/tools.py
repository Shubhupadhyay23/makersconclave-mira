"""Tool definitions for Mira agent — Claude tool_use format."""

import asyncio
import os
import re
from collections import defaultdict
from typing import Dict, List

import httpx
from dotenv import load_dotenv

from models.database import NeonHTTPClient
from scraper.gmail_auth import build_gmail_service
from scraper.gmail_fetch import search_emails, get_message_content
from services.serper_cache import serper_cache
from services.serper_search import build_brand_queries, fetch_clothing_batch
from services.user_data_service import is_clothing_brand

load_dotenv()

SERPER_SHOPPING_URL = "https://google.serper.dev/shopping"

# Popular brands used as fallback when user has no brand history
POPULAR_BRANDS = [
    "Nike", "Adidas", "Zara", "H&M", "Uniqlo",
    "Levi's", "Ralph Lauren", "Calvin Klein", "Tommy Hilfiger",
    "Gap", "Banana Republic", "J.Crew", "Abercrombie & Fitch",
    "Patagonia", "The North Face", "Lululemon", "New Balance",
    "Puma", "Mango", "COS", "Everlane", "Carhartt",
    "Champion", "Stussy", "Supreme", "Off-White",
    "Balenciaga", "Gucci", "Burberry", "Lacoste",
    "Hugo Boss", "Ted Baker", "AllSaints", "Theory",
    "Arc'teryx", "Columbia", "Under Armour", "Reebok",
    "Converse", "Vans", "ASOS", "Topman",
    "Massimo Dutti", "Brooks Brothers", "Bonobos", "Nordstrom",
    "Scotch & Soda", "G-Star Raw", "Diesel", "Kith",
]

# Claude tool definitions for event-driven mirror sessions
TOOL_DEFINITIONS = [
    {
        "name": "search_clothing",
        "description": (
            "Search for clothing items using Google Shopping. Returns results to YOU only — "
            "the user does NOT see these results. Use this to gather options, then call "
            "present_items with your curated picks (1-5 items). Write detailed queries "
            "including gender, style keywords, and price ceiling when relevant, e.g. "
            "'mens black minimalist sneakers under $150' or 'women oversized linen blazer summer'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Detailed shopping search query with gender, style, and price hints",
                },
                "num_results": {
                    "type": "integer",
                    "description": "Number of results to return (default 12, max 20)",
                    "default": 12,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_gmail",
        "description": (
            "Search the user's Gmail for specific information. Use this when the user mentions "
            "a specific purchase, brand, or item and you want to look up details. Returns email "
            "subjects and snippets matching the query. Do NOT use this for general profile building "
            "— that data is already in your context."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Gmail search query, e.g. 'from:zara order confirmation' or 'subject:Nike receipt'",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Max emails to return (default 5)",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_purchases",
        "description": (
            "Search the user's full purchase history stored in the database. Use this to look up "
            "specific purchases by brand, category, price range, or date range. This searches ALL "
            "purchases ever scraped — not just the ones in your context. Use when the user asks "
            "about past purchases, a specific brand, or when you want to reference items from "
            "their historical purchases."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Free-text search against brand and item name, e.g. 'leather jacket' or 'running shoes'",
                },
                "brand": {
                    "type": "string",
                    "description": "Exact brand filter, e.g. 'Nike' or 'Zara'",
                },
                "category": {
                    "type": "string",
                    "description": "Exact category filter, e.g. 'shoes' or 'tops'",
                },
                "min_price": {
                    "type": "number",
                    "description": "Minimum price filter",
                },
                "max_price": {
                    "type": "number",
                    "description": "Maximum price filter",
                },
                "date_from": {
                    "type": "string",
                    "description": "Start date filter (YYYY-MM-DD format)",
                },
                "date_to": {
                    "type": "string",
                    "description": "End date filter (YYYY-MM-DD format)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default 20, max 50)",
                    "default": 20,
                },
                "fashion_only": {
                    "type": "boolean",
                    "description": "If true, only return fashion items. Default: false (return all).",
                },
            },
            "required": [],
        },
    },
    {
        "name": "search_calendar",
        "description": (
            "Search the user's calendar events by keyword, date range, or location. Use this "
            "to find upcoming or recent events to tie outfit recommendations to. Events include "
            "title, time, location, and attendee count. Cancelled events are excluded."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Free-text search against event title and location, e.g. 'dinner' or 'conference'",
                },
                "date_from": {
                    "type": "string",
                    "description": "Start date filter (YYYY-MM-DD format)",
                },
                "date_to": {
                    "type": "string",
                    "description": "End date filter (YYYY-MM-DD format)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default 20, max 50)",
                    "default": 20,
                },
            },
            "required": [],
        },
    },
    {
        "name": "present_items",
        "description": (
            "Present curated clothing picks to the user's mirror display. This is the ONLY "
            "way to show items to the user — search_clothing results are invisible to them. "
            "Call this AFTER search_clothing with your top 1-5 picks. The user sees product "
            "cards (image + price + brand); YOUR voice is the narration, so don't repeat "
            "what's on the card."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Curated items to display (1-5). Each must include fields from search_clothing results.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_id": {"type": "string", "description": "Product ID from search results"},
                            "title": {"type": "string", "description": "Product title"},
                            "price": {"type": "string", "description": "Price string e.g. '$59.99'"},
                            "image_url": {"type": "string", "description": "Product image URL"},
                            "link": {"type": "string", "description": "Product buy link"},
                            "source": {"type": "string", "description": "Retailer name"},
                        },
                        "required": ["title", "price", "image_url", "link", "source"],
                    },
                    "minItems": 1,
                    "maxItems": 5,
                },
            },
            "required": ["items"],
        },
    },
    {
        "name": "display_product",
        "description": (
            "Display recommended clothing items on the mirror. Generates flat lay product "
            "photos and sends them to the display. Call this after selecting outfit items to "
            "show the user. This is the preferred way to present items — it processes images "
            "into clean flat lay format before displaying."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Items to display on the mirror (up to 10).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "price": {"type": "string"},
                            "image_url": {"type": "string"},
                            "link": {"type": "string"},
                            "source": {"type": "string"},
                            "product_id": {"type": "string"},
                            "type": {
                                "type": "string",
                                "enum": ["top", "bottom", "shoes", "accessory"],
                            },
                        },
                        "required": ["title", "image_url", "product_id"],
                    },
                    "maxItems": 10,
                },
                "outfit_name": {
                    "type": "string",
                    "description": "Name for this outfit combination",
                },
            },
            "required": ["items"],
        },
    },
    {
        "name": "send_voice_to_client",
        "description": (
            "Send a voice message to the user. Use this to explain outfit choices, give "
            "style advice, or comment on the user's look. The text will be spoken aloud "
            "by Mira's avatar."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The message to speak to the user",
                },
                "emotion": {
                    "type": "string",
                    "enum": ["neutral", "excited", "thoughtful", "playful"],
                    "description": "Tone of voice",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "give_recommendation",
        "description": (
            "Search for clothing items from specific brands to build outfit recommendations. "
            "Call this tool when you're ready to find tops and bottoms to recommend. "
            "Returns a categorized list of available clothing items (tops and bottoms) from the "
            "requested brands, with brand diversity ensured. After getting results, use "
            "present_items to show your curated picks to the user."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "brands": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "List of 3-7 clothing brand names to search for. "
                        "Mix the user's favorite brands with popular brands for variety."
                    ),
                },
                "gender": {
                    "type": "string",
                    "enum": ["mens", "womens", "unisex"],
                    "description": "Gender category for clothing search.",
                },
                "style_notes": {
                    "type": "string",
                    "description": (
                        "Brief notes about the user's style to guide search "
                        "(e.g. 'casual streetwear', 'business casual', 'athleisure')."
                    ),
                },
            },
            "required": ["brands", "gender"],
        },
    },
]

# Standalone reference to the give_recommendation tool schema
GIVE_RECOMMENDATION_TOOL = {
    "name": "give_recommendation",
    "description": (
        "Search for clothing items from specific brands to build outfit recommendations. "
        "Call this tool when you're ready to find tops and bottoms to recommend. "
        "Returns a list of available clothing items (tops and bottoms) from the requested brands."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "brands": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "List of 3-7 clothing brand names to search for. "
                    "Mix the user's favorite brands with popular brands for variety."
                ),
            },
            "gender": {
                "type": "string",
                "enum": ["mens", "womens", "unisex"],
                "description": "Gender category for clothing search.",
            },
            "style_notes": {
                "type": "string",
                "description": (
                    "Brief notes about the user's style to guide search "
                    "(e.g. 'casual streetwear', 'business casual', 'athleisure')."
                ),
            },
        },
        "required": ["brands", "gender"],
    },
}


def _parse_price(price_str: str) -> float | None:
    """Extract numeric price from string like '$595.00'."""
    match = re.search(r"[\d,]+\.?\d*", price_str.replace(",", ""))
    return float(match.group()) if match else None


def _extract_brand(item: dict) -> str:
    """Extract the actual clothing brand from item title or query_brand tag."""
    if item.get("query_brand"):
        return item["query_brand"]
    title = item.get("title", "").lower()
    for brand in POPULAR_BRANDS:
        if brand.lower() in title:
            return brand
    return item.get("source", "Unknown")


def _select_diverse_items(items: list, limit: int) -> list:
    """Select items balanced across actual clothing brands using round-robin."""
    by_brand = defaultdict(list)
    for item in items:
        by_brand[_extract_brand(item)].append(item)

    selected = []
    brand_lists = list(by_brand.values())
    idx = 0
    while len(selected) < limit and brand_lists:
        brand_items = brand_lists[idx % len(brand_lists)]
        if brand_items:
            selected.append(brand_items.pop(0))
        else:
            brand_lists.pop(idx % len(brand_lists))
            if not brand_lists:
                break
            continue
        idx += 1

    return selected


# --- Event-driven mirror session tool execution ---


async def execute_tool(tool_name: str, tool_input: dict, user_context: dict) -> dict:
    """Execute a tool call and return the result.

    Args:
        tool_name: Name of the tool to execute.
        tool_input: Input parameters from Claude.
        user_context: Dict with user-specific data (oauth_token, user_id, etc.)

    Returns:
        Dict with tool results and optional frontend_payload for parallel broadcast.
    """
    if tool_name == "search_clothing":
        return await _search_clothing(tool_input)
    elif tool_name == "present_items":
        return await _present_items(tool_input)
    elif tool_name == "search_gmail":
        return await _search_gmail(tool_input, user_context)
    elif tool_name == "search_purchases":
        return await _search_purchases(tool_input, user_context)
    elif tool_name == "search_calendar":
        return await _search_calendar(tool_input, user_context)
    elif tool_name == "display_product":
        return await _display_product(tool_input)
    elif tool_name == "send_voice_to_client":
        return await _send_voice_to_client(tool_input)
    elif tool_name == "give_recommendation":
        # Use session_id from user_context for caching; fall back to user_id
        session_id = user_context.get("session_id", user_context.get("user_id", "default"))
        result_text = await execute_give_recommendation(tool_input, session_id)
        return {"results": result_text}
    else:
        return {"error": f"Unknown tool: {tool_name}"}


async def _search_clothing(tool_input: dict) -> dict:
    """Search Serper.dev Shopping API."""
    api_key = os.getenv("SERPER_API_KEY")
    if not api_key:
        print("[mira-tools] search_clothing: SERPER_API_KEY not configured")
        return {"error": "SERPER_API_KEY not configured", "results": []}

    query = tool_input["query"]
    num_results = min(tool_input.get("num_results", 12), 20)
    print(f'[mira-tools] search_clothing: query="{query}" num_results={num_results}')

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                SERPER_SHOPPING_URL,
                headers={
                    "X-API-KEY": api_key,
                    "Content-Type": "application/json",
                },
                json={"q": query, "num": num_results},
            )
            response.raise_for_status()
            data = response.json()
    except Exception as e:
        print(f"[mira-tools] search_clothing: failed — {e}")
        return {"error": f"Shopping search failed: {str(e)}", "results": []}

    results = []
    for item in data.get("shopping", []):
        results.append({
            "title": item["title"],
            "source": item["source"],
            "price": item["price"],
            "price_numeric": _parse_price(item["price"]),
            "image_url": item["imageUrl"],
            "link": item["link"],
            "product_id": item["productId"],
            "rating": item.get("rating"),
            "rating_count": item.get("ratingCount"),
        })

    print(f"[mira-tools] search_clothing: → {len(results)} results")
    return {"results": results}


async def _present_items(tool_input: dict) -> dict:
    """Present curated items to the mirror display via Socket.io broadcast."""
    items = tool_input.get("items", [])
    if not items:
        print("[mira-tools] present_items: no items provided")
        return {"error": "No items provided", "presented": 0}

    # Cap at 5 items
    items = items[:5]
    print(f"[mira-tools] present_items: sending {len(items)} curated items to frontend")

    return {
        "presented": len(items),
        "items": items,
        # frontend_payload triggers Socket.io broadcast in orchestrator
        "frontend_payload": {
            "type": "clothing_results",
            "items": items,
        },
    }


async def _display_product(tool_input: dict) -> dict:
    """Display items on the mirror with flat lay images generated by Gemini."""
    items = tool_input.get("items", [])
    if not items:
        print("[mira-tools] display_product: no items provided")
        return {"error": "No items provided", "displayed": 0}

    items = items[:10]
    outfit_name = tool_input.get("outfit_name", "")
    print(f"[mira-tools] display_product: processing {len(items)} items (outfit: {outfit_name!r})")

    # Generate flat lay images via Gemini
    flat_lay_map: dict = {}
    try:
        from services.gemini_flatlay import generate_flat_lays_batch

        flatlay_input = [
            {"image_url": i["image_url"], "title": i["title"], "product_id": i["product_id"]}
            for i in items
            if i.get("image_url") and i.get("product_id")
        ]
        if flatlay_input:
            flat_lay_map = await generate_flat_lays_batch(flatlay_input)
            print(f"[mira-tools] display_product: generated {len(flat_lay_map)} flat lays")
    except ImportError:
        print("[mira-tools] display_product: gemini_flatlay not available, using originals")
    except Exception as e:
        print(f"[mira-tools] display_product: flat lay generation failed (non-fatal): {e}")

    # Map flat lay data URLs onto items
    for item in items:
        pid = item.get("product_id", "")
        if pid in flat_lay_map:
            item["cleaned_image_url"] = flat_lay_map[pid]
            item["flat_image_url"] = flat_lay_map[pid]

    return {
        "displayed": len(items),
        "items": items,
        "frontend_payload": {
            "type": "display_product",
            "items": items,
            "outfit_name": outfit_name,
        },
    }


async def _send_voice_to_client(tool_input: dict) -> dict:
    """Send a voice message to the frontend for TTS playback."""
    text = tool_input.get("text", "")
    emotion = tool_input.get("emotion", "neutral")

    if not text:
        return {"error": "No text provided"}

    print(f"[mira-tools] send_voice_to_client: {len(text)} chars, emotion={emotion}")

    return {
        "sent": True,
        "text": text,
        "emotion": emotion,
        "frontend_payload": {
            "type": "voice_message",
            "text": text,
            "emotion": emotion,
        },
    }


async def _search_gmail(tool_input: dict, user_context: dict) -> dict:
    """Search user's Gmail."""
    token_data = user_context.get("oauth_token")
    if not token_data:
        print("[mira-tools] search_gmail: no OAuth token available")
        return {"error": "No OAuth token available for this user", "results": []}

    query = tool_input["query"]
    max_results = min(tool_input.get("max_results", 5), 10)
    print(f'[mira-tools] search_gmail: query="{query}" max_results={max_results}')

    try:
        service = build_gmail_service(token_data)
        message_ids = search_emails(service, query=query, max_results=max_results)

        emails = []
        for msg_id in message_ids:
            content = get_message_content(service, msg_id)
            emails.append({
                "subject": content["subject"],
                "sender": content["sender"],
                "date": content["date"],
                "snippet": content["body"][:300] if content["body"] else "",
            })

        print(f"[mira-tools] search_gmail: → {len(emails)} emails found")
        return {"results": emails}
    except Exception as e:
        print(f"[mira-tools] search_gmail: failed — {e}")
        return {"error": f"Gmail search failed: {str(e)}", "results": []}


async def _search_purchases(tool_input: dict, user_context: dict) -> dict:
    """Search the user's full purchase history in the database."""
    user_id = user_context.get("user_id")
    if not user_id:
        print("[mira-tools] search_purchases: no user_id available")
        return {"error": "No user_id available", "results": []}

    # Log the filters being used
    filters = {k: v for k, v in tool_input.items() if k != "limit" and v is not None}
    print(f"[mira-tools] search_purchases: filters={filters}")

    # Build dynamic WHERE clause with parameterized inputs
    conditions = ["user_id = $1"]
    params: list = [user_id]
    param_idx = 2

    query_text = tool_input.get("query")
    if query_text:
        conditions.append(f"(brand ILIKE ${param_idx} OR item_name ILIKE ${param_idx})")
        params.append(f"%{query_text}%")
        param_idx += 1

    brand = tool_input.get("brand")
    if brand:
        conditions.append(f"LOWER(brand) = LOWER(${param_idx})")
        params.append(brand)
        param_idx += 1

    category = tool_input.get("category")
    if category:
        conditions.append(f"LOWER(category) = LOWER(${param_idx})")
        params.append(category)
        param_idx += 1

    min_price = tool_input.get("min_price")
    if min_price is not None:
        conditions.append(f"price >= ${param_idx}")
        params.append(min_price)
        param_idx += 1

    max_price = tool_input.get("max_price")
    if max_price is not None:
        conditions.append(f"price <= ${param_idx}")
        params.append(max_price)
        param_idx += 1

    date_from = tool_input.get("date_from")
    if date_from:
        conditions.append(f"date >= ${param_idx}::date")
        params.append(date_from)
        param_idx += 1

    date_to = tool_input.get("date_to")
    if date_to:
        conditions.append(f"date <= ${param_idx}::date")
        params.append(date_to)
        param_idx += 1

    if tool_input.get("fashion_only") is True:
        conditions.append("is_fashion = true")

    limit = min(tool_input.get("limit", 20), 50)
    where_clause = " AND ".join(conditions)

    try:
        db = NeonHTTPClient()
        try:
            # Get matching purchases
            rows = await db.execute(
                f"SELECT brand, item_name, category, price, date, is_fashion "
                f"FROM purchases WHERE {where_clause} "
                f"ORDER BY date DESC LIMIT {limit}",
                params,
            )

            # Get total matching count (for pagination context)
            count_rows = await db.execute(
                f"SELECT COUNT(*) as total FROM purchases WHERE {where_clause}",
                params,
            )
        finally:
            await db.close()

        results = [
            {
                "brand": r.get("brand", ""),
                "item_name": r.get("item_name", ""),
                "category": r.get("category"),
                "price": float(r["price"]) if r.get("price") else None,
                "date": str(r["date"]) if r.get("date") else None,
                "is_fashion": r.get("is_fashion", True),
            }
            for r in rows
        ]

        total_matching = int(count_rows[0]["total"]) if count_rows else len(results)

        print(f"[mira-tools] search_purchases: → {len(results)} results (total matching: {total_matching})")
        return {
            "results": results,
            "total_matching": total_matching,
            "showing": len(results),
        }
    except Exception as e:
        print(f"[mira-tools] search_purchases: failed — {e}")
        return {"error": f"Purchase search failed: {str(e)}", "results": []}


async def _search_calendar(tool_input: dict, user_context: dict) -> dict:
    """Search the user's calendar events in the database."""
    user_id = user_context.get("user_id")
    if not user_id:
        print("[mira-tools] search_calendar: no user_id available")
        return {"error": "No user_id available", "results": []}

    filters = {k: v for k, v in tool_input.items() if k != "limit" and v is not None}
    print(f"[mira-tools] search_calendar: filters={filters}")

    # Build dynamic WHERE clause with parameterized inputs
    conditions = ["user_id = $1", "(status IS NULL OR status != 'cancelled')"]
    params: list = [user_id]
    param_idx = 2

    query_text = tool_input.get("query")
    if query_text:
        conditions.append(
            f"(title ILIKE ${param_idx} OR location ILIKE ${param_idx})"
        )
        params.append(f"%{query_text}%")
        param_idx += 1

    date_from = tool_input.get("date_from")
    if date_from:
        conditions.append(f"start_time >= ${param_idx}::timestamptz")
        params.append(date_from)
        param_idx += 1

    date_to = tool_input.get("date_to")
    if date_to:
        conditions.append(f"start_time <= ${param_idx}::timestamptz")
        params.append(date_to)
        param_idx += 1

    limit = min(tool_input.get("limit", 20), 50)
    where_clause = " AND ".join(conditions)

    try:
        db = NeonHTTPClient()
        try:
            rows = await db.execute(
                f"SELECT title, start_time, end_time, location, description, "
                f"attendee_count, is_all_day, status "
                f"FROM calendar_events WHERE {where_clause} "
                f"ORDER BY start_time ASC LIMIT {limit}",
                params,
            )

            count_rows = await db.execute(
                f"SELECT COUNT(*) as total FROM calendar_events WHERE {where_clause}",
                params,
            )
        finally:
            await db.close()

        results = [
            {
                "title": r.get("title", ""),
                "start_time": str(r["start_time"]) if r.get("start_time") else None,
                "end_time": str(r["end_time"]) if r.get("end_time") else None,
                "location": r.get("location"),
                "description": r.get("description"),
                "attendee_count": int(r.get("attendee_count", 0)),
                "is_all_day": r.get("is_all_day", False),
            }
            for r in rows
        ]

        total_matching = int(count_rows[0]["total"]) if count_rows else len(results)

        print(f"[mira-tools] search_calendar: → {len(results)} results (total matching: {total_matching})")
        return {
            "results": results,
            "total_matching": total_matching,
            "showing": len(results),
        }
    except Exception as e:
        print(f"[mira-tools] search_calendar: failed — {e}")
        return {"error": f"Calendar search failed: {str(e)}", "results": []}


# --- Recommendation pipeline tool execution ---


async def execute_give_recommendation(
    tool_input: Dict, session_id: str
) -> str:
    """
    Execute the give_recommendation tool.

    Searches Serper for clothing items from the specified brands,
    tags them as tops/bottoms, caches results, and returns formatted list.
    """
    brands = tool_input.get("brands", [])
    gender = tool_input.get("gender", "mens")

    # Filter to known clothing brands + fill with popular brands
    valid_brands = [b for b in brands if is_clothing_brand(b)]
    if not valid_brands:
        valid_brands = brands[:3]  # Use whatever Claude provided

    # Fill remaining slots with popular brands
    seen = {b.lower() for b in valid_brands}
    for b in POPULAR_BRANDS:
        if len(valid_brands) >= 7:
            break
        if b.lower() not in seen:
            valid_brands.append(b)
            seen.add(b.lower())

    # Check cache first
    cached = serper_cache.get(session_id)
    if cached:
        return _format_clothing_for_claude(cached)

    # Build and execute queries
    brand_queries = build_brand_queries(valid_brands[:5], gender)

    serper_api_key = os.getenv("SERPER_API_KEY")
    if not serper_api_key:
        return "Error: Serper API key not configured. Cannot search for clothing."

    # Fetch tops and bottoms in parallel
    tops_items, bottoms_items = await asyncio.gather(
        fetch_clothing_batch(
            brand_queries["tops"], serper_api_key, num_results_per_query=3
        ),
        fetch_clothing_batch(
            brand_queries["bottoms"], serper_api_key, num_results_per_query=3
        ),
    )

    # Tag items with category
    for item in tops_items:
        item["clothing_category"] = "top"
    for item in bottoms_items:
        item["clothing_category"] = "bottom"

    all_items = tops_items + bottoms_items

    # Cache results for session
    serper_cache.set(session_id, all_items)

    if not all_items:
        return "No clothing items found. Try different brands or check back later."

    # Select diverse subset
    limited_tops = _select_diverse_items(
        [i for i in all_items if i.get("clothing_category") == "top"], 25
    )
    limited_bottoms = _select_diverse_items(
        [i for i in all_items if i.get("clothing_category") == "bottom"], 25
    )

    return _format_clothing_for_claude(limited_tops + limited_bottoms)


def _format_clothing_for_claude(items: List[Dict]) -> str:
    """Format clothing items into a readable string for Claude."""
    tops = [i for i in items if i.get("clothing_category") == "top"]
    bottoms = [i for i in items if i.get("clothing_category") == "bottom"]

    def _format_section(section_items: List[Dict]) -> str:
        text = ""
        for item in section_items:
            text += (
                f"- **{item['title']}**\n"
                f"  - Brand/Seller: {item['source']}\n"
                f"  - Price: {item['price']}\n"
                f"  - Rating: {item.get('rating', 'N/A')}\n"
                f"  - Link: {item['link']}\n"
                f"  - Image: {item['image_url']}\n"
                f"  - Product ID: {item['product_id']}\n"
            )
        return text

    result = f"Found {len(items)} clothing items:\n\n"
    result += "IMPORTANT: Pick tops ONLY from the TOPS section and bottoms ONLY from the BOTTOMS section.\n\n"

    if tops:
        result += f"### TOPS ({len(tops)} items) — use these for the \"top\" slot:\n"
        result += _format_section(tops)

    if bottoms:
        result += f"\n### BOTTOMS ({len(bottoms)} items) — use these for the \"bottom\" slot:\n"
        result += _format_section(bottoms)

    return result
