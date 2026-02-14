# Data Scraping Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Gmail scraping pipeline that extracts purchase history from user emails, builds a style profile, and streams results to the agent in real-time.

**Architecture:** Google OAuth tokens arrive from the frontend after onboarding. The backend exchanges the auth code for tokens, stores them in the `users` table, then kicks off a two-phase scrape: a fast parallel pass (~15s) for immediate agent context, and a background deep scrape that streams updates via Socket.io as they complete. Parsed purchases are stored in the `purchases` table and aggregated into `style_profiles`.

**Tech Stack:** Python FastAPI, Google Gmail API (`google-api-python-client`), `google-auth-oauthlib`, `asyncio`, `python-socketio`, Neon Postgres (via existing `NeonHTTPClient`), existing Pydantic schemas.

**Worktree:** `/Users/louisyu/mirrorless/.worktrees/data-scraping/`

---

## Existing Code Reference

| File | Status | Notes |
|------|--------|-------|
| `backend/models/database.py` | Done | NeonHTTPClient with async execute/fetchval |
| `backend/models/schemas.py` | Done | PurchaseCreate, StyleProfileUpdate, UserResponse, etc. |
| `backend/migrations/001_initial_schema.sql` | Done | users (google_oauth_token jsonb), purchases, style_profiles |
| `backend/main.py` | Scaffold | FastAPI with CORS + /health only |
| `backend/scraper/__init__.py` | Empty | Where scraping code goes |
| `backend/services/serper_search.py` | Done | CLI prototype, not integrated |
| `backend/requirements.txt` | Done | google-auth, google-api-python-client already listed |

---

## Task 1: Google OAuth Token Exchange Endpoint

**Files:**
- Create: `backend/scraper/gmail_auth.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_gmail_auth.py`

**Step 1: Write the failing test**

Create `backend/tests/test_gmail_auth.py`:

```python
"""Tests for Gmail OAuth token exchange."""

import pytest
from unittest.mock import patch, MagicMock
from scraper.gmail_auth import exchange_auth_code, build_gmail_service


def test_exchange_auth_code_returns_credentials():
    """exchange_auth_code calls Google OAuth and returns token dict."""
    mock_flow = MagicMock()
    mock_flow.credentials.token = "access_token_123"
    mock_flow.credentials.refresh_token = "refresh_token_456"
    mock_flow.credentials.token_uri = "https://oauth2.googleapis.com/token"
    mock_flow.credentials.client_id = "client_id"
    mock_flow.credentials.client_secret = "client_secret"
    mock_flow.credentials.scopes = ["https://www.googleapis.com/auth/gmail.readonly"]

    with patch("scraper.gmail_auth.InstalledAppFlow") as MockFlow:
        MockFlow.from_client_config.return_value = mock_flow
        result = exchange_auth_code("fake_auth_code", redirect_uri="http://localhost:3000")

    assert result["access_token"] == "access_token_123"
    assert result["refresh_token"] == "refresh_token_456"
    assert "token_uri" in result


def test_build_gmail_service_returns_resource():
    """build_gmail_service creates a Gmail API resource from stored tokens."""
    token_data = {
        "access_token": "access_123",
        "refresh_token": "refresh_456",
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "cid",
        "client_secret": "csecret",
    }
    with patch("scraper.gmail_auth.build") as mock_build:
        mock_build.return_value = MagicMock()
        service = build_gmail_service(token_data)

    mock_build.assert_called_once()
    assert service is not None
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_gmail_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scraper.gmail_auth'`

**Step 3: Write minimal implementation**

Create `backend/scraper/gmail_auth.py`:

```python
"""Google OAuth token exchange and Gmail API service builder."""

import os

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
]


def exchange_auth_code(auth_code: str, redirect_uri: str) -> dict:
    """Exchange a Google OAuth authorization code for tokens.

    Returns a dict with access_token, refresh_token, token_uri,
    client_id, client_secret — suitable for storing in users.google_oauth_token.
    """
    client_config = {
        "web": {
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
    flow.redirect_uri = redirect_uri
    flow.fetch_token(code=auth_code)

    creds = flow.credentials
    return {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
    }


def build_gmail_service(token_data: dict):
    """Build an authenticated Gmail API service from stored token data."""
    creds = Credentials(
        token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=token_data.get("client_id"),
        client_secret=token_data.get("client_secret"),
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return build("gmail", "v1", credentials=creds)
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_gmail_auth.py -v`
Expected: 2 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/gmail_auth.py backend/tests/test_gmail_auth.py
git commit -m "feat: add Google OAuth token exchange and Gmail service builder"
```

---

## Task 2: Email Fetching — Search and Download Gmail Messages

**Files:**
- Create: `backend/scraper/gmail_fetch.py`
- Test: `backend/tests/test_gmail_fetch.py`

**Step 1: Write the failing test**

Create `backend/tests/test_gmail_fetch.py`:

```python
"""Tests for Gmail message fetching."""

import pytest
from unittest.mock import MagicMock, patch
from scraper.gmail_fetch import search_emails, get_message_content


def _mock_gmail_service(messages_list=None, message_get=None):
    """Build a mock Gmail service."""
    svc = MagicMock()
    if messages_list is not None:
        svc.users().messages().list().execute.return_value = messages_list
    if message_get is not None:
        svc.users().messages().get().execute.return_value = message_get
    return svc


