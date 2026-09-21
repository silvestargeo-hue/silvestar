"""Module 8 — Cache layer.

Production: Redis (redis-py async). Fallback: in-process TTL cache with the
same API (get/set/delete/incr/expire).
"""
from __future__ import annotations

import time
from typing import Any, Optional

from ..config import settings


class MemoryCache:
    def __init__(self) -> None:
        self._data: dict[str, tuple[Any, float | None]] = {}

    def _expired(self, exp: float | None) -> bool:
        return exp is not None and time.time() > exp

    async def get(self, key: str) -> Optional[str]:
        item = self._data.get(key)
        if not item:
            return None
        val, exp = item
        if self._expired(exp):
            self._data.pop(key, None)
            return None
        return val

    async def set(self, key: str, value: str, ttl: int | None = None) -> None:
        self._data[key] = (value, time.time() + ttl if ttl else None)

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)

    async def incr(self, key: str, ttl: int | None = None) -> int:
        cur = await self.get(key)
        n = (int(cur) if cur else 0) + 1
        await self.set(key, str(n), ttl)
        return n

    async def health(self) -> dict:
        return {"mode": "embedded-memory", "ok": True, "keys": len(self._data)}


class RedisCache:
    def __init__(self, url: str) -> None:
        import redis.asyncio as aioredis  # type: ignore

        self._r = aioredis.from_url(url, decode_responses=True)

    async def get(self, key: str) -> Optional[str]:
        return await self._r.get(key)

    async def set(self, key: str, value: str, ttl: int | None = None) -> None:
        await self._r.set(key, value, ex=ttl)

    async def delete(self, key: str) -> None:
        await self._r.delete(key)

    async def incr(self, key: str, ttl: int | None = None) -> int:
        n = await self._r.incr(key)
        if ttl and n == 1:
            await self._r.expire(key, ttl)
        return n

    async def health(self) -> dict:
        await self._r.ping()
        return {"mode": "redis", "ok": True}


class Cache:
    def __init__(self) -> None:
        self._impl: Any = None

    async def connect(self) -> None:
        if settings.has_redis:
            try:
                self._impl = RedisCache(settings.redis_url)
                await self._impl.health()
                return
            except Exception:
                self._impl = None
        self._impl = MemoryCache()

    async def get(self, key: str) -> Optional[str]:
        return await self._impl.get(key)

    async def set(self, key: str, value: str, ttl: int | None = None) -> None:
        await self._impl.set(key, value, ttl)

    async def delete(self, key: str) -> None:
        await self._impl.delete(key)

    async def incr(self, key: str, ttl: int | None = None) -> int:
        return await self._impl.incr(key, ttl)

    async def health(self) -> dict:
        return await self._impl.health()

    async def close(self) -> None:
        try:
            await self._impl._r.aclose()  # type: ignore[attr-defined]
        except AttributeError:
            pass


cache = Cache()
