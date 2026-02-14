"""Tests for Neon Postgres database schema and CRUD operations.

Uses Neon's serverless HTTP API (port 443) since port 5432 may be blocked
in some environments. The HTTP API uses the Neon-Connection-String header.
"""

import os
import uuid

import httpx
import pytest
import pytest_asyncio
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

DATABASE_URL = os.getenv("DATABASE_URL", "")

EXPECTED_TABLES = [
    "clothing_items",
    "purchases",
    "queue",
    "session_outfits",
    "sessions",
    "style_profiles",
    "users",
]


class NeonSQL:
    """Test helper: execute SQL via Neon's serverless HTTP endpoint."""

    def __init__(self, connection_string: str):
        self.connection_string = connection_string
        from urllib.parse import urlparse

        parsed = urlparse(connection_string)
        self.api_url = f"https://{parsed.hostname}/sql"

    async def execute(self, query: str, params: list | None = None) -> list[dict]:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                self.api_url,
                json={"query": query, "params": params or []},
                headers={
                    "Content-Type": "application/json",
                    "Neon-Connection-String": self.connection_string,
                },
            )
            data = resp.json()
            if resp.status_code != 200:
                error_msg = data.get("message", resp.text)
                raise Exception(f"SQL error: {error_msg}")
            return data.get("rows", [])

    async def fetchval(self, query: str, params: list | None = None):
        rows = await self.execute(query, params)
        if rows:
            return list(rows[0].values())[0]
        return None

    async def fetchrow(self, query: str, params: list | None = None) -> dict | None:
        rows = await self.execute(query, params)
        return rows[0] if rows else None


@pytest_asyncio.fixture(scope="session")
async def db():
    return NeonSQL(DATABASE_URL)


@pytest_asyncio.fixture
async def test_user(db):
    """Create a test user and clean up after."""
    email = f"test_{uuid.uuid4().hex[:8]}@mirrorless.test"
    rows = await db.execute(
        "INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING id",
        ["Test User", email, "+15551234567"],
    )
    user_id = rows[0]["id"]
    yield user_id
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


# ---------------------------------------------------------------------------
# Schema existence tests
# ---------------------------------------------------------------------------


async def test_connection(db):
    """Can connect to Neon Postgres and run a basic query."""
    result = await db.fetchval("SELECT 1 as val")
    assert result == 1


async def test_all_tables_exist(db):
    """All 7 expected tables exist in the public schema."""
    rows = await db.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    )
    table_names = [r["table_name"] for r in rows]
    for table in EXPECTED_TABLES:
        assert table in table_names, f"Table '{table}' not found. Got: {table_names}"


async def test_users_columns(db):
    """Users table has the expected columns."""
    rows = await db.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position"
    )
    columns = [r["column_name"] for r in rows]
    expected = ["id", "name", "email", "phone", "google_oauth_token", "poke_id", "created_at", "last_scraped_at"]
    assert columns == expected


async def test_sessions_status_check_constraint(db):
    """Sessions table rejects invalid status values."""
    email = f"constraint_{uuid.uuid4().hex[:8]}@test.com"
    user_id = await db.fetchval(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["constraint_test", email],
    )
    with pytest.raises(Exception, match="check"):
        await db.execute(
            "INSERT INTO sessions (user_id, status) VALUES ($1, $2)",
            [user_id, "invalid_status"],
        )
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


async def test_queue_status_check_constraint(db):
    """Queue table rejects invalid status values."""
    email = f"qconstraint_{uuid.uuid4().hex[:8]}@test.com"
    user_id = await db.fetchval(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["queue_constraint_test", email],
    )
    with pytest.raises(Exception, match="check"):
        await db.execute(
            "INSERT INTO queue (user_id, position, status) VALUES ($1, $2, $3)",
            [user_id, 1, "bad_status"],
        )
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])


# ---------------------------------------------------------------------------
# CRUD tests
# ---------------------------------------------------------------------------


async def test_create_and_read_user(db, test_user):
    """Can insert and fetch a user."""
    row = await db.fetchrow("SELECT * FROM users WHERE id = $1", [test_user])
    assert row is not None
    assert row["name"] == "Test User"
    assert row["phone"] == "+15551234567"
    assert row["created_at"] is not None


async def test_user_email_unique(db, test_user):
    """Users table enforces unique email constraint."""
    row = await db.fetchrow("SELECT email FROM users WHERE id = $1", [test_user])
    with pytest.raises(Exception, match="unique"):
        await db.execute(
            "INSERT INTO users (name, email) VALUES ($1, $2)",
            ["Duplicate", row["email"]],
        )