def test_search_emails_returns_message_ids():
    """search_emails queries Gmail and returns list of message IDs."""
    svc = MagicMock()
    list_mock = MagicMock()
    list_mock.execute.return_value = {
        "messages": [{"id": "msg1"}, {"id": "msg2"}],
        "resultSizeEstimate": 2,
    }
    svc.users.return_value.messages.return_value.list.return_value = list_mock

    result = search_emails(svc, query="from:noreply@amazon.com", max_results=10)
    assert result == ["msg1", "msg2"]


def test_search_emails_empty():
    """search_emails returns empty list when no matches."""
    svc = MagicMock()
    list_mock = MagicMock()
    list_mock.execute.return_value = {"resultSizeEstimate": 0}
    svc.users.return_value.messages.return_value.list.return_value = list_mock

    result = search_emails(svc, query="nonexistent", max_results=5)
    assert result == []


def test_get_message_content_extracts_subject_and_body():
    """get_message_content returns subject, sender, date, and body text."""
    svc = MagicMock()
    get_mock = MagicMock()
    get_mock.execute.return_value = {
        "id": "msg1",
        "payload": {
            "headers": [
                {"name": "Subject", "value": "Your order has shipped!"},
                {"name": "From", "value": "noreply@amazon.com"},
                {"name": "Date", "value": "Mon, 10 Feb 2026 12:00:00 -0800"},
            ],
            "mimeType": "text/plain",
            "body": {"data": "WW91ciBvcmRlciBoYXMgc2hpcHBlZCE="},  # base64 "Your order has shipped!"
        },
    }
    svc.users.return_value.messages.return_value.get.return_value = get_mock

    result = get_message_content(svc, "msg1")
    assert result["subject"] == "Your order has shipped!"
    assert result["sender"] == "noreply@amazon.com"
    assert "shipped" in result["body"]
    assert result["message_id"] == "msg1"
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_gmail_fetch.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scraper.gmail_fetch'`

**Step 3: Write minimal implementation**

Create `backend/scraper/gmail_fetch.py`:

```python
"""Gmail message search and content extraction."""

import base64
from email.utils import parsedate_to_datetime


def search_emails(service, query: str, max_results: int = 10) -> list[str]:
    """Search Gmail for messages matching query. Returns list of message IDs."""
    response = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=max_results)
        .execute()
    )
    messages = response.get("messages", [])
    return [m["id"] for m in messages]


def get_message_content(service, message_id: str) -> dict:
    """Fetch a single Gmail message and extract subject, sender, date, body."""
    msg = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    payload = msg.get("payload", {})
    headers = {h["name"]: h["value"] for h in payload.get("headers", [])}

    body_text = _extract_body(payload)

    date_str = headers.get("Date", "")
    parsed_date = None
    if date_str:
        try:
            parsed_date = parsedate_to_datetime(date_str).isoformat()
        except Exception:
            parsed_date = date_str

    return {
        "message_id": message_id,
        "subject": headers.get("Subject", ""),
        "sender": headers.get("From", ""),
        "date": parsed_date,
        "body": body_text,
    }


def _extract_body(payload: dict) -> str:
    """Recursively extract plain text body from Gmail message payload."""
    mime = payload.get("mimeType", "")

    if mime == "text/plain" and "body" in payload:
        data = payload["body"].get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    for part in payload.get("parts", []):
        text = _extract_body(part)
        if text:
            return text

    return ""
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_gmail_fetch.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/gmail_fetch.py backend/tests/test_gmail_fetch.py
git commit -m "feat: add Gmail message search and content extraction"
```

---

## Task 3: Purchase Parser — Extract Items from Receipt Emails

**Files:**
- Create: `backend/scraper/purchase_parser.py`
- Test: `backend/tests/test_purchase_parser.py`

**Step 1: Write the failing test**

Create `backend/tests/test_purchase_parser.py`:

```python
"""Tests for purchase extraction from email content."""

from scraper.purchase_parser import extract_purchases, RECEIPT_SENDERS


def test_receipt_senders_is_nonempty():
    """We have a list of known receipt sender patterns."""
    assert len(RECEIPT_SENDERS) > 0
    assert any("amazon" in s for s in RECEIPT_SENDERS)


def test_extract_purchases_from_amazon_receipt():
    """Extracts brand, item, price from a typical Amazon receipt email."""
    email = {
        "message_id": "msg1",
        "subject": "Your Amazon.com order of Nike Air Max 90...",
        "sender": "auto-confirm@amazon.com",
        "date": "2026-01-15T10:00:00",
        "body": (
            "Hello,\n"
            "Thank you for your order.\n\n"
            "Nike Air Max 90\n"
            "Price: $129.99\n\n"
            "Shipping to: 123 Main St"
        ),
    }
    purchases = extract_purchases(email)
    assert len(purchases) >= 1
    p = purchases[0]
    assert p["brand"] == "Nike"
    assert "Air Max" in p["item_name"]
    assert p["price"] == 129.99
    assert p["source_email_id"] == "msg1"


def test_extract_purchases_non_receipt_returns_empty():
    """Non-receipt emails return empty list."""
    email = {
        "message_id": "msg2",
        "subject": "Meeting tomorrow",
        "sender": "coworker@company.com",
        "date": "2026-01-20T08:00:00",
        "body": "Hey, can we meet at 3pm?",
    }
    purchases = extract_purchases(email)
    assert purchases == []


def test_extract_purchases_handles_multiple_items():
    """Can extract multiple items from a single receipt."""
    email = {
        "message_id": "msg3",
        "subject": "Your Zara order confirmation",
        "sender": "noreply@zara.com",
        "date": "2026-02-01T14:00:00",
        "body": (
            "Order confirmation\n\n"
            "1x Oversized Blazer - $89.90\n"
            "1x Slim Fit Jeans - $49.90\n\n"
            "Subtotal: $139.80"
        ),
    }
    purchases = extract_purchases(email)
    assert len(purchases) >= 2
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_purchase_parser.py -v`
Expected: FAIL — `ModuleNotFoundError`

