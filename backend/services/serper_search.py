"""Serper.dev Shopping API search - CLI prototype for clothing data."""

import argparse
import asyncio
import os
import re
import sys
from typing import Dict, List

import httpx
from dotenv import load_dotenv

SERPER_SHOPPING_URL = "https://google.serper.dev/shopping"


def parse_price(price_str: str):
    """Extract numeric price from string like '$595.00' or '$1,299.99'."""
    match = re.search(r"[\d,]+\.?\d*", price_str.replace(",", ""))
    return float(match.group()) if match else None


def search_clothing(query: str, api_key: str, num_results: int = 10) -> List[Dict]:
    """Search Serper.dev Shopping API and return structured results."""
    response = httpx.post(
        SERPER_SHOPPING_URL,
        headers={
            "X-API-KEY": api_key,
            "Content-Type": "application/json",
        },
        json={"q": query, "num": num_results},
    )
    response.raise_for_status()
    data = response.json()

    results = []
    for item in data.get("shopping", []):
        image_url = item.get("imageUrl") or item.get("thumbnailUrl", "")
        if not image_url:
            continue  # Skip items without images
        results.append({
            "title": item.get("title", ""),
            "source": item.get("source", ""),
            "price": item.get("price", ""),
            "price_numeric": parse_price(item.get("price", "")),
            "image_url": image_url,
            "link": item.get("link", ""),
            "product_id": item.get("productId", ""),
            "rating": item.get("rating"),
            "rating_count": item.get("ratingCount"),
        })

    return results


def build_brand_queries(brands: List[str], gender: str = "mens") -> Dict:
    """
    Construct Serper queries for a variety of clothing types by brand.

    Args:
        brands: List of brand names
        gender: "mens", "womens", or "unisex"

    Returns:
        {"tops": [{"query": "...", "brand": "..."}], "bottoms": [...]}
    """
    # Diverse categories for varied outfit styles
    top_types = ["sweater", "hoodie", "jacket", "long sleeve"]
    bottom_types = ["pants", "jeans"]

    tops_queries = []
    bottoms_queries = []

    for brand in brands:
        for top_type in top_types:
            tops_queries.append({"query": f"{brand} {gender} {top_type}", "brand": brand})
        for bottom_type in bottom_types:
            bottoms_queries.append({"query": f"{brand} {gender} {bottom_type}", "brand": brand})

    return {"tops": tops_queries, "bottoms": bottoms_queries}


async def fetch_clothing_batch(
    queries, api_key: str, num_results_per_query: int = 15
) -> List[Dict]:
    """
    Execute multiple Serper searches in parallel using asyncio.

    Args:
        queries: List of query strings OR list of {"query": str, "brand": str} dicts
        api_key: Serper API key
        num_results_per_query: Number of results per query

    Returns:
        List of deduplicated clothing items (tagged with query_brand if provided)
    """
    # Normalize queries to (query_str, brand) tuples
    normalized = []
    for q in queries:
        if isinstance(q, dict):
            normalized.append((q["query"], q.get("brand")))
        else:
            normalized.append((q, None))

    async with httpx.AsyncClient(timeout=30) as client:
        tasks = []
        for query_str, _ in normalized:
            task = _async_search_clothing(
                client, query_str, api_key, num_results_per_query
            )
            tasks.append(task)

        results = await asyncio.gather(*tasks, return_exceptions=True)

    # Flatten, deduplicate, and tag with brand
    all_items = []
    seen_product_ids = set()

    for (_, brand), result in zip(normalized, results):
        if isinstance(result, Exception):
            continue

        for item in result:
            if item["product_id"] not in seen_product_ids:
                if brand:
                    item["query_brand"] = brand
                all_items.append(item)
                seen_product_ids.add(item["product_id"])

    return all_items


async def _async_search_clothing(
    client: httpx.AsyncClient, query: str, api_key: str, num_results: int = 10
) -> List[Dict]:
    """Async version of search_clothing for parallel execution."""
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

    results = []
    for item in data.get("shopping", []):
        image_url = item.get("imageUrl") or item.get("thumbnailUrl", "")
        if not image_url:
            continue  # Skip items without images
        results.append({
            "title": item.get("title", ""),
            "source": item.get("source", ""),
            "price": item.get("price", ""),
            "price_numeric": parse_price(item.get("price", "")),
            "image_url": image_url,
            "link": item.get("link", ""),
            "product_id": item.get("productId", ""),
            "rating": item.get("rating"),
            "rating_count": item.get("ratingCount"),
        })

    return results


def print_results(results: List[Dict], query: str) -> None:
    """Pretty-print search results to terminal."""
    print(f"\n{'='*70}")
    print(f"  Shopping results for: \"{query}\"")
    print(f"  {len(results)} items found")
    print(f"{'='*70}\n")

    for i, item in enumerate(results, 1):
        rating_str = f"{item['rating']}/5 ({item['rating_count']} reviews)" if item["rating"] else "No rating"
        print(f"  {i}. {item['title']}")
        print(f"     Seller:  {item['source']}")
        print(f"     Price:   {item['price']}")
        print(f"     Rating:  {rating_str}")
        print(f"     Image:   {item['image_url'][:80]}...")
        print(f"     Link:    {item['link'][:80]}...")
        print()


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="Search clothing via Serper.dev Shopping API")
    parser.add_argument("query", help="Search query (e.g., 'mens leather jacket')")
    parser.add_argument("-n", "--num", type=int, default=10, help="Number of results (default: 10)")
    args = parser.parse_args()

    api_key = os.getenv("SERPER_API_KEY")
    if not api_key:
        print("Error: SERPER_API_KEY not set. Add it to .env or export it.", file=sys.stderr)
        sys.exit(1)

    results = search_clothing(args.query, api_key, args.num)
    print_results(results, args.query)


if __name__ == "__main__":
    main()
