"""Web scraper for judge/organizer biographical data and photos.

Uses Serper web search + image search to gather information,
then Claude Haiku to extract structured data from results.
"""

import asyncio
import json
import logging
import os

import anthropic
import httpx

logger = logging.getLogger(__name__)

SERPER_SEARCH_URL = "https://google.serper.dev/search"
SERPER_IMAGES_URL = "https://google.serper.dev/images"

# Full list of TreeHacks 2025 judges and organizers
JUDGES_LIST: list[dict] = [
    # Judges
    {"name": "Gautam Kumar", "role": "judge"},
    {"name": "Greg Feingold", "role": "judge"},
    {"name": "Kyle Jeong", "role": "judge"},
    {"name": "Shrey Pandya", "role": "judge"},
    {"name": "Diyi Zhu", "role": "judge"},
    {"name": "Sarah Josief", "role": "judge"},
    {"name": "Craig Dennis", "role": "judge"},
    {"name": "Judy Cheong", "role": "judge"},
    {"name": "Rajesh Bhatia", "role": "judge"},
    {"name": "Sabrina Farmin", "role": "judge"},
    {"name": "Ben", "role": "judge"},
    {"name": "Kelsea An", "role": "judge"},
    {"name": "Olivia Petrie", "role": "judge"},
    {"name": "Sana Wajid", "role": "judge"},
    {"name": "Abhi Gangani", "role": "judge"},
    {"name": "Dev Chauhan", "role": "judge"},
    {"name": "Kshipra Dhame", "role": "judge"},
    {"name": "Prithvi Chaudhari", "role": "judge"},
    {"name": "Ryan Tran", "role": "judge"},
    {"name": "Jess Waterman", "role": "judge"},
    {"name": "David Yi", "role": "judge"},
    {"name": "Emma Kirst", "role": "judge"},
    {"name": "Claudia Dalmau", "role": "judge"},
    {"name": "Brandon", "role": "judge"},
    {"name": "Chad Rushing", "role": "judge"},
    {"name": "Daniel Sigman", "role": "judge"},
    {"name": "Matt Luat", "role": "judge"},
    {"name": "Felicia Chang", "role": "judge"},
    {"name": "Connor Ling", "role": "judge"},
    {"name": "Maddie Bernheim", "role": "judge"},
    {"name": "Vincent Po", "role": "judge"},
    {"name": "Janelle Battad", "role": "judge"},
    {"name": "Dj Isaac", "role": "judge"},
    {"name": "Max Forsey", "role": "judge"},
    {"name": "Zach Gulsby", "role": "judge"},
    {"name": "Jeff Gardner", "role": "judge"},
    {"name": "Robin Lee", "role": "judge"},
    {"name": "Sandy Orozco", "role": "judge"},
    {"name": "Hong Yi Chen", "role": "judge"},
    {"name": "Lauren Goldberg", "role": "judge"},
    {"name": "Megan Ehrlich", "role": "judge"},
    {"name": "Ojus Save", "role": "judge"},
    {"name": "Amanda Yiu", "role": "judge"},
    {"name": "Advait Maybhate", "role": "judge"},
    {"name": "Martin Ceballos", "role": "judge"},
    {"name": "Marvin von Hagen", "role": "judge"},
    {"name": "Michi Vinocour", "role": "judge"},
    {"name": "Samyok Nepal", "role": "judge"},
    # Organizers
    {"name": "Erin Shen", "role": "organizer"},
    {"name": "Grace Wang", "role": "organizer"},
    {"name": "Jerry Yao", "role": "organizer"},
    {"name": "Madison Lea Ho", "role": "organizer"},
    {"name": "Matthew Yu", "role": "organizer"},
    {"name": "Maxwell Spivakovsky", "role": "organizer"},
    {"name": "Michael Yu", "role": "organizer"},
    {"name": "Oliver Sin", "role": "organizer"},
    {"name": "Sahana Mantha", "role": "organizer"},
    {"name": "Shrish Premkrishna", "role": "organizer"},
    {"name": "Thryambak Ganapathy", "role": "organizer"},
    {"name": "Toryn Thompson", "role": "organizer"},
    {"name": "Tyler Rubenstein", "role": "organizer"},
]