**Step 3: Write minimal implementation**

Create `backend/scraper/purchase_parser.py`:

```python
"""Extract purchase data from receipt emails using pattern matching."""

import re
from datetime import date

# Known receipt sender patterns (lowercase substrings)
RECEIPT_SENDERS = [
    "amazon.com",
    "noreply@zara.com",
    "nordstrom.com",
    "nike.com",
    "uniqlo.com",
    "hm.com",
    "aritzia.com",
    "gap.com",
    "macys.com",
    "urbanoutfitters.com",
    "asos.com",
    "ssense.com",
    "farfetch.com",
    "net-a-porter.com",
    "shopify.com",
    "store-news@",
    "order-update@",
    "receipt@",
    "confirmation@",
    "noreply@",
]

# Known brand names for matching
KNOWN_BRANDS = [
    "Nike", "Adidas", "Zara", "H&M", "Uniqlo", "Aritzia", "Nordstrom",
    "Gap", "Levi's", "Patagonia", "The North Face", "Lululemon",
    "Gucci", "Prada", "Balenciaga", "Supreme", "Off-White", "Stussy",
    "Carhartt", "Ralph Lauren", "Calvin Klein", "Tommy Hilfiger",
    "AllSaints", "Mango", "COS", "SSENSE", "Everlane", "Reformation",
]

# Price pattern: $XX.XX or $X,XXX.XX
PRICE_PATTERN = re.compile(r"\$\s?([\d,]+\.?\d{0,2})")

# Item-price line pattern: "item name - $XX.XX" or "item name $XX.XX" or "item name Price: $XX.XX"
ITEM_PRICE_PATTERN = re.compile(
    r"(?:(?:\d+x?\s+)?(.+?))\s*[-–—]?\s*(?:Price:\s*)?\$([\d,]+\.?\d{0,2})"
)


def _is_receipt(email: dict) -> bool:
    """Check if email is likely a receipt based on sender."""
    sender = email.get("sender", "").lower()
    subject = email.get("subject", "").lower()
    receipt_keywords = ["order", "receipt", "confirmation", "shipped", "purchase"]
    sender_match = any(pattern in sender for pattern in RECEIPT_SENDERS)
    subject_match = any(kw in subject for kw in receipt_keywords)
    return sender_match or subject_match


def _detect_brand(text: str, sender: str) -> str:
    """Detect the most likely brand from text content and sender."""
    for brand in KNOWN_BRANDS:
        if brand.lower() in text.lower() or brand.lower() in sender.lower():
            return brand
    # Fallback: extract domain from sender
    match = re.search(r"@([\w.-]+)", sender)
    if match:
        domain = match.group(1).split(".")[0].capitalize()
        return domain
    return "Unknown"


def _parse_price(price_str: str) -> float | None:
    """Parse a price string like '129.99' or '1,299.99' to float."""
    try:
        return float(price_str.replace(",", ""))
    except (ValueError, TypeError):
        return None


def _categorize_item(item_name: str) -> str | None:
    """Rough category assignment based on item name keywords."""
    name = item_name.lower()
    categories = {
        "shoes": ["shoe", "sneaker", "boot", "sandal", "air max", "jordan", "runner"],
        "tops": ["shirt", "tee", "top", "blouse", "sweater", "hoodie", "jacket", "blazer", "coat"],
        "bottoms": ["pant", "jean", "short", "skirt", "trouser", "legging"],
        "outerwear": ["jacket", "coat", "parka", "blazer", "vest"],
        "accessories": ["hat", "cap", "belt", "bag", "scarf", "watch", "sunglasses", "jewelry"],
        "dresses": ["dress", "romper", "jumpsuit"],
    }
    for cat, keywords in categories.items():
        if any(kw in name for kw in keywords):
            return cat
    return None


def extract_purchases(email: dict) -> list[dict]:
    """Extract purchase items from a receipt email.

    Returns list of dicts with: brand, item_name, category, price, date, source_email_id
    """
    if not _is_receipt(email):
        return []

    body = email.get("body", "")
    subject = email.get("subject", "")
    sender = email.get("sender", "")
    full_text = f"{subject}\n{body}"

    brand = _detect_brand(full_text, sender)

    # Try to extract item-price pairs from body
    matches = ITEM_PRICE_PATTERN.findall(body)

    purchases = []
    if matches:
        for item_name, price_str in matches:
            item_name = item_name.strip().strip("1234567890x ").strip()
            if len(item_name) < 3 or item_name.lower() in ("subtotal", "total", "tax", "shipping"):
                continue
            price = _parse_price(price_str)
            purchases.append({
                "brand": brand,
                "item_name": item_name,
                "category": _categorize_item(item_name),
                "price": price,
                "date": email.get("date"),
                "source_email_id": email.get("message_id"),
            })
    else:
        # Fallback: extract from subject line
        prices = PRICE_PATTERN.findall(full_text)
        price = _parse_price(prices[0]) if prices else None
        # Use subject as item name, strip common prefixes
        item_name = re.sub(
            r"^(your |order |re: |fwd: |amazon\.com order of )",
            "",
            subject,
            flags=re.IGNORECASE,
        ).strip().rstrip(".")
        if item_name:
            purchases.append({
                "brand": brand,
                "item_name": item_name,
                "category": _categorize_item(item_name),
                "price": price,
                "date": email.get("date"),
                "source_email_id": email.get("message_id"),
            })

    return purchases
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_purchase_parser.py -v`
Expected: 4 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/purchase_parser.py backend/tests/test_purchase_parser.py
git commit -m "feat: add receipt email parser with brand detection and item extraction"
```

---

## Task 4: Brand Scanner — Frequency Analysis from Subject Lines

**Files:**
- Create: `backend/scraper/brand_scanner.py`
- Test: `backend/tests/test_brand_scanner.py`

**Step 1: Write the failing test**

Create `backend/tests/test_brand_scanner.py`:

```python
"""Tests for brand frequency scanner."""

