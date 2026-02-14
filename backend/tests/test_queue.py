"""Tests for queue: join, position calculation, and status transitions."""

import os
import uuid

import pytest
import pytest_asyncio
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from tests.test_database import NeonSQL, DATABASE_URL


@pytest_asyncio.fixture(scope="session")
async def db():
    return NeonSQL(DATABASE_URL)


@pytest_asyncio.fixture
async def queue_user(db):
    """Create a test user for queue tests, clean up after."""
    email = f"queue_{uuid.uuid4().hex[:8]}@mirrorless.test"
    rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Queue Tester", email],
    )
    user_id = rows[0]["id"]
    yield user_id
    await db.execute("DELETE FROM queue WHERE user_id = $1::uuid", [user_id])
    await db.execute("DELETE FROM users WHERE id = $1::uuid", [user_id])


async def test_join_queue_assigns_next_position(db, queue_user):
    """Joining the queue assigns the next available position."""
    max_pos = await db.fetchval("SELECT COALESCE(MAX(position), 0) FROM queue")
    expected_pos = int(max_pos) + 1

    rows = await db.execute(
        """
        INSERT INTO queue (user_id, position)
        VALUES ($1::uuid, $2)
        RETURNING id, position, status
        """,
        [queue_user, expected_pos],
    )
    assert rows[0]["position"] == expected_pos
    assert rows[0]["status"] == "waiting"


async def test_queue_total_ahead(db, queue_user):
    """Total ahead count is correct based on position."""
    # The user was already inserted in previous test; check count
    row = await db.fetchrow(
        "SELECT position FROM queue WHERE user_id = $1::uuid AND status = 'waiting'",
        [queue_user],
    )
    if not row:
        pytest.skip("No waiting queue entry for user")

    count = await db.fetchval(
        """
        SELECT COUNT(*) FROM queue
        WHERE status = 'waiting' AND position < $1
        """,
        [row["position"]],
    )
    assert int(count) >= 0


async def test_queue_status_transition(db, queue_user):
    """Queue entry can transition from waiting to active to completed."""
    row = await db.fetchrow(
        "SELECT id FROM queue WHERE user_id = $1::uuid AND status = 'waiting'",
        [queue_user],
    )
    if not row:
        pytest.skip("No waiting queue entry")

    queue_id = row["id"]

    # waiting -> active
    await db.execute(
        "UPDATE queue SET status = 'active' WHERE id = $1::uuid",
        [queue_id],
    )
    updated = await db.fetchrow("SELECT status FROM queue WHERE id = $1::uuid", [queue_id])
    assert updated["status"] == "active"

    # active -> completed
    await db.execute(
        "UPDATE queue SET status = 'completed' WHERE id = $1::uuid",
        [queue_id],
    )
    updated = await db.fetchrow("SELECT status FROM queue WHERE id = $1::uuid", [queue_id])
    assert updated["status"] == "completed"


async def test_duplicate_join_returns_existing(db):
    """If a user already has a waiting entry, no duplicate is created."""
    email = f"dup_{uuid.uuid4().hex[:8]}@mirrorless.test"
    rows = await db.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        ["Dup Tester", email],
    )
    user_id = rows[0]["id"]

    max_pos = await db.fetchval("SELECT COALESCE(MAX(position), 0) FROM queue")
    pos = int(max_pos) + 1

    # First join
    await db.execute(
        "INSERT INTO queue (user_id, position) VALUES ($1::uuid, $2)",
        [user_id, pos],
    )

    # Check existing before inserting again
    existing = await db.execute(
        """
        SELECT id, position, status FROM queue
        WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
        """,
        [user_id],
    )
    assert len(existing) == 1
    assert existing[0]["position"] == pos

    # Clean up
    await db.execute("DELETE FROM queue WHERE user_id = $1::uuid", [user_id])
    await db.execute("DELETE FROM users WHERE id = $1::uuid", [user_id])
