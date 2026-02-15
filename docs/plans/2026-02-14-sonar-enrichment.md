# Perplexity Sonar Purchase Enrichment

## Overview

Use Perplexity Sonar to fill price gaps and fix unknown brand names in scraped purchase data. Runs as a **non-blocking background job** triggered during style profile building. Only enriches **fashion items** (`is_fashion=true`) with null prices or generic/unknown brand names.

## Problem

~10-30% of LLM-extracted purchases have null prices (shipping confirmations, vague receipt formats, truncated email bodies). Some items also get generic brand names like "Unknown" or sender-derived names like "Auto-Confirm" when the LLM and `_detect_brand` fallback both fail. This degrades Mira's price range stats, style profile accuracy, and purchase roast quality.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger | Background job at profile build time | Don't block scraping or session start |
| Scope | Fashion items only (`is_fashion=true`) | Non-fashion items (Uber, Starbucks) don't need price enrichment for Mira |
| Price caching | Write back to `purchases.price` with `price_estimated=true` flag | Avoids repeat API calls; Mira treats estimated and real prices the same |
| Brand correction | Only when brand is "Unknown" or clearly not a real brand | Don't override confident LLM extractions; just fix the fallback failures |
| Tracking | `enriched_at` timestamp column | Know what's been through Sonar, enable re-enrichment of stale data later |
| API | Perplexity Sonar endpoint (structured JSON response) | Direct search-grounded answers, no intermediary LLM parsing needed |
| Config | `PERPLEXITY_API_KEY` env var, warn-and-skip if missing | Graceful degradation — enrichment is optional, pipeline still works without it |
| Model tier | Regular `sonar` | Sufficient for price lookups; sonar-pro not needed |
| Mira display | No distinction between estimated and real prices | Mira says "$130" not "~$130" — keeps conversation natural |

## Database Changes

### Migration: `008_add_enrichment_columns.sql`

```sql
-- Add price_estimated flag to distinguish real vs Sonar-sourced prices
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS price_estimated boolean NOT NULL DEFAULT false;

-- Add enrichment timestamp for tracking
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
```

No backfill needed — all existing prices are real (not estimated).

## Architecture

### Enrichment Flow

```
Profile Build triggered (scraper/pipeline.py or agent session start)
  └─> Fire-and-forget: enrich_null_prices(db, user_id)
        ├─> SELECT fashion items WHERE price IS NULL AND enriched_at IS NULL
        ├─> For each item: query Perplexity Sonar
        │     Query: "What is the current retail price of {brand} {item_name}?"
        │     Response format: JSON {price, currency, brand_correction}
        ├─> UPDATE purchases SET price = X, price_estimated = true, enriched_at = now()
        └─> If brand was "Unknown" and Sonar returned a brand: UPDATE brand too
```

### Sonar Query Design

**Structured prompt** requesting JSON output:

```
You are a shopping price lookup assistant. Given a product, return its current retail price.

Product: {brand} {item_name}

Return a JSON object with:
- price (number): the retail price in USD, or null if unknown
- currency (string): "USD"
- brand_correction (string or null): the correct brand name if the provided brand seems wrong or generic, otherwise null

Return ONLY the JSON object, no other text.
```

**When brand is "Unknown"**, the query becomes:
```
Product: {item_name}
```
And we use `brand_correction` from the response.

### Non-Blocking Execution

The enrichment runs as an `asyncio.create_task()` — fire-and-forget from the profile building step. If it fails or times out, the pipeline continues normally. Items just keep their null prices until the next profile build.

## Files to Create/Modify

| File | Change |
|------|--------|
| `backend/migrations/008_add_enrichment_columns.sql` | **NEW** — `price_estimated` boolean, `enriched_at` timestamp |
| `backend/scraper/enrichment.py` | **NEW** — Sonar client, `enrich_null_prices()`, `_query_sonar()` |
| `backend/scraper/pipeline.py` | Add fire-and-forget call to `enrich_null_prices()` after profile build |
| `backend/scraper/db.py` | Add `update_enriched_price()` function |
| `backend/tests/test_enrichment.py` | **NEW** — Unit tests with mocked Sonar responses |

## Implementation Detail

### `scraper/enrichment.py` (new file)

