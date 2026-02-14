# Wire Gmail Scraper to OAuth + Add Scrape Testing Screen

## Context

The data-scraping pipeline just merged (PR #3) with 10 new backend files. The Google OAuth onboarding flow was merged earlier (PR #2). They need to be wired together: the OAuth flow stores tokens in one format, but the scraper expects a different format with additional fields (`client_id`, `client_secret`, `token_uri`) needed for token refresh. We also need a frontend testing screen so the user can trigger a scrape and see results after signing in.

## Problem: Token Format Mismatch

**OAuth stores** (`services/auth.py:66-70`):
```json
{"access_token": "ya29...", "refresh_token": "1//...", "id_token": "eyJ..."}
```

**Scraper expects** (`scraper/gmail_auth.py:48-54`):
```json
{"access_token": "...", "refresh_token": "...", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "...", "client_secret": "..."}
```

Without `client_id`/`client_secret`/`token_uri`, `Credentials.refresh()` will fail when the access token expires (~1hr).

## Plan

### 1. Fix token storage in OAuth upsert

**File**: `backend/services/auth.py` — `upsert_user()` function (line 64-83)

Add `client_id`, `client_secret`, and `token_uri` to the stored JSONB:

```python
oauth_json = json.dumps({
    "access_token": token_data["access_token"],
    "refresh_token": token_data.get("refresh_token"),
    "id_token": token_data.get("id_token_jwt"),
    "client_id": GOOGLE_CLIENT_ID,
    "client_secret": GOOGLE_CLIENT_SECRET,
    "token_uri": "https://oauth2.googleapis.com/token",
})
```

This is backwards-compatible — existing fields stay, new ones are added.

### 2. Add `scrapeGmail` API helper

**File**: `frontend/src/lib/api.ts`

Add a new function:
```typescript
export interface ScrapeResult {
  purchases: Array<{brand: string; item_name: string; category: string | null; price: number | null; date: string | null}>;
  brand_freq: Record<string, number>;
  profile: {brands: string[]; price_range: {min: number; max: number; avg: number}; style_tags: string[]; narrative_summary: string | null};
}

export function scrapeGmail(userId: string) {
  return request<ScrapeResult>("/api/scrape/start", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}
```

### 3. Create ScrapeResults component (full debug view with progress steps)

**File**: `frontend/src/components/phone/ScrapeResults.tsx` (new)

**Progress steps** (uses Socket.io `scrape_progress` events from `scraper/socket_events.py`):
- Step 1: "Searching receipts..." → shows when scrape starts
- Step 2: "Parsing purchases..." → shows when receipts found
- Step 3: "Building your style profile..." → shows when purchases extracted
- Step 4: Complete → shows full results

Connect to Socket.io, join user's room, listen for `scrape_progress` and `scrape_complete` events.

**Full debug view displays**:
- Raw purchase table: brand, item name, price, date, category — each as a row
- Brand frequency list with counts (e.g. "Nike: 5, Zara: 3")
- Style profile: price range (min/max/avg), style tags as pills, narrative summary text
- Total count header: "Found X purchases from Y brands"
- "Continue" button to proceed to poke step

Calls `scrapeGmail(userId)` on mount to trigger fast scrape. Shows progress via Socket.io, then renders results from the HTTP response.

### 4. Add "scrape" step to phone page flow

**File**: `frontend/src/app/phone/page.tsx`

Insert a new step between `profile` and `poke`:

```
signin → profile → scrape → poke → queue
```

The step type becomes: `type Step = "signin" | "profile" | "scrape" | "poke" | "queue";`

After profile completes → set step to `"scrape"`. After scrape completes → set step to `"poke"`.

### 5. Fix uvicorn startup for Socket.io

**Note**: `main.py` now exports `socket_app` (the ASGI wrapper), so the dev server command changes:

```bash
uvicorn main:socket_app --reload   # NOT main:app
```

## Files to Modify/Create

| # | File | Action | Change |
|---|------|--------|--------|
| 1 | `backend/services/auth.py` | Modify | Add `client_id`, `client_secret`, `token_uri` to stored token JSON |
| 2 | `frontend/src/lib/api.ts` | Modify | Add `ScrapeResult` type + `scrapeGmail()` function |
| 3 | `frontend/src/components/phone/ScrapeResults.tsx` | Create | Scrape results display component |
| 4 | `frontend/src/app/phone/page.tsx` | Modify | Add "scrape" step between profile and poke |

## Verification

1. Start backend: `cd backend && uvicorn main:socket_app --reload`
2. Start frontend: `cd frontend && npm run dev`
3. Open `/phone`, sign in with Google, fill profile
4. See scrape screen — should show "Scanning..." then display purchases found
5. Verify purchases appear with brand, item, price
6. Continue through poke → queue as before
7. `npm run build` — verify TypeScript compiles