from scraper.brand_scanner import scan_brand_frequency


def test_scan_brand_frequency_counts_brands():
    """Counts brand mentions across email subjects."""
    subjects = [
        "Your Nike order has shipped",
        "Nike sale: 30% off everything",
        "Zara: Your order is confirmed",
        "Meeting at 3pm",
        "Aritzia new arrivals",
        "Nike Air Max restock alert",
    ]
    result = scan_brand_frequency(subjects)
    assert result["Nike"] == 3
    assert result["Zara"] == 1
    assert result["Aritzia"] == 1
    assert "Meeting" not in result


def test_scan_brand_frequency_empty():
    """Empty input returns empty dict."""
    assert scan_brand_frequency([]) == {}


def test_scan_brand_frequency_sorted_by_count():
    """Results are sorted by frequency descending."""
    subjects = ["Zara order"] * 5 + ["Nike order"] * 3 + ["H&M sale"] * 1
    result = scan_brand_frequency(subjects)
    brands = list(result.keys())
    assert brands[0] == "Zara"
    assert brands[1] == "Nike"
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_brand_scanner.py -v`
Expected: FAIL

**Step 3: Write minimal implementation**

Create `backend/scraper/brand_scanner.py`:

```python
"""Scan email subject lines for brand frequency."""

from collections import Counter
from scraper.purchase_parser import KNOWN_BRANDS


def scan_brand_frequency(subjects: list[str]) -> dict[str, int]:
    """Count how often known brands appear in a list of email subjects.

    Returns dict of {brand: count}, sorted by count descending.
    Only includes brands with at least 1 match.
    """
    counts: Counter = Counter()
    for subject in subjects:
        subject_lower = subject.lower()
        for brand in KNOWN_BRANDS:
            if brand.lower() in subject_lower:
                counts[brand] += 1
    return dict(counts.most_common())
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_brand_scanner.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/brand_scanner.py backend/tests/test_brand_scanner.py
git commit -m "feat: add brand frequency scanner for email subject lines"
```

---

## Task 5: Style Profile Builder — Aggregate Purchases into Profile

**Files:**
- Create: `backend/scraper/profile_builder.py`
- Test: `backend/tests/test_profile_builder.py`

**Step 1: Write the failing test**

Create `backend/tests/test_profile_builder.py`:

```python
"""Tests for style profile builder."""

from scraper.profile_builder import build_style_profile


def test_build_style_profile_aggregates():
    """Aggregates purchases and brand frequencies into a style profile."""
    purchases = [
        {"brand": "Nike", "item_name": "Air Max 90", "category": "shoes", "price": 129.99},
        {"brand": "Nike", "item_name": "Dri-FIT Tee", "category": "tops", "price": 35.00},
        {"brand": "Zara", "item_name": "Slim Fit Jeans", "category": "bottoms", "price": 49.90},
        {"brand": "Aritzia", "item_name": "Babaton Blazer", "category": "outerwear", "price": 198.00},
    ]
    brand_freq = {"Nike": 5, "Zara": 3, "Aritzia": 2}

    profile = build_style_profile(purchases, brand_freq)

    assert "Nike" in profile["brands"]
    assert "Zara" in profile["brands"]
    assert profile["price_range"]["min"] == 35.00
    assert profile["price_range"]["max"] == 198.00
    assert len(profile["style_tags"]) > 0
    assert profile["narrative_summary"] is not None


def test_build_style_profile_empty():
    """Empty purchases still returns valid profile structure."""
    profile = build_style_profile([], {})
    assert profile["brands"] == []
    assert profile["price_range"] == {"min": 0, "max": 0, "avg": 0}
    assert profile["style_tags"] == []
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_profile_builder.py -v`
Expected: FAIL

**Step 3: Write minimal implementation**

Create `backend/scraper/profile_builder.py`:

```python
"""Build a style profile from purchase data and brand frequencies."""

from collections import Counter

# Map categories to style tags
CATEGORY_STYLE_MAP = {
    "shoes": ["sneakerhead", "athletic"],
    "tops": ["casual"],
    "bottoms": ["casual"],
    "outerwear": ["layered", "polished"],
    "accessories": ["accessorized"],
    "dresses": ["feminine", "occasion-ready"],
}

