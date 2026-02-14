"""Scraping pipeline: fast pass and background deep scrape."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial

from scraper.gmail_auth import build_gmail_service
from scraper.gmail_fetch import search_emails, get_message_content
from scraper.purchase_parser import extract_purchases
from scraper.brand_scanner import scan_brand_frequency
from scraper.profile_builder import build_style_profile

# Gmail search queries for receipt emails
RECEIPT_QUERIES = [
    "subject:(order confirmation) newer_than:6m",
    "subject:(order shipped) newer_than:6m",
    "subject:(receipt) newer_than:6m",
    "subject:(purchase) newer_than:6m",
    "from:(noreply OR no-reply) subject:(order) newer_than:6m",
]

DEEP_RECEIPT_QUERIES = [
    "subject:(order OR receipt OR shipped OR purchase OR confirmation)",
    "from:(noreply OR no-reply OR auto-confirm OR store-news)",
    "subject:(subscription) category:updates",
]

BRAND_SCAN_QUERY = "category:promotions newer_than:12m"

_executor = ThreadPoolExecutor(max_workers=4)


@dataclass
class ScrapeResult:
    purchases: list[dict] = field(default_factory=list)
    brand_freq: dict[str, int] = field(default_factory=dict)
    profile: dict = field(default_factory=dict)


def _fetch_receipts_sync(service, queries: list[str], max_per_query: int = 5) -> list[dict]:
    """Synchronous: search + fetch receipt emails."""
    all_message_ids = set()
    for query in queries:
        ids = search_emails(service, query=query, max_results=max_per_query)
        all_message_ids.update(ids)

    emails = []
    for msg_id in all_message_ids:
        try:
            content = get_message_content(service, msg_id)
            emails.append(content)
        except Exception:
            continue
    return emails


def _fetch_subjects_sync(service, query: str, max_results: int = 100) -> list[str]:
    """Synchronous: fetch subject lines for brand scanning."""
    msg_ids = search_emails(service, query=query, max_results=max_results)
    subjects = []
    for msg_id in msg_ids:
        try:
            content = get_message_content(service, msg_id)
            subjects.append(content["subject"])
        except Exception:
            continue
    return subjects


async def fast_scrape(token_data: dict) -> ScrapeResult:
    """Fast parallel scrape (~15s): receipts + brand frequency scan."""
    service = build_gmail_service(token_data)
    loop = asyncio.get_event_loop()

    # Run receipt fetch and brand scan in parallel using thread pool
    receipt_task = loop.run_in_executor(
        _executor,
        partial(_fetch_receipts_sync, service, RECEIPT_QUERIES, 5),
    )
    brand_task = loop.run_in_executor(
        _executor,
        partial(_fetch_subjects_sync, service, BRAND_SCAN_QUERY, 100),
    )

    emails, subjects = await asyncio.gather(receipt_task, brand_task)

    # Parse purchases from receipt emails
    all_purchases = []
    for email in emails:
        all_purchases.extend(extract_purchases(email))

    # Scan brand frequency
    brand_freq = scan_brand_frequency(subjects)

    # Build profile
    profile = build_style_profile(all_purchases, brand_freq)

    return ScrapeResult(
        purchases=all_purchases,
        brand_freq=brand_freq,
        profile=profile,
    )


async def deep_scrape(token_data: dict, on_update=None) -> ScrapeResult:
    """Background deep scrape: full inbox scan, streams results."""
    service = build_gmail_service(token_data)
    loop = asyncio.get_event_loop()

    all_purchases = []
    all_subjects = []

    for query in DEEP_RECEIPT_QUERIES:
        emails = await loop.run_in_executor(
            _executor,
            partial(_fetch_receipts_sync, service, [query], 50),
        )
        new_purchases = []
        for email in emails:
            new_purchases = extract_purchases(email)
            all_purchases.extend(new_purchases)
            all_subjects.append(email["subject"])

        # Stream partial results
        if on_update and new_purchases:
            brand_freq = scan_brand_frequency(all_subjects)
            profile = build_style_profile(all_purchases, brand_freq)
            partial_result = ScrapeResult(
                purchases=all_purchases.copy(),
                brand_freq=brand_freq,
                profile=profile,
            )
            await on_update(partial_result)

    brand_freq = scan_brand_frequency(all_subjects)
    profile = build_style_profile(all_purchases, brand_freq)

    return ScrapeResult(
        purchases=all_purchases,
        brand_freq=brand_freq,
        profile=profile,
    )
