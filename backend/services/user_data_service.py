"""User data service for fetching profile, purchases, and preferences."""

import json
from datetime import datetime, timedelta
from typing import Dict, List
from uuid import UUID

from models.database import NeonHTTPClient

# Allowlist of known clothing/fashion brands for filtering scraped email data.
# Only brands in this set will be considered as real clothing purchases.
KNOWN_CLOTHING_BRANDS = {
    # Fast fashion & mall brands
    "zara", "h&m", "uniqlo", "gap", "old navy", "banana republic", "forever 21",
    "shein", "asos", "topshop", "primark", "mango", "pull&bear", "bershka",
    "stradivarius", "massimo dutti",
    # Basics & essentials
    "cos", "muji", "everlane", "uniqlo u",
    # Sportswear
    "nike", "adidas", "puma", "reebok", "under armour", "new balance",
    "asics", "fila", "champion", "jordan",
    # Streetwear
    "supreme", "stussy", "stüssy", "bape", "palace", "kith", "off-white",
    "fear of god", "essentials", "fog essentials",
    # Denim
    "levi's", "levis", "levi", "wrangler", "lee", "ag", "citizens of humanity",
    "frame", "7 for all mankind",
    # Premium / contemporary
    "ralph lauren", "polo ralph lauren", "tommy hilfiger", "calvin klein",
    "hugo boss", "lacoste", "fred perry", "j.crew", "j crew", "brooks brothers",
    "club monaco", "theory", "vince", "ted baker", "reiss",
    # Athletic / outdoor
    "lululemon", "patagonia", "the north face", "north face", "columbia",
    "arc'teryx", "arcteryx", "rei", "carhartt", "carhartt wip",
    # Luxury
    "prada", "gucci", "louis vuitton", "lv", "hermes", "hermès", "fendi",
    "balenciaga", "burberry", "versace", "dior", "saint laurent", "ysl",
    "bottega veneta", "valentino", "givenchy", "celine", "céline", "loewe",
    "alexander mcqueen", "moncler", "stone island", "tom ford", "kenzo",
    "acne studios", "ami paris", "maison margiela",
    # Shoes
    "vans", "converse", "dr. martens", "doc martens", "birkenstock",
    "clarks", "timberland", "ugg", "crocs", "hoka", "on running",
    "allen edmonds", "cole haan",
    # Jewelry / accessories
    "jaxxon", "mejuri", "david yurman", "tiffany", "pandora", "swarovski",
    # Teen / young adult
    "abercrombie", "abercrombie & fitch", "hollister", "american eagle",
    "aerie", "pac sun", "pacsun", "urban outfitters", "free people",
    "anthropologie",
}


def is_clothing_brand(brand: str) -> bool:
    """Check if a brand name is a known clothing/fashion brand."""
    return brand.lower().strip() in KNOWN_CLOTHING_BRANDS


async def get_user_profile_and_purchases(db: NeonHTTPClient, user_id: str) -> Dict:
    """
    Fetch user profile, style preferences, and recent clothing purchases (6 months).

    Returns: {
        "user": {...},
        "style_profile": {...},
        "recent_purchases": [...],  # Only actual clothing purchases
        "top_brands": [...]         # Only known clothing brands
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

    # Fetch ALL recent purchases, then filter in Python by known clothing brands.
    # The DB data comes from Gmail scraping and contains non-clothing items
    # (software receipts, flight confirmations, etc.) that we need to exclude.
    purchases_query = """
        SELECT * FROM purchases
        WHERE user_id = $1 AND date >= $2
        ORDER BY date DESC
    """
    all_purchases = await db.execute(purchases_query, [user_id, six_months_ago])

    # Filter to only clothing brand purchases
    recent_purchases = [
        p for p in all_purchases
        if is_clothing_brand(p.get("brand", ""))
    ]

    # Get top 5 clothing brands by purchase count
    brand_counts: Dict[str, int] = {}
    for p in recent_purchases:
        brand = p.get("brand", "")
        brand_counts[brand] = brand_counts.get(brand, 0) + 1

    top_brands = sorted(brand_counts, key=brand_counts.get, reverse=True)[:5]

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