# Map price ranges to style tags
PRICE_STYLE_MAP = [
    (0, 50, "budget-friendly"),
    (50, 150, "mid-range"),
    (150, 500, "premium"),
    (500, float("inf"), "luxury"),
]


def build_style_profile(
    purchases: list[dict],
    brand_freq: dict[str, int],
) -> dict:
    """Aggregate purchases and brand frequencies into a style profile.

    Returns dict matching StyleProfileUpdate schema:
    {brands, price_range, style_tags, narrative_summary}
    """
    if not purchases and not brand_freq:
        return {
            "brands": [],
            "price_range": {"min": 0, "max": 0, "avg": 0},
            "style_tags": [],
            "narrative_summary": None,
        }

    # Brands: merge from purchases + frequency scan, ordered by frequency
    brand_counts = Counter(brand_freq)
    for p in purchases:
        brand_counts[p["brand"]] += 1
    brands = [b for b, _ in brand_counts.most_common()]

    # Price range
    prices = [p["price"] for p in purchases if p.get("price") is not None]
    price_range = {
        "min": min(prices) if prices else 0,
        "max": max(prices) if prices else 0,
        "avg": round(sum(prices) / len(prices), 2) if prices else 0,
    }

    # Style tags from categories
    style_tags = set()
    category_counts = Counter(p.get("category") for p in purchases if p.get("category"))
    for cat, count in category_counts.items():
        if cat in CATEGORY_STYLE_MAP:
            style_tags.update(CATEGORY_STYLE_MAP[cat])

    # Style tags from price range
    avg_price = price_range["avg"]
    for low, high, tag in PRICE_STYLE_MAP:
        if low <= avg_price < high:
            style_tags.add(tag)
            break

    # Narrative summary
    top_brands = ", ".join(brands[:3]) if brands else "various brands"
    cat_summary = ", ".join(
        f"{cat} ({count})" for cat, count in category_counts.most_common(3)
    )
    narrative = (
        f"Shops primarily at {top_brands}. "
        f"Most purchased categories: {cat_summary or 'mixed'}. "
        f"Typical spending: ${price_range['avg']:.0f} per item "
        f"(range ${price_range['min']:.0f}-${price_range['max']:.0f})."
    )

    return {
        "brands": brands,
        "price_range": price_range,
        "style_tags": sorted(style_tags),
        "narrative_summary": narrative,
    }
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_profile_builder.py -v`
Expected: 2 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/profile_builder.py backend/tests/test_profile_builder.py
git commit -m "feat: add style profile builder from purchase aggregation"
```

---

## Task 6: Fast Scrape Pipeline — Parallel Receipt + Brand Scan (~15s)

**Files:**
- Create: `backend/scraper/pipeline.py`
- Test: `backend/tests/test_pipeline.py`

**Step 1: Write the failing test**

Create `backend/tests/test_pipeline.py`:

```python
"""Tests for the scraping pipeline orchestrator."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from scraper.pipeline import fast_scrape, ScrapeResult


def _mock_gmail_service():
    svc = MagicMock()
    # search_emails mock
    list_mock = MagicMock()
    list_mock.execute.return_value = {
        "messages": [{"id": "msg1"}],
    }
    svc.users.return_value.messages.return_value.list.return_value = list_mock

    # get_message_content mock
    get_mock = MagicMock()
    get_mock.execute.return_value = {
        "id": "msg1",
        "payload": {
            "headers": [
                {"name": "Subject", "value": "Your Nike order: Air Max 90"},
                {"name": "From", "value": "auto-confirm@amazon.com"},
                {"name": "Date", "value": "Mon, 10 Feb 2026 12:00:00 -0800"},
            ],
            "mimeType": "text/plain",
            "body": {"data": "TmlrZSBBaXIgTWF4IDkwIC0gJDEyOS45OQ=="},
        },
    }
    svc.users.return_value.messages.return_value.get.return_value = get_mock
    return svc


@pytest.mark.asyncio
async def test_fast_scrape_returns_result():
    """fast_scrape returns a ScrapeResult with purchases and brand_freq."""
    mock_svc = _mock_gmail_service()

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        result = await fast_scrape(token_data={"access_token": "test"})

    assert isinstance(result, ScrapeResult)
    assert isinstance(result.purchases, list)
    assert isinstance(result.brand_freq, dict)
    assert isinstance(result.profile, dict)


@pytest.mark.asyncio
async def test_fast_scrape_returns_profile_with_brands():
    """fast_scrape profile includes detected brands."""
    mock_svc = _mock_gmail_service()

    with patch("scraper.pipeline.build_gmail_service", return_value=mock_svc):
        result = await fast_scrape(token_data={"access_token": "test"})

    assert "brands" in result.profile
    assert "price_range" in result.profile
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_pipeline.py -v`
Expected: FAIL

**Step 3: Write minimal implementation**

Create `backend/scraper/pipeline.py`:

