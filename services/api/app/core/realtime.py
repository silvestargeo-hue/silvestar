"""Module 6 — Realtime layer.

Native WebSocket hub for chat/presence/CRDT-style events (always on), plus a
LiveKit token-issuing service for WebRTC audio/video rooms when LIVEKIT_*
credentials are configured.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket


@dataclass
class Client:
    ws: WebSocket
    room: str
    user: str
    connected_at: float = field(default_factory=time.time)


class Hub:
    """Room-based pub/sub over WebSockets with presence + flood control."""

    def __init__(self) -> None:
        self.rooms: dict[str, list[Client]] = {}
        self._rate: dict[str, list[float]] = {}
        self.msg_count = 0

    async def join(self, client: Client) -> None:
        await client.ws.accept()
        self.rooms.setdefault(client.room, []).append(client)
        await self.broadcast(client.room, {
            "type": "presence", "event": "join", "user": client.user,
            "users": self.users_in(client.room),
        }, exclude=None)

    async def leave(self, client: Client) -> None:
        room_clients = self.rooms.get(client.room, [])
        if client in room_clients:
            room_clients.remove(client)
        await self.broadcast(client.room, {
            "type": "presence", "event": "leave", "user": client.user,
            "users": self.users_in(client.room),
        }, exclude=None)

    def users_in(self, room: str) -> list[str]:
        seen: list[str] = []
        for c in self.rooms.get(room, []):
            if c.user not in seen:
                seen.append(c.user)
        return seen

    async def broadcast(self, room: str, payload: dict, exclude: Client | None = None) -> None:
        data = json.dumps(payload, default=str)
        dead: list[Client] = []
        for c in list(self.rooms.get(room, [])):
            if c is exclude:
                continue
            try:
                await c.ws.send_text(data)
            except Exception:
                dead.append(c)
        for c in dead:
            await self.leave(c)

    def allow(self, client: Client, max_per_10s: int = 25) -> bool:
        now = time.time()
        key = f"{client.room}:{client.user}"
        window = [t for t in self._rate.get(key, []) if now - t < 10]
        if len(window) >= max_per_10s:
            self._rate[key] = window
            return False
        window.append(now)
        self._rate[key] = window
        return True

    async def handle_message(self, client: Client, raw: str) -> None:
        if not self.allow(client):
            await client.ws.send_text(json.dumps({"type": "error", "error": "rate_limited"}))
            return
        try:
            msg = json.loads(raw)
        except Exception:
            await client.ws.send_text(json.dumps({"type": "error", "error": "invalid_json"}))
            return
        mtype = msg.get("type", "chat")
        self.msg_count += 1
        if mtype == "chat":
            await self.broadcast(client.room, {
                "type": "chat", "user": client.user, "text": str(msg.get("text", ""))[:4000],
                "ts": time.time(),
            })
        elif mtype == "typing":
            await self.broadcast(client.room, {"type": "typing", "user": client.user}, exclude=client)
        elif mtype == "signal":
            # WebRTC signaling relay (used by LiveKit-free P2P mode too)
            await self.broadcast(client.room, {
                "type": "signal", "from": client.user, "data": msg.get("data", {}),
            }, exclude=client)
        elif mtype == "ping":
            await client.ws.send_text(json.dumps({"type": "pong", "ts": time.time()}))
        else:
            await client.ws.send_text(json.dumps({"type": "error", "error": "unknown_type"}))

    def stats(self) -> dict:
        return {
            "rooms": {r: len(cs) for r, cs in self.rooms.items()},
            "clients": sum(len(cs) for cs in self.rooms.values()),
            "messages": self.msg_count,
        }


hub = Hub()


# ------------------------------------------------------------- LiveKit -------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def livekit_token(room: str, identity: str, ttl_seconds: int = 3600,
                  api_key: str = "", api_secret: str = "") -> str:
    """LiveKit (JWT) access token — video grant for the room. HS256, no deps."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": api_key,
        "sub": identity,
        "iat": now,
        "exp": now + ttl_seconds,
        "nbf": now - 5,
        "jti": hashlib.md5(f"{identity}{now}".encode()).hexdigest(),
        "video": {"room": room, "roomJoin": True, "canPublish": True, "canSubscribe": True, "canPublishData": True},
        "name": identity,
    }
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(api_secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}"


class LiveKitService:
    """Issues tokens when configured; otherwise rooms run in P2P signaling mode."""

    def enabled(self) -> bool:
        from ..config import settings
        return settings.has_livekit

    def token_for(self, room: str, identity: str) -> dict:
        from ..config import settings
        if not settings.has_livekit:
            return {"mode": "p2p-signaling", "room": room, "identity": identity,
                    "token": "", "url": ""}
        return {
            "mode": "livekit",
            "room": room,
            "identity": identity,
            "token": livekit_token(room, identity, api_key=settings.livekit_api_key,
                                   api_secret=settings.livekit_api_secret),
            "url": settings.livekit_url,
        }


livekit = LiveKitService()