async def test_style_profile_crud(db, test_user):
    """Can create and read a style profile linked to a user."""
    await db.execute(
        "INSERT INTO style_profiles (user_id, brands, style_tags, narrative_summary) "
        "VALUES ($1, $2, $3, $4)",
        [
            test_user,
            "{Nike,Aritzia,Zara}",
            "{streetwear,minimalist}",
            "Loves clean lines with occasional bold sneaker choices.",
        ],
    )
    row = await db.fetchrow("SELECT * FROM style_profiles WHERE user_id = $1", [test_user])
    assert row is not None
    assert "Nike" in row["brands"]
    assert "minimalist" in row["style_tags"]
    assert "clean lines" in row["narrative_summary"]


async def test_purchase_crud(db, test_user):
    """Can insert and query purchases for a user."""
    await db.execute(
        "INSERT INTO purchases (user_id, brand, item_name, category, price) "
        "VALUES ($1, $2, $3, $4, $5)",
        [test_user, "Nike", "Air Max 90", "shoes", 129.99],
    )
    rows = await db.execute("SELECT * FROM purchases WHERE user_id = $1", [test_user])
    assert len(rows) == 1
    assert rows[0]["brand"] == "Nike"
    assert rows[0]["item_name"] == "Air Max 90"
    assert float(rows[0]["price"]) == 129.99


async def test_session_and_outfit_flow(db, test_user):
    """Can create a session, add outfits, and track reactions."""
    # Create session
    session_id = await db.fetchval(
        "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id",
        [test_user],
    )
    row = await db.fetchrow("SELECT * FROM sessions WHERE id = $1", [session_id])
    assert row["status"] == "active"

    # Create clothing item
    item_id = await db.fetchval(
        "INSERT INTO clothing_items (name, brand, price, category) "
        "VALUES ($1, $2, $3, $4) RETURNING id",
        ["Classic Leather Jacket", "AllSaints", 349.00, "outerwear"],
    )

    # Add outfit to session
    await db.execute(
        "INSERT INTO session_outfits (session_id, outfit_data, reaction, clothing_items) "
        "VALUES ($1, $2::jsonb, $3, $4)",
        [
            session_id,
            '{"description": "Edgy casual look", "occasion": "night out"}',
            "liked",
            f"{{{item_id}}}",
        ],
    )

    outfits = await db.execute(
        "SELECT * FROM session_outfits WHERE session_id = $1", [session_id]
    )
    assert len(outfits) == 1
    assert outfits[0]["reaction"] == "liked"

    # End session
    await db.execute(
        "UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = $1",
        [session_id],
    )
    row = await db.fetchrow("SELECT * FROM sessions WHERE id = $1", [session_id])
    assert row["status"] == "completed"
    assert row["ended_at"] is not None

    # Clean up clothing item (not cascade-deleted via user)
    await db.execute("DELETE FROM clothing_items WHERE id = $1", [item_id])


async def test_queue_crud(db, test_user):
    """Can add user to queue and update position/status."""
    await db.execute(
        "INSERT INTO queue (user_id, position) VALUES ($1, $2)",
        [test_user, 3],
    )
    row = await db.fetchrow("SELECT * FROM queue WHERE user_id = $1", [test_user])
    assert row["position"] == 3
    assert row["status"] == "waiting"

    # Move to active
    await db.execute(
        "UPDATE queue SET status = 'active' WHERE user_id = $1",
        [test_user],
    )
    row = await db.fetchrow("SELECT * FROM queue WHERE user_id = $1", [test_user])
    assert row["status"] == "active"


async def test_cascade_delete(db):
    """Deleting a user cascades to style_profiles, purchases, sessions, and queue."""
    email = f"cascade_{uuid.uuid4().hex[:8]}@mirrorless.test"
    user_id = await db.fetchval(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Cascade Test", email],
    )
    await db.execute(
        "INSERT INTO style_profiles (user_id, brands) VALUES ($1, $2)",
        [user_id, "{TestBrand}"],
    )
    await db.execute(
        "INSERT INTO purchases (user_id, brand, item_name) VALUES ($1, $2, $3)",
        [user_id, "TestBrand", "Test Item"],
    )
    session_id = await db.fetchval(
        "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id",
        [user_id],
    )
    await db.execute(
        "INSERT INTO session_outfits (session_id, outfit_data) VALUES ($1, $2::jsonb)",
        [session_id, "{}"],
    )
    await db.execute(
        "INSERT INTO queue (user_id, position) VALUES ($1, $2)",
        [user_id, 99],
    )

    # Delete user — everything should cascade
    await db.execute("DELETE FROM users WHERE id = $1", [user_id])

    assert await db.fetchrow("SELECT 1 FROM style_profiles WHERE user_id = $1", [user_id]) is None
    assert await db.fetchrow("SELECT 1 FROM purchases WHERE user_id = $1", [user_id]) is None
    assert await db.fetchrow("SELECT 1 FROM sessions WHERE user_id = $1", [user_id]) is None
    assert (
        await db.fetchrow("SELECT 1 FROM session_outfits WHERE session_id = $1", [session_id])
        is None
    )
    assert await db.fetchrow("SELECT 1 FROM queue WHERE user_id = $1", [user_id]) is None