```python
"""Scraping pipeline: fast pass and background deep scrape."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial

from scraper.gmail_auth import build_gmail_service
from scraper.gmail_fetch import search_emails, get_message_content
from scraper.purchase_parser import extract_purchases, RECEIPT_SENDERS
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
    """Fast parallel scrape (~15s): receipts + brand frequency scan.

    1. Parallel: fetch recent receipts + brand frequency subjects
    2. Parse purchases from receipts
    3. Scan brands from subjects
    4. Build style profile
    """
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
    """Background deep scrape: full inbox scan, streams results.

    Args:
        token_data: Google OAuth tokens
        on_update: Optional async callback(ScrapeResult) called as new data arrives
    """
    service = build_gmail_service(token_data)
    loop = asyncio.get_event_loop()

    all_purchases = []
    all_subjects = []

    for query in DEEP_RECEIPT_QUERIES:
        emails = await loop.run_in_executor(
            _executor,
            partial(_fetch_receipts_sync, service, [query], 50),
        )
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
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_pipeline.py -v`
Expected: 2 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/pipeline.py backend/tests/test_pipeline.py
git commit -m "feat: add fast scrape pipeline with parallel receipt + brand scan"
```

---

## Task 7: Scraper Database Layer — Store Purchases and Profiles

**Files:**
- Create: `backend/scraper/db.py`
- Test: `backend/tests/test_scraper_db.py`

**Step 1: Write the failing test**

Create `backend/tests/test_scraper_db.py`:

```python
"""Tests for scraper database operations (unit tests with mocked DB)."""

import pytest
from unittest.mock import AsyncMock
from scraper.db import store_purchases, store_style_profile, get_user_token


@pytest.mark.asyncio
async def test_store_purchases_inserts_rows():
    """store_purchases inserts each purchase into the purchases table."""
    db = AsyncMock()
    db.execute.return_value = []

    purchases = [
        {
            "brand": "Nike",
            "item_name": "Air Max 90",
            "category": "shoes",
            "price": 129.99,
            "date": "2026-01-15",
            "source_email_id": "msg1",
        },
        {
            "brand": "Zara",
            "item_name": "Slim Jeans",
            "category": "bottoms",
            "price": 49.90,
            "date": "2026-02-01",
            "source_email_id": "msg2",
        },
    ]
    await store_purchases(db, "user-uuid-123", purchases)
    assert db.execute.call_count == 2


@pytest.mark.asyncio
async def test_store_style_profile_upserts():
    """store_style_profile upserts into style_profiles table."""
    db = AsyncMock()
    db.execute.return_value = []

    profile = {
        "brands": ["Nike", "Zara"],
        "price_range": {"min": 49.90, "max": 129.99, "avg": 89.95},
        "style_tags": ["casual", "sneakerhead"],
        "narrative_summary": "Shops at Nike and Zara.",
    }
    await store_style_profile(db, "user-uuid-123", profile)
    db.execute.assert_called_once()
    call_args = db.execute.call_args
    assert "INSERT INTO style_profiles" in call_args[0][0]
    assert "ON CONFLICT" in call_args[0][0]


@pytest.mark.asyncio
async def test_get_user_token_returns_token_data():
    """get_user_token fetches google_oauth_token from users table."""
    db = AsyncMock()
    db.execute.return_value = [{"google_oauth_token": {"access_token": "abc"}}]

    result = await get_user_token(db, "user-uuid-123")
    assert result["access_token"] == "abc"
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_scraper_db.py -v`
Expected: FAIL

**Step 3: Write minimal implementation**

Create `backend/scraper/db.py`:

```python
"""Database operations for the scraping pipeline."""

import json


async def store_purchases(db, user_id: str, purchases: list[dict]) -> None:
    """Insert parsed purchases into the purchases table."""
    for p in purchases:
        await db.execute(
            "INSERT INTO purchases (user_id, brand, item_name, category, price, date, source_email_id) "
            "VALUES ($1, $2, $3, $4, $5, $6::date, $7)",
            [
                user_id,
                p["brand"],
                p["item_name"],
                p.get("category"),
                p.get("price"),
                p.get("date"),
                p.get("source_email_id"),
            ],
        )


async def store_style_profile(db, user_id: str, profile: dict) -> None:
    """Upsert a style profile for the user."""
    await db.execute(
        "INSERT INTO style_profiles (user_id, brands, price_range, style_tags, narrative_summary) "
        "VALUES ($1, $2, $3::jsonb, $4, $5) "
        "ON CONFLICT (user_id) DO UPDATE SET "
        "brands = EXCLUDED.brands, "
        "price_range = EXCLUDED.price_range, "
        "style_tags = EXCLUDED.style_tags, "
        "narrative_summary = EXCLUDED.narrative_summary",
        [
            user_id,
            "{" + ",".join(profile["brands"]) + "}" if profile["brands"] else "{}",
            json.dumps(profile["price_range"]),
            "{" + ",".join(profile["style_tags"]) + "}" if profile["style_tags"] else "{}",
            profile.get("narrative_summary"),
        ],
    )


async def get_user_token(db, user_id: str) -> dict | None:
    """Fetch the Google OAuth token for a user."""
    rows = await db.execute(
        "SELECT google_oauth_token FROM users WHERE id = $1",
        [user_id],
    )
    if rows and rows[0].get("google_oauth_token"):
        token = rows[0]["google_oauth_token"]
        return token if isinstance(token, dict) else json.loads(token)
    return None


