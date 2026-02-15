"""Database connection management.

Supports two modes:
- asyncpg pool: Used when port 5432 is reachable (production on Render)
- Neon serverless HTTP: Used when port 5432 is blocked (local dev)
"""

import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime
from decimal import Decimal
from urllib.parse import urlparse

import httpx


class _ParamEncoder(json.JSONEncoder):
    """JSON encoder that handles date, datetime, and Decimal types for Neon HTTP API."""

    def default(self, o):
        if isinstance(o, (date, datetime)):
            return o.isoformat()
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)


from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "")


def _get_neon_http_url() -> str:
    """Extract the HTTPS SQL endpoint from the DATABASE_URL."""
    parsed = urlparse(DATABASE_URL)
    return f"https://{parsed.hostname}/sql"


class NeonHTTPClient:
    """Thin wrapper around Neon's serverless HTTP SQL API."""

    def __init__(self, connection_string=None):
        self.connection_string = connection_string or DATABASE_URL
        parsed = urlparse(self.connection_string)
        self.api_url = f"https://{parsed.hostname}/sql"
        # Disable keepalive to avoid event-loop binding issues with connection reuse
        self._client = httpx.AsyncClient(
            timeout=30,
            limits=httpx.Limits(max_keepalive_connections=0),
        )

    async def execute(self, query: str, params=None):
        """Execute a SQL query and return rows as dicts."""
        payload = json.dumps(
            {"query": query, "params": params or []}, cls=_ParamEncoder
        )
        resp = await self._client.post(
            self.api_url,
            content=payload,
            headers={
                "Content-Type": "application/json",
                "Neon-Connection-String": self.connection_string,
            },
        )
        if resp.status_code >= 400:
            # Surface the actual SQL error from Neon instead of a generic HTTP error
            try:
                body = resp.json()
                detail = body.get("message") or body.get("error") or resp.text
            except Exception:
                detail = resp.text
            raise httpx.HTTPStatusError(
                f"Neon SQL error ({resp.status_code}): {detail}",
                request=resp.request,
                response=resp,
            )
        data = resp.json()
        return data.get("rows", [])

    async def fetchval(self, query: str, params=None):
        """Execute a query and return the first column of the first row."""
        rows = await self.execute(query, params)
        if rows:
            first_row = rows[0]
            return list(first_row.values())[0]
        return None

    async def close(self):
        await self._client.aclose()


async def get_neon_client() -> NeonHTTPClient:
    """Create a NeonHTTPClient instance."""
    return NeonHTTPClient()


# For production (Render), use asyncpg pool
async def get_pool():
    """Create and return an asyncpg connection pool. Use in production."""
    import asyncpg

    return await asyncpg.create_pool(
        DATABASE_URL,
        min_size=2,
        max_size=10,
        ssl="require",
    )


@asynccontextmanager
async def get_connection(pool):
    """Acquire a connection from an asyncpg pool."""
    import asyncpg

    conn = await pool.acquire()
    try:
        yield conn
    finally:
        await pool.release(conn)
