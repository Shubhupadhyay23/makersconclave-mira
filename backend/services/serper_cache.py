"""Simple in-memory cache for Serper results per session."""

import time
from typing import Dict, Optional, Tuple


class SerperCache:
    """In-memory cache for Serper results with 10-minute TTL."""

    def __init__(self, ttl_seconds: int = 600):
        self._cache: Dict[str, Tuple[Dict, float]] = {}
        self.ttl_seconds = ttl_seconds

    def get(self, session_id: str) -> Optional[Dict]:
        """Get cached results if not expired."""
        if session_id not in self._cache:
            return None

        results, timestamp = self._cache[session_id]
        if time.time() - timestamp > self.ttl_seconds:
            del self._cache[session_id]
            return None

        return results

    def set(self, session_id: str, results: Dict):
        """Cache results for session."""
        self._cache[session_id] = (results, time.time())

    def invalidate(self, session_id: str):
        """Clear cache for session."""
        if session_id in self._cache:
            del self._cache[session_id]

    def clear_expired(self):
        """Remove all expired cache entries."""
        now = time.time()
        expired_keys = [
            key
            for key, (_, timestamp) in self._cache.items()
            if now - timestamp > self.ttl_seconds
        ]
        for key in expired_keys:
            del self._cache[key]


# Global cache instance
serper_cache = SerperCache()