async def store_user_token(db, user_id: str, token_data: dict) -> None:
    """Store Google OAuth token for a user."""
    await db.execute(
        "UPDATE users SET google_oauth_token = $1::jsonb WHERE id = $2",
        [json.dumps(token_data), user_id],
    )
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_scraper_db.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/db.py backend/tests/test_scraper_db.py
git commit -m "feat: add scraper database layer for purchases and style profiles"
```

---

## Task 8: FastAPI Routes — Scraping Endpoints

**Files:**
- Create: `backend/scraper/routes.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_scraper_routes.py`

**Step 1: Write the failing test**

Create `backend/tests/test_scraper_routes.py`:

```python
"""Tests for scraping API routes."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from httpx import AsyncClient, ASGITransport
from main import app
from scraper.pipeline import ScrapeResult


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.execute.return_value = []
    return db


@pytest.mark.asyncio
async def test_exchange_token_endpoint(mock_db):
    """POST /api/scrape/auth exchanges auth code and stores token."""
    mock_token = {"access_token": "abc", "refresh_token": "def"}

    with (
        patch("scraper.routes.get_neon_client", return_value=mock_db),
        patch("scraper.routes.exchange_auth_code", return_value=mock_token),
    ):
        mock_db.execute.return_value = [{"id": "user-123"}]
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/scrape/auth",
                json={"user_id": "user-123", "auth_code": "code123", "redirect_uri": "http://localhost:3000"},
            )
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_start_scrape_endpoint(mock_db):
    """POST /api/scrape/start triggers fast scrape and returns results."""
    mock_result = ScrapeResult(
        purchases=[{"brand": "Nike", "item_name": "Shoes", "price": 100}],
        brand_freq={"Nike": 3},
        profile={"brands": ["Nike"], "price_range": {"min": 100, "max": 100, "avg": 100}},
    )
    mock_db.execute.return_value = [{"google_oauth_token": {"access_token": "abc"}}]

    with (
        patch("scraper.routes.get_neon_client", return_value=mock_db),
        patch("scraper.routes.fast_scrape", return_value=mock_result),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/scrape/start",
                json={"user_id": "user-123"},
            )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["purchases"]) == 1
    assert data["profile"]["brands"] == ["Nike"]
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_scraper_routes.py -v`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/scraper/routes.py`:

```python
"""FastAPI routes for the scraping pipeline."""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.database import get_neon_client
from scraper.gmail_auth import exchange_auth_code
from scraper.pipeline import fast_scrape, deep_scrape
from scraper.db import store_purchases, store_style_profile, get_user_token, store_user_token

router = APIRouter(prefix="/api/scrape", tags=["scraping"])


class AuthRequest(BaseModel):
    user_id: str
    auth_code: str
    redirect_uri: str


class ScrapeRequest(BaseModel):
    user_id: str


@router.post("/auth")
async def exchange_token(req: AuthRequest):
    """Exchange Google OAuth auth code for tokens and store them."""
    try:
        token_data = exchange_auth_code(req.auth_code, req.redirect_uri)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth exchange failed: {e}")

    db = await get_neon_client()
    try:
        await store_user_token(db, req.user_id, token_data)
    finally:
        await db.close()

    return {"status": "ok"}


@router.post("/start")
async def start_scrape(req: ScrapeRequest):
    """Run fast scrape and return immediate results. Kicks off deep scrape in background."""
    db = await get_neon_client()
    try:
        token_data = await get_user_token(db, req.user_id)
        if not token_data:
            raise HTTPException(status_code=400, detail="No OAuth token for user. Complete /auth first.")

        # Fast scrape (~15s)
        result = await fast_scrape(token_data)

        # Store results
        await store_purchases(db, req.user_id, result.purchases)
        await store_style_profile(db, req.user_id, result.profile)

        # Kick off deep scrape in background (fire-and-forget)
        asyncio.create_task(_background_deep_scrape(req.user_id, token_data))

        return {
            "purchases": result.purchases,
            "brand_freq": result.brand_freq,
            "profile": result.profile,
        }
    finally:
        await db.close()


async def _background_deep_scrape(user_id: str, token_data: dict):
    """Run deep scrape in background and store results incrementally."""
    db = await get_neon_client()
    try:
        async def on_update(partial_result):
            await store_purchases(db, user_id, partial_result.purchases[-5:])
            await store_style_profile(db, user_id, partial_result.profile)

        await deep_scrape(token_data, on_update=on_update)
    except Exception as e:
        print(f"[deep_scrape] Error for user {user_id}: {e}")
    finally:
        await db.close()
```

Update `backend/main.py` to include the router:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from scraper.routes import router as scraper_router

app = FastAPI(title="Mirrorless API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scraper_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_scraper_routes.py -v`
Expected: 2 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/routes.py backend/main.py backend/tests/test_scraper_routes.py
git commit -m "feat: add FastAPI scraping endpoints with auth + fast scrape"
```

---

## Task 9: Socket.io Integration — Stream Scrape Progress to Clients

**Files:**
- Create: `backend/scraper/socket_events.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_socket_events.py`

**Step 1: Write the failing test**

Create `backend/tests/test_socket_events.py`:

```python
"""Tests for Socket.io scrape progress events."""

import pytest
from unittest.mock import AsyncMock
from scraper.socket_events import emit_scrape_progress, emit_scrape_complete


@pytest.mark.asyncio
async def test_emit_scrape_progress():
    """emit_scrape_progress emits scrape_progress event to user's room."""
    sio = AsyncMock()
    await emit_scrape_progress(
        sio,
        user_id="user-123",
        purchases_count=5,
        brands_found=["Nike", "Zara"],
        phase="fast",
    )
    sio.emit.assert_called_once_with(
        "scrape_progress",
        {
            "user_id": "user-123",
            "purchases_count": 5,
            "brands_found": ["Nike", "Zara"],
            "phase": "fast",
        },
        room="user-123",
    )