```python
"""Perplexity Sonar enrichment for purchase data."""

import json
import logging
import os

import httpx

from models.database import NeonHTTPClient

logger = logging.getLogger(__name__)

SONAR_API_URL = "https://api.perplexity.ai/chat/completions"
SONAR_MODEL = "sonar"

# Brands that are clearly not real brand names (from sender fallback)
GENERIC_BRANDS = {"unknown", "auto-confirm", "noreply", "no-reply", "orders", "info", "mail", "news", "us"}


async def enrich_null_prices(db: NeonHTTPClient, user_id: str) -> int:
    """Enrich fashion purchases that have null prices using Perplexity Sonar.

    Returns the number of items enriched.
    """
    api_key = os.getenv("PERPLEXITY_API_KEY")
    if not api_key:
        logger.warning("PERPLEXITY_API_KEY not set — skipping purchase enrichment")
        return 0

    # Fetch fashion items with null price that haven't been enriched yet
    rows = await db.execute(
        "SELECT id, brand, item_name FROM purchases "
        "WHERE user_id = $1 AND is_fashion = true AND price IS NULL AND enriched_at IS NULL "
        "ORDER BY date DESC",
        [user_id],
    )

    if not rows:
        logger.info("No null-price fashion items to enrich for user %s", user_id)
        return 0

    logger.info("Enriching %d null-price fashion items for user %s", len(rows), user_id)
    enriched = 0

    for row in rows:
        item_id = row["id"]
        brand = row.get("brand", "Unknown")
        item_name = row.get("item_name", "")

        result = await _query_sonar(api_key, brand, item_name)
        if result is None:
            # Mark as attempted so we don't retry
            await db.execute(
                "UPDATE purchases SET enriched_at = now() WHERE id = $1",
                [item_id],
            )
            continue

        price = result.get("price")
        brand_correction = result.get("brand_correction")

        # Build update
        updates = ["enriched_at = now()"]
        params = []
        param_idx = 1

        if price is not None:
            updates.append(f"price = ${param_idx}")
            params.append(price)
            param_idx += 1
            updates.append(f"price_estimated = true")

        if brand_correction and brand.lower() in GENERIC_BRANDS:
            updates.append(f"brand = ${param_idx}")
            params.append(brand_correction)
            param_idx += 1

        params.append(item_id)
        await db.execute(
            f"UPDATE purchases SET {', '.join(updates)} WHERE id = ${param_idx}",
            params,
        )
        enriched += 1

    logger.info("Enriched %d/%d items for user %s", enriched, len(rows), user_id)
    return enriched


async def _query_sonar(api_key: str, brand: str, item_name: str) -> dict | None:
    """Query Perplexity Sonar for price and brand data."""
    product_desc = f"{brand} {item_name}" if brand.lower() not in GENERIC_BRANDS else item_name

    prompt = (
        "You are a shopping price lookup assistant. Given a product, return its current retail price.\n\n"
        f"Product: {product_desc}\n\n"
        "Return a JSON object with:\n"
        "- price (number): the retail price in USD, or null if unknown\n"
        "- currency (string): \"USD\"\n"
        "- brand_correction (string or null): the correct brand name if the provided brand "
        "seems wrong or generic, otherwise null\n\n"
        "Return ONLY the JSON object, no other text."
    )

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                SONAR_API_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": SONAR_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 256,
                },
            )
            response.raise_for_status()
            data = response.json()

        content = data["choices"][0]["message"]["content"]
        # Parse JSON from response (handle markdown code blocks)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        return json.loads(content)
    except Exception as e:
        logger.warning("Sonar query failed for '%s %s': %s", brand, item_name, e)
        return None
```

### `scraper/pipeline.py` change

After `build_style_profile()` and `store_style_profile()`, add:

```python
# Fire-and-forget: enrich null-price fashion items in background
import asyncio
from scraper.enrichment import enrich_null_prices
asyncio.create_task(enrich_null_prices(db, user_id))
```

### `scraper/db.py` addition

No separate function needed — the enrichment module handles its own DB writes directly.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PERPLEXITY_API_KEY` | No | Perplexity API key for Sonar. If missing, enrichment is skipped with a warning. |

Add to `backend/.env`:
```
PERPLEXITY_API_KEY=pplx-xxxxxxxxxxxx
```

## Testing

### Unit tests (`tests/test_enrichment.py`)

1. **`test_enrich_skips_without_api_key`** — Returns 0 and logs warning when `PERPLEXITY_API_KEY` is unset
2. **`test_enrich_null_prices_updates_db`** — Mock Sonar returning `{price: 129.99}`, verify DB update with `price_estimated=true`
3. **`test_enrich_fixes_unknown_brand`** — Mock Sonar returning `{brand_correction: "Nike"}` for brand="Unknown", verify brand update
4. **`test_enrich_marks_attempted_on_failure`** — Mock Sonar returning null, verify `enriched_at` is still set (no retry)
5. **`test_query_sonar_handles_markdown_response`** — Verify JSON extraction from ```json...``` code blocks
6. **`test_enrich_only_fashion_items`** — Verify non-fashion items with null price are NOT enriched

### Manual testing

```bash
# Run scraper with enrichment
python scrape_debug.py <user_id>

# Check enriched items
# (via Neon console)
SELECT brand, item_name, price, price_estimated, enriched_at
FROM purchases
WHERE user_id = '<uuid>' AND price_estimated = true;
```

## Cost Estimate

- Sonar: ~$1 per 1000 queries (search + generation)
- Typical user: 10-30 null-price fashion items → $0.01-0.03 per user
- Negligible cost, especially as a one-time enrichment per item

## What This Does NOT Do

- Does NOT enrich non-fashion items (Uber, Starbucks, etc.)
- Does NOT override prices that the LLM already extracted
- Does NOT override brand names that look legitimate (only fixes "Unknown" and sender-derived generics)
- Does NOT block the scrape pipeline or session start
- Does NOT require Perplexity API key to function — graceful skip
