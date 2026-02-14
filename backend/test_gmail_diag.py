"""Diagnostic script to test Gmail API access end-to-end.

Usage: cd backend && python test_gmail_diag.py <user_id>
"""

import asyncio
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()


async def run_diagnostics(user_id: str):
    print(f"\n{'='*50}")
    print("Gmail Scraper Diagnostics")
    print(f"{'='*50}\n")

    # Step 1: Check env vars
    print("[1/5] Checking environment variables...")
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "")
    if not client_id:
        print("  FAIL: GOOGLE_CLIENT_ID is not set")
        return
    if not client_secret:
        print("  FAIL: GOOGLE_CLIENT_SECRET is not set")
        return
    print(f"  OK: GOOGLE_CLIENT_ID = {client_id[:20]}...")
    print(f"  OK: GOOGLE_CLIENT_SECRET = {'*' * len(client_secret)}")

    # Step 2: Fetch token from DB
    print(f"\n[2/5] Fetching stored token for user {user_id}...")
    from models.database import get_neon_client

    db = await get_neon_client()
    try:
        rows = await db.execute(
            "SELECT google_oauth_token FROM users WHERE id = $1", [user_id]
        )
    finally:
        await db.close()

    if not rows:
        print(f"  FAIL: No user found with id = {user_id}")
        return

    raw_token = rows[0].get("google_oauth_token")
    if not raw_token:
        print("  FAIL: User exists but google_oauth_token is NULL")
        return

    token_data = raw_token if isinstance(raw_token, dict) else json.loads(raw_token)
    print("  OK: Token retrieved from database")

    # Step 3: Check token fields
    print("\n[3/5] Checking token fields...")
    required = ["access_token", "refresh_token", "client_id", "client_secret", "token_uri"]
    for field in required:
        val = token_data.get(field)
        if val:
            display = f"{str(val)[:30]}..." if len(str(val)) > 30 else val
            print(f"  OK: {field} = {display}")
        else:
            print(f"  MISSING: {field} — scraper needs this for token refresh")

    # Step 4: Build credentials and check validity
    print("\n[4/5] Building Google credentials...")
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request

        creds = Credentials(
            token=token_data.get("access_token"),
            refresh_token=token_data.get("refresh_token"),
            token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=token_data.get("client_id"),
            client_secret=token_data.get("client_secret"),
        )
        print(f"  Token valid: {creds.valid}")
        print(f"  Token expired: {creds.expired}")

        if creds.expired and creds.refresh_token:
            print("  Attempting token refresh...")
            creds.refresh(Request())
            print(f"  OK: Token refreshed. New expiry: {creds.expiry}")
        elif not creds.expired:
            print("  OK: Token is still valid, no refresh needed")
    except Exception as e:
        print(f"  FAIL: Credentials error — {e}")
        return

    # Step 5: Try a Gmail API call
    print("\n[5/5] Testing Gmail API call...")
    try:
        from googleapiclient.discovery import build

        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        print(f"  OK: Gmail API working!")
        print(f"  Email: {profile.get('emailAddress')}")
        print(f"  Total messages: {profile.get('messagesTotal')}")
        print(f"  Total threads: {profile.get('threadsTotal')}")
    except Exception as e:
        error_str = str(e)
        if "accessNotConfigured" in error_str or "has not been used" in error_str:
            print(f"  FAIL: Gmail API is NOT ENABLED in your Google Cloud project")
            print(f"  Fix: Visit https://console.developers.google.com/apis/api/gmail.googleapis.com/overview")
            print(f"        and click 'Enable', then wait 2-3 minutes")
        elif "invalid_grant" in error_str:
            print(f"  FAIL: Refresh token is invalid/revoked. User needs to re-authenticate.")
        elif "SSL" in error_str:
            print(f"  FAIL: SSL error — {e}")
            print(f"  This usually follows a 403 error. Fix the underlying issue first.")
        else:
            print(f"  FAIL: {e}")

    print(f"\n{'='*50}")
    print("Diagnostics complete")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python test_gmail_diag.py <user_id>")
        sys.exit(1)
    asyncio.run(run_diagnostics(sys.argv[1]))
