"""Tests for auth service: user upsert and profile update."""

import json
import os
import uuid

import pytest
import pytest_asyncio
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# Reuse NeonSQL helper from test_database
from tests.test_database import NeonSQL, DATABASE_URL


@pytest_asyncio.fixture(scope="session")
async def db():
    return NeonSQL(DATABASE_URL)


@pytest_asyncio.fixture
async def test_email():
    """Generate a unique test email."""
    return f"auth_test_{uuid.uuid4().hex[:8]}@mirrorless.test"


async def test_upsert_creates_new_user(db, test_email):
    """Upsert inserts a new user when email doesn't exist."""
    oauth_json = json.dumps({"access_token": "tok_abc", "refresh_token": "ref_abc"})

    rows = await db.execute(
        """
        INSERT INTO users (name, email, google_oauth_token)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name,
              google_oauth_token = EXCLUDED.google_oauth_token
        RETURNING id, name, email, phone, poke_id
        """,
        ["New User", test_email, oauth_json],
    )
    assert len(rows) == 1
    assert rows[0]["name"] == "New User"
    assert rows[0]["email"] == test_email
    assert rows[0]["phone"] is None

    # Clean up
    await db.execute("DELETE FROM users WHERE email = $1", [test_email])


async def test_upsert_updates_existing_user(db, test_email):
    """Upsert updates tokens for an existing user."""
    oauth_v1 = json.dumps({"access_token": "tok_v1"})
    oauth_v2 = json.dumps({"access_token": "tok_v2"})

    # First insert
    await db.execute(
        """
        INSERT INTO users (name, email, google_oauth_token)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name,
              google_oauth_token = EXCLUDED.google_oauth_token
        RETURNING id
        """,
        ["User V1", test_email, oauth_v1],
    )

    # Second upsert with same email
    rows = await db.execute(
        """
        INSERT INTO users (name, email, google_oauth_token)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name,
              google_oauth_token = EXCLUDED.google_oauth_token
        RETURNING id, name, email, google_oauth_token
        """,
        ["User V2", test_email, oauth_v2],
    )
    assert rows[0]["name"] == "User V2"
    token = rows[0]["google_oauth_token"]
    if isinstance(token, str):
        token = json.loads(token)
    assert token["access_token"] == "tok_v2"

    # Clean up
    await db.execute("DELETE FROM users WHERE email = $1", [test_email])


async def test_profile_update(db):
    """Can update name and phone for an existing user."""
    email = f"profile_{uuid.uuid4().hex[:8]}@mirrorless.test"
    rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Original Name", email],
    )
    user_id = rows[0]["id"]

    updated = await db.execute(
        """
        UPDATE users SET name = $1, phone = $2
        WHERE id = $3::uuid
        RETURNING id, name, email, phone, poke_id
        """,
        ["Updated Name", "+15559876543", user_id],
    )
    assert updated[0]["name"] == "Updated Name"
    assert updated[0]["phone"] == "+15559876543"

    # Clean up
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


async def test_profile_update_nonexistent_user(db):
    """Profile update returns empty for a non-existent user ID."""
    fake_id = str(uuid.uuid4())
    rows = await db.execute(
        """
        UPDATE users SET name = $1, phone = $2
        WHERE id = $3::uuid
        RETURNING id
        """,
        ["Nobody", "+10000000000", fake_id],
    )
    assert len(rows) == 0
