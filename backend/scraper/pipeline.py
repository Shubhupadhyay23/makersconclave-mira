"""Scraping pipeline: full-history streaming scrape with incremental support."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial

from scraper.gmail_auth import build_gmail_service
from scraper.gmail_fetch import search_emails, get_message_content
from scraper.purchase_parser import extract_purchases
from scraper.brand_scanner import scan_brand_frequency
from scraper.profile_builder import build_style_profile

# Gmail search queries — full history (no date limits)
RECEIPT_QUERIES = [
    "subject:(order confirmation)",
    "subject:(order shipped)",
    "subject:(your order)",
    "subject:(receipt from)",
    "subject:(purchase confirmed)",
    "from:(noreply OR no-reply OR orders@ OR receipt@) subject:(order OR receipt OR confirmation)",
    "subject:(subscription) category:updates",
]

BRAND_SCAN_QUERY = "category:promotions newer_than:12m"

_executor = ThreadPoolExecutor(max_workers=4)


@dataclass
class ScrapeResult:
    purchases: list[dict] = field(default_factory=list)
    brand_freq: dict[str, int] = field(default_factory=dict)
    profile: dict = field(default_factory=dict)


def _fetch_receipts_sync(token_data: dict, queries: list[str], max_per_query: int = 20) -> list[dict]:
    """Synchronous: search + fetch receipt emails."""
    service = build_gmail_service(token_data)
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


def _fetch_subjects_sync(token_data: dict, query: str, max_results: int = 100) -> list[str]:
    """Synchronous: fetch subject lines for brand scanning."""
    service = build_gmail_service(token_data)
    msg_ids = search_emails(service, query=query, max_results=max_results)
    subjects = []
    for msg_id in msg_ids:
        try:
            content = get_message_content(service, msg_id)
            subjects.append(content["subject"])
        except Exception:
            continue
    return subjects


def _apply_since(queries: list[str], since: datetime | None) -> list[str]:
    """Append `after:YYYY/MM/DD` to each query if a since date is provided."""
    if not since:
        return queries
    date_filter = f" after:{since.strftime('%Y/%m/%d')}"
    return [q + date_filter for q in queries]


async def fast_scrape(token_data: dict, on_email=None, since: datetime | None = None) -> ScrapeResult:
    """Streaming scrape. If `since` is set, only fetches emails after that date."""
    loop = asyncio.get_running_loop()

    queries = _apply_since(RECEIPT_QUERIES, since)

    # Run receipt fetch and brand scan in parallel using thread pool
    # Each thread builds its own Gmail service to avoid httplib2 thread-safety issues
    receipt_task = loop.run_in_executor(
        _executor,
        partial(_fetch_receipts_sync, token_data, queries, 20),
    )
    brand_task = loop.run_in_executor(
        _executor,
        partial(_fetch_subjects_sync, token_data, BRAND_SCAN_QUERY, 100),
    )

    emails, subjects = await asyncio.gather(receipt_task, brand_task)

    # Parse purchases from receipt emails, streaming per-email via callback
    all_purchases = []
    for email in emails:
        new_purchases = extract_purchases(email)
        if new_purchases:
            all_purchases.extend(new_purchases)
            if on_email:
                await on_email(email, new_purchases)

    # Scan brand frequency
    brand_freq = scan_brand_frequency(subjects)

    # Build profile
    profile = build_style_profile(all_purchases, brand_freq)

    return ScrapeResult(
        purchases=all_purchases,
        brand_freq=brand_freq,
        profile=profile,
    )