# Names without a last name get extra context in the search query
_AMBIGUOUS_NAMES = {"Ben", "Brandon", "Dj Isaac"}


def _build_search_query(name: str, role: str) -> str:
    """Build a Serper search query with appropriate context."""
    if name in _AMBIGUOUS_NAMES:
        return f'"{name}" TreeHacks 2025'
    role_label = "judge" if role == "judge" else "organizer"
    return f'"{name}" TreeHacks Stanford 2025 {role_label}'


def _build_image_query(name: str) -> str:
    """Build a Serper image search query."""
    if name in _AMBIGUOUS_NAMES:
        return f"{name} TreeHacks headshot"
    return f"{name} headshot"


async def _serper_web_search(
    client: httpx.AsyncClient, query: str, api_key: str, num: int = 5
) -> list[dict]:
    """Call Serper web search API and return organic results."""
    try:
        resp = await client.post(
            SERPER_SEARCH_URL,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"q": query, "num": num},
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("organic", [])[:num]
    except Exception as e:
        logger.warning("Serper web search failed for %r: %s", query, e)
        return []


async def _serper_image_search(
    client: httpx.AsyncClient, query: str, api_key: str, num: int = 5
) -> list[dict]:
    """Call Serper image search API and return image results."""
    try:
        resp = await client.post(
            SERPER_IMAGES_URL,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"q": query, "num": num},
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("images", [])[:num]
    except Exception as e:
        logger.warning("Serper image search failed for %r: %s", query, e)
        return []


def _extract_with_llm(name: str, role: str, web_results: list[dict], image_results: list[dict]) -> dict:
    """Use Claude Haiku to extract structured biographical data from search results.

    Returns a dict with: title, organization, bio, photo_url, linkedin_url,
    twitter_url, website_url, confidence, source_urls.
    """
    auth_token = os.getenv("ANTHROPIC_AUTH_TOKEN")
    if not auth_token:
        return {"confidence": "none", "error": "No ANTHROPIC_AUTH_TOKEN set"}

    # Format web results for the prompt
    web_text = ""
    for i, r in enumerate(web_results, 1):
        web_text += (
            f"{i}. Title: {r.get('title', '')}\n"
            f"   Snippet: {r.get('snippet', '')}\n"
            f"   URL: {r.get('link', '')}\n\n"
        )

    # Format image results for the prompt
    image_text = ""
    for i, r in enumerate(image_results, 1):
        image_text += (
            f"{i}. Title: {r.get('title', '')}\n"
            f"   Image URL: {r.get('imageUrl', '')}\n"
            f"   Source: {r.get('source', '')}\n\n"
        )

    prompt = (
        f"Extract biographical information about {name} (a TreeHacks 2025 {role}) "
        f"from these search results.\n\n"
        f"WEB RESULTS:\n{web_text}\n"
        f"IMAGE RESULTS:\n{image_text}\n"
        f"Return a JSON object with these exact keys:\n"
        f"- title: their job title or role (string or null)\n"
        f"- organization: their company or university (string or null)\n"
        f"- bio: a 2-3 sentence biography (string or null)\n"
        f"- photo_url: the best headshot URL from image results (string or null)\n"
        f"- linkedin_url: their LinkedIn profile URL if found (string or null)\n"
        f"- twitter_url: their Twitter/X profile URL if found (string or null)\n"
        f"- website_url: their personal website URL if found (string or null)\n"
        f"- confidence: how confident you are this data is correct - \"high\", \"medium\", or \"low\"\n"
        f"- source_urls: array of URLs where you found information\n\n"
        f"If the search results don't clearly match this person, set confidence to \"low\" "
        f"and leave fields as null. Return ONLY valid JSON, no markdown fences."
    )

    try:
        client = anthropic.Anthropic(
            auth_token=auth_token,
            default_headers={"anthropic-beta": "oauth-2025-04-20"},
            default_query={"beta": "true"},
        )
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        content = message.content[0].text.strip()
        # Strip markdown code fences if present
        if content.startswith("```"):
            # Remove opening fence (```json or ```)
            content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3].strip()
        return json.loads(content)
    except Exception as e:
        logger.warning("LLM extraction failed for %s: %s", name, e)
        return {"confidence": "none", "error": str(e)}


