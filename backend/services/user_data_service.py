"""User data service for fetching profile, purchases, and preferences."""

import json
from datetime import datetime, timedelta
from typing import Dict, List
from uuid import UUID

from models.database import NeonHTTPClient


async def get_user_profile_and_purchases(db: NeonHTTPClient, user_id: str) -> Dict:
    """
    Fetch user profile, style preferences, and recent purchases (3-6 months).

    Returns: {
        "user": {...},
        "style_profile": {...},
        "recent_purchases": [...],
        "top_brands": [...]
    }
    """
    six_months_ago = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")

    # Fetch user info
    user_query = "SELECT * FROM users WHERE id = $1"
    user_rows = await db.execute(user_query, [user_id])
    if not user_rows:
        return None

    user = user_rows[0]

    # Fetch style profile
    style_query = "SELECT * FROM style_profiles WHERE user_id = $1"
    style_rows = await db.execute(style_query, [user_id])
    style_profile = style_rows[0] if style_rows else None

    # Fetch recent purchases (last 6 months)
    purchases_query = """
        SELECT * FROM purchases
        WHERE user_id = $1 AND date >= $2
        ORDER BY date DESC
    """
    recent_purchases = await db.execute(purchases_query, [user_id, six_months_ago])

    # Get top 5 clothing brands by purchase count (filter out non-clothing purchases)
    brands_query = """
        SELECT brand, COUNT(*) as count
        FROM purchases
        WHERE user_id = $1 AND date >= $2
          AND (
            item_name ~* '(shirt|pants|jacket|dress|shoe|sneaker|hoodie|sweater|jeans|tee|polo|shorts|coat|vest|blouse|skirt|boot|sandal|hat|cap|belt|sock|legging|jogger|blazer|suit|scarf|glove|beanie|top|bottom|wear|cloth|apparel|denim|chino|cardigan|pullover|parka|tracksuit|air.?max|air.?force|air.?jordan|dunk|yeezy|new.?balance|converse|vans|chuck)'
            OR category IN ('shoes', 'top', 'bottom', 'outerwear', 'accessories', 'clothing')
          )
        GROUP BY brand
        ORDER BY count DESC
        LIMIT 5
    """
    brand_rows = await db.execute(brands_query, [user_id, six_months_ago])
    top_brands = [row["brand"] for row in brand_rows]

    return {
        "user": user,
        "style_profile": style_profile,
        "recent_purchases": recent_purchases,
        "top_brands": top_brands,
    }


async def save_outfits_to_database(
    db: NeonHTTPClient, session_id: str, outfits: List[Dict]
) -> Dict[str, str]:
    """
    Save outfit recommendations to database and return ID mappings.

    For each outfit:
    1. Insert clothing items into clothing_items table (if not exists)
    2. Collect item UUIDs
    3. Insert into session_outfits with outfit_data JSON and item UUIDs

    Returns: dict mapping outfit_name → outfit UUID
    """
    outfit_ids: Dict[str, str] = {}
    for outfit in outfits:
        item_uuids = []

        # Insert clothing items and collect UUIDs
        for item_data in outfit.get("items", []):
            # Handle both nested {"item": {...}} and flat item structure
            item = item_data.get("item") if isinstance(item_data.get("item"), dict) else item_data

            name = item.get("title") or item.get("name")
            if not name:
                continue  # Skip items without a name

            link = item.get("link") or item.get("buy_url")
            price = item.get("price_numeric") or item.get("price")
            # Parse string prices like "$49.99"
            if isinstance(price, str):
                price = float(price.replace("$", "").replace(",", "").strip() or "0")

            # Check if item already exists by link
            if link:
                check_query = """
                    SELECT id FROM clothing_items WHERE buy_url = $1
                """
                existing = await db.execute(check_query, [link])
            else:
                existing = []

            if existing:
                item_uuids.append(str(existing[0]["id"]))
            else:
                # Insert new clothing item
                insert_item_query = """
                    INSERT INTO clothing_items (name, brand, price, image_url, buy_url, category, source)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id
                """
                result = await db.execute(
                    insert_item_query,
                    [
                        name,
                        item.get("source") or item.get("brand"),
                        price,
                        item.get("image_url"),
                        link,
                        item_data.get("type") or item.get("category"),
                        "serper",
                    ],
                )
                item_uuids.append(str(result[0]["id"]))

        # Insert outfit record
        insert_outfit_query = """
            INSERT INTO session_outfits (session_id, outfit_data, clothing_items)
            VALUES ($1, $2::jsonb, $3::uuid[])
            RETURNING id
        """
        result = await db.execute(
            insert_outfit_query,
            [session_id, json.dumps(outfit), item_uuids],
        )
        outfit_name = outfit.get("outfit_name", "")
        if result:
            outfit_ids[outfit_name] = str(result[0]["id"])

    return outfit_ids


async def is_new_user(db: NeonHTTPClient, user_id: str) -> bool:
    """Check if user needs onboarding (no purchases and no style profile)."""
    # Check for purchases
    purchases_query = "SELECT COUNT(*) as count FROM purchases WHERE user_id = $1"
    purchase_count = await db.fetchval(purchases_query, [user_id])

    # Check for style profile
    profile_query = "SELECT COUNT(*) as count FROM style_profiles WHERE user_id = $1"
    profile_count = await db.fetchval(profile_query, [user_id])

    return int(purchase_count) == 0 and int(profile_count) == 0


async def save_onboarding_data(
    db: NeonHTTPClient, user_id: str, questionnaire: dict
):
    """Save onboarding questionnaire to style_profiles table."""
    query = """
        INSERT INTO style_profiles (user_id, brands, price_range, style_tags, size_info)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id)
        DO UPDATE SET
            brands = EXCLUDED.brands,
            price_range = EXCLUDED.price_range,
            style_tags = EXCLUDED.style_tags,
            size_info = EXCLUDED.size_info
    """
    await db.execute(
        query,
        [
            user_id,
            questionnaire.get("favorite_brands", []),
            questionnaire.get("price_range", {}),
            questionnaire.get("style_preferences", []),
            questionnaire.get("size_info", {}),
        ],
    )
