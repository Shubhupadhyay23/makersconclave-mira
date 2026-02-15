"""Gemini flat lay image generation service.

Uses Google Gemini REST API to generate clean flat lay product photos
from scraped Serper shopping images.
"""

import asyncio
import base64
import os
from typing import Dict, List, Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

# Concurrency limit to avoid rate limiting
MAX_CONCURRENT = 5

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent"

FLAT_LAY_PROMPT = (
    "Transform this into a minimalist flat lay photo. "
    "Top-down view, soft natural light, plain white background. "
    "Remove any model, mannequin, hanger, or background. "
    "Lay the clothing item completely flat and neatly spread out as if placed on a clean surface. "
    "Show the full garment — no cropping. Keep colors, fabric texture, and details accurate."
)


def _get_api_key() -> Optional[str]:
    """Get Gemini API key from environment."""
    return os.getenv("GOOGLE_API_KEY")


async def _download_image(url: str) -> Optional[bytes]:
    """Download image from URL, return bytes or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            if "image" not in content_type and not url.endswith((".jpg", ".png", ".webp")):
                return None
            return response.content
    except Exception:
        return None


async def generate_flat_lay(
    http_client: httpx.AsyncClient,
    api_key: str,
    image_url: str,
    title: str,
    semaphore: asyncio.Semaphore,
) -> Optional[str]:
    """
    Generate a flat lay image using Gemini REST API.

    Args:
        http_client: Async HTTP client
        api_key: Google API key
        image_url: URL of the original product image
        title: Product title for context
        semaphore: Concurrency limiter

    Returns:
        Base64 data URL string, or None on failure
    """
    async with semaphore:
        # Download the source image
        image_bytes = await _download_image(image_url)
        if not image_bytes:
            return None

        try:
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            prompt = f"{FLAT_LAY_PROMPT}\n\nProduct: {title}"

            payload = {
                "contents": [
                    {
                        "parts": [
                            {
                                "inline_data": {
                                    "mime_type": "image/jpeg",
                                    "data": image_b64,
                                }
                            },
                            {"text": prompt},
                        ]
                    }
                ],
                "generationConfig": {
                    "responseModalities": ["IMAGE", "TEXT"],
                },
            }

            response = await http_client.post(
                f"{GEMINI_API_URL}?key={api_key}",
                json=payload,
                timeout=60,
            )
            response.raise_for_status()
            data = response.json()

            # Extract generated image from response
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                for part in parts:
                    inline_data = part.get("inlineData")
                    if inline_data and inline_data.get("data"):
                        mime = inline_data.get("mimeType", "image/png")
                        b64 = inline_data["data"]
                        return f"data:{mime};base64,{b64}"

            return None

        except Exception as e:
            print(f"[Gemini] Failed for '{title[:40]}': {e}")
            return None


async def generate_flat_lays_batch(
    items: List[Dict],
) -> Dict[str, str]:
    """
    Generate flat lay images for a batch of clothing items.

    Args:
        items: List of clothing item dicts (must have image_url, title, product_id)

    Returns:
        Dict mapping product_id → base64 data URL for successful generations
    """
    api_key = _get_api_key()
    if not api_key:
        print("[Gemini] GOOGLE_API_KEY not configured, skipping flat lay generation")
        return {}

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async with httpx.AsyncClient() as http_client:

        async def _process_item(item: Dict) -> tuple:
            pid = item.get("product_id", "")
            result = await generate_flat_lay(
                http_client,
                api_key,
                item.get("image_url", ""),
                item.get("title", ""),
                semaphore,
            )
            return pid, result

        tasks = [_process_item(item) for item in items]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    flat_lay_map = {}
    for result in results:
        if isinstance(result, Exception):
            continue
        pid, data_url = result
        if pid and data_url:
            flat_lay_map[pid] = data_url

    success_count = len(flat_lay_map)
    total = len(items)
    print(f"[Gemini] Generated {success_count}/{total} flat lay images")

    return flat_lay_map