async def scrape_single_judge(
    name: str,
    role: str,
    http_client: httpx.AsyncClient,
    api_key: str,
    semaphore: asyncio.Semaphore,
) -> dict:
    """Scrape biographical data for a single judge/organizer.

    Returns a dict with extracted data or an error.
    """
    async with semaphore:
        web_query = _build_search_query(name, role)
        image_query = _build_image_query(name)

        # Run web + image search in parallel
        web_results, image_results = await asyncio.gather(
            _serper_web_search(http_client, web_query, api_key),
            _serper_image_search(http_client, image_query, api_key),
        )

    # Claude extraction is sync (CPU-bound, not IO-bound under semaphore)
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(
        None, _extract_with_llm, name, role, web_results, image_results
    )

    return data


async def scrape_all_judges(db, on_progress=None) -> dict:
    """Scrape all pending judges. Handles seeding, rate limiting, and DB updates.

    Args:
        db: NeonHTTPClient instance
        on_progress: optional async callback(scraped, total, current_name)

    Returns:
        Summary dict with counts.
    """
    from judges.db import (
        seed_judges, get_pending_judges, update_judge_data, mark_judge_failed,
    )

    # Seed the full list (idempotent)
    await seed_judges(db, JUDGES_LIST)

    pending = await get_pending_judges(db)
    total = len(pending)
    if total == 0:
        return {"total": 0, "scraped": 0, "failed": 0, "message": "No pending judges"}

    api_key = os.getenv("SERPER_API_KEY")
    if not api_key:
        return {"total": total, "scraped": 0, "failed": 0, "error": "No SERPER_API_KEY set"}

    semaphore = asyncio.Semaphore(2)
    scraped = 0
    failed = 0

    async with httpx.AsyncClient(timeout=30) as http_client:
        # Process in batches of 3 with 1s delay between batches
        for i in range(0, total, 3):
            batch = pending[i:i + 3]
            tasks = []
            for judge in batch:
                tasks.append(
                    scrape_single_judge(
                        judge["name"], judge["role"],
                        http_client, api_key, semaphore,
                    )
                )
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for judge, result in zip(batch, results):
                if isinstance(result, Exception):
                    await mark_judge_failed(db, judge["id"], str(result))
                    failed += 1
                elif result.get("confidence") == "none" or "error" in result:
                    error_msg = result.get("error", "Unknown extraction error")
                    await mark_judge_failed(db, judge["id"], error_msg)
                    failed += 1
                else:
                    # Store low-confidence note in scrape_error for review
                    if result.get("confidence") == "low":
                        await update_judge_data(db, judge["id"], {
                            "title": result.get("title"),
                            "organization": result.get("organization"),
                            "bio": result.get("bio"),
                            "photo_url": result.get("photo_url"),
                            "linkedin_url": result.get("linkedin_url"),
                            "twitter_url": result.get("twitter_url"),
                            "website_url": result.get("website_url"),
                            "source_urls": result.get("source_urls", []),
                        })
                        # Mark as scraped but note the low confidence
                        await db.execute(
                            "UPDATE judges SET scrape_error = $1 WHERE id = $2",
                            ["low confidence - may need manual review", judge["id"]],
                        )
                    else:
                        await update_judge_data(db, judge["id"], {
                            "title": result.get("title"),
                            "organization": result.get("organization"),
                            "bio": result.get("bio"),
                            "photo_url": result.get("photo_url"),
                            "linkedin_url": result.get("linkedin_url"),
                            "twitter_url": result.get("twitter_url"),
                            "website_url": result.get("website_url"),
                            "source_urls": result.get("source_urls", []),
                        })
                    scraped += 1

                if on_progress:
                    await on_progress(scraped + failed, total, judge["name"])

            # Rate limit: 1s between batches
            if i + 3 < total:
                await asyncio.sleep(1)

    return {"total": total, "scraped": scraped, "failed": failed}
