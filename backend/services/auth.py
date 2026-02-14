"""Google OAuth token exchange and user management."""

import json
import os

from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from google_auth_oauthlib.flow import Flow

from models.database import NeonHTTPClient

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
]


def _build_flow(redirect_uri: str) -> Flow:
    """Build an OAuth2 flow from client config."""
    client_config = {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    flow = Flow.from_client_config(client_config, scopes=SCOPES)
    flow.redirect_uri = redirect_uri
    return flow


async def exchange_google_code(auth_code: str, redirect_uri: str) -> dict:
    """Exchange an authorization code for tokens and user info.

    Returns dict with keys: access_token, refresh_token, id_token, email, name, picture
    """
    flow = _build_flow(redirect_uri)
    flow.fetch_token(code=auth_code)

    credentials = flow.credentials
    id_info = id_token.verify_oauth2_token(
        credentials.id_token,
        google_requests.Request(),
        GOOGLE_CLIENT_ID,
    )

    return {
        "access_token": credentials.token,
        "refresh_token": credentials.refresh_token,
        "id_token_jwt": credentials.id_token,
        "email": id_info.get("email", ""),
        "name": id_info.get("name", ""),
        "picture": id_info.get("picture", ""),
    }


async def upsert_user(db: NeonHTTPClient, token_data: dict) -> dict:
    """Insert or update a user based on email. Returns the user row."""
    oauth_json = json.dumps({
        "access_token": token_data["access_token"],
        "refresh_token": token_data.get("refresh_token"),
        "id_token": token_data.get("id_token_jwt"),
    })

    rows = await db.execute(
        """
        INSERT INTO users (name, email, google_oauth_token)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name,
              google_oauth_token = EXCLUDED.google_oauth_token
        RETURNING id, name, email, phone, poke_id
        """,
        [token_data["name"], token_data["email"], oauth_json],
    )
    return rows[0]