@pytest.mark.asyncio
async def test_emit_scrape_complete():
    """emit_scrape_complete emits scrape_complete with profile."""
    sio = AsyncMock()
    profile = {"brands": ["Nike"], "price_range": {"min": 50, "max": 200, "avg": 100}}
    await emit_scrape_complete(sio, user_id="user-123", profile=profile)
    sio.emit.assert_called_once()
    call_args = sio.emit.call_args
    assert call_args[0][0] == "scrape_complete"
    assert call_args[0][1]["profile"] == profile
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_socket_events.py -v`
Expected: FAIL

**Step 3: Write implementation**

Create `backend/scraper/socket_events.py`:

```python
"""Socket.io events for scraping progress updates."""


async def emit_scrape_progress(
    sio,
    user_id: str,
    purchases_count: int,
    brands_found: list[str],
    phase: str,
) -> None:
    """Emit scrape progress to the user's room."""
    await sio.emit(
        "scrape_progress",
        {
            "user_id": user_id,
            "purchases_count": purchases_count,
            "brands_found": brands_found,
            "phase": phase,
        },
        room=user_id,
    )


async def emit_scrape_complete(
    sio,
    user_id: str,
    profile: dict,
) -> None:
    """Emit scrape completion with final profile."""
    await sio.emit(
        "scrape_complete",
        {
            "user_id": user_id,
            "profile": profile,
        },
        room=user_id,
    )
```

Update `backend/main.py` to add Socket.io server:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import socketio

from scraper.routes import router as scraper_router

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

app = FastAPI(title="Mirrorless API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scraper_router)

# Make sio accessible to routes
app.state.sio = sio


@app.get("/health")
async def health():
    return {"status": "ok"}


@sio.event
async def connect(sid, environ):
    print(f"[socket] Client connected: {sid}")


@sio.event
async def join_room(sid, data):
    """Client joins a user-specific room for targeted events."""
    user_id = data.get("user_id")
    if user_id:
        sio.enter_room(sid, user_id)
        print(f"[socket] {sid} joined room {user_id}")


@sio.event
async def disconnect(sid):
    print(f"[socket] Client disconnected: {sid}")


# Wrap FastAPI with Socket.io ASGI app
socket_app = socketio.ASGIApp(sio, other_app=app)
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/test_socket_events.py -v`
Expected: 2 passed

**Step 5: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/socket_events.py backend/main.py backend/tests/test_socket_events.py
git commit -m "feat: add Socket.io scrape progress events and server setup"
```

---

## Task 10: Update Scraper __init__.py and .env.example

**Files:**
- Modify: `backend/scraper/__init__.py`
- Modify: `backend/.env.example`

**Step 1: Update scraper module init**

Update `backend/scraper/__init__.py`:

```python
"""Gmail scraping pipeline for purchase history extraction."""

from scraper.pipeline import fast_scrape, deep_scrape, ScrapeResult

__all__ = ["fast_scrape", "deep_scrape", "ScrapeResult"]
```

**Step 2: Update .env.example with all required variables**

Update `backend/.env.example`:

```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
ANTHROPIC_API_KEY=your_anthropic_api_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
SERPER_API_KEY=your_serper_api_key_here
DEEPGRAM_API_KEY=your_deepgram_api_key
HEYGEN_API_KEY=your_heygen_api_key
```

**Step 3: Run all tests**

Run: `cd /Users/louisyu/mirrorless/.worktrees/data-scraping/backend && python -m pytest tests/ -v --ignore=tests/test_database.py`
Expected: All unit tests pass (test_database.py ignored as it needs live DB)

**Step 4: Commit**

```bash
cd /Users/louisyu/mirrorless/.worktrees/data-scraping
git add backend/scraper/__init__.py backend/.env.example
git commit -m "chore: update scraper module exports and .env.example"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | Google OAuth token exchange | `scraper/gmail_auth.py` | 2 |
| 2 | Gmail message search + fetch | `scraper/gmail_fetch.py` | 3 |
| 3 | Receipt email purchase parser | `scraper/purchase_parser.py` | 4 |
| 4 | Brand frequency scanner | `scraper/brand_scanner.py` | 3 |
| 5 | Style profile builder | `scraper/profile_builder.py` | 2 |
| 6 | Fast scrape pipeline (parallel) | `scraper/pipeline.py` | 2 |
| 7 | Database layer for scraper | `scraper/db.py` | 3 |
| 8 | FastAPI routes | `scraper/routes.py` + `main.py` | 2 |
| 9 | Socket.io progress events | `scraper/socket_events.py` + `main.py` | 2 |
| 10 | Module init + env config | `scraper/__init__.py` + `.env.example` | — |

**Total: 10 tasks, ~23 unit tests, 10 commits**

### API Endpoints Created

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/scrape/auth` | Exchange OAuth auth code for tokens |
| POST | `/api/scrape/start` | Trigger fast scrape, return results, kick off deep scrape |
| GET | `/health` | Health check (existing) |

### Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `join_room` | Client → Server | Join user-specific room |
| `scrape_progress` | Server → Client | Partial scrape results (purchases count, brands) |
| `scrape_complete` | Server → Client | Final profile after deep scrape |
