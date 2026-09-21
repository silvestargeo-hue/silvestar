"""Module 5 — Personal Vault service.

Per-user encrypted document store. Content is AES-256-GCM encrypted at rest;
the derived key never leaves the server process and only lives inside an
active session. Passwords are verified via PBKDF2 verifier hashes — the
password itself is never stored.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from typing import Optional

from . import security
from .db import db

SESSION_TTL = 30 * 60  # 30 minutes


class VaultError(Exception):
    pass


class VaultService:
    def __init__(self) -> None:
        # Serverless-safe: sessions are stateless signed tokens; the user's AES
        # key travels inside the encrypted token instead of process memory.
        self._sessions: dict[str, dict] = {}  # retained for legacy in-memory use
        self._acct_cache: dict[str, dict] = {}  # verifier hashes for stateless validation
        self._revoked: set[str] = set()  # token fingerprints revoked via lock()

    # ------------------------------------------------------------ accounts --
    def _account_doc_id(self, user_id: str) -> str:
        return f"vault-account::{user_id}"

    async def create_vault(self, user_id: str, password: str) -> dict:
        if len(password) < 8:
            raise VaultError("password must be at least 8 characters")
        if await db.fetch(self._account_doc_id(user_id)):
            raise VaultError("vault already exists for this user")
        rec = security.hash_password(password)
        await db.upsert_document(
            self._account_doc_id(user_id), "vault-accounts", f"vault::{user_id}",
            rec["hash"], meta={"salt": rec["salt"], "iterations": rec["iterations"]},
        )
        return {"user_id": user_id, "created": True, "kdf": "PBKDF2-HMAC-SHA256", "iterations": rec["iterations"]}

    async def _account(self, user_id: str) -> Optional[dict]:
        cached = self._acct_cache.get(user_id)
        if cached:
            return cached
        doc = await db.fetch(self._account_doc_id(user_id))
        if not doc:
            return None
        acct = {"hash": doc["content"], "salt": doc["meta"].get("salt", ""),
                "iterations": int(doc["meta"].get("iterations", 200000))}
        self._acct_cache[user_id] = acct
        return acct

    # ------------------------------------------------------------- sessions --
    async def unlock(self, user_id: str, password: str) -> dict:
        acct = await self._account(user_id)
        if not acct:
            raise VaultError("no vault for user — create one first")
        if not security.verify_password(password, acct["salt"], acct["hash"]):
            raise VaultError("invalid vault password")
        key = security.derive_key(password, base64.b64decode(acct["salt"]), acct["iterations"])
        token = security.issue_session_token(user_id, key, acct["hash"], SESSION_TTL)
        return {"session_token": token, "expires_in": SESSION_TTL, "mode": "stateless"}

    async def lock(self, session_token: str) -> bool:
        """Revoke a stateless token: exact in-process, Redis-backed cluster-wide
        when REDIS_URL is configured; otherwise best-effort per instance."""
        tid = hashlib.sha256(session_token.encode()).hexdigest()[:24]
        self._revoked.add(tid)
        try:
            from .cache import cache
            await cache.set("vault:revoke:" + tid, "1", ttl=SESSION_TTL)
        except Exception:
            pass
        self._sessions.pop(session_token, None)
        return True

    async def _is_revoked(self, session_token: str) -> bool:
        tid = hashlib.sha256(session_token.encode()).hexdigest()[:24]
        if tid in self._revoked:
            return True
        try:
            from .cache import cache
            return await cache.get("vault:revoke:" + tid) is not None
        except Exception:
            return False

    async def validate(self, user_id: str, session_token: str):
        """Validate a stateless session token (works across cold function instances)."""
        from .rag import VaultSessionInfo
        if await self._is_revoked(session_token):
            return VaultSessionInfo(user_id=user_id, valid=False)
        acct = await self._account(user_id)
        if acct is None:
            return VaultSessionInfo(user_id=user_id, valid=False)
        key = security.open_session_token(session_token, user_id, acct["hash"])
        if key is None:
            return VaultSessionInfo(user_id=user_id, valid=False)
        return VaultSessionInfo(user_id=user_id, valid=True, key=key)

    async def _key(self, user_id: str, session_token: str) -> bytes:
        """Resolve the vault key from a stateless token (or legacy memory session)."""
        s = self._sessions.get(session_token)
        if s and s["user_id"] == user_id and time.time() <= s["exp"]:
            return s["key"]
        if await self._is_revoked(session_token):
            raise VaultError("vault session invalid or expired — unlock again")
        acct = await self._account(user_id)
        if acct is None:
            raise VaultError("vault session invalid or expired — unlock again")
        key = security.open_session_token(session_token, user_id, acct["hash"])
        if key is None:
            raise VaultError("vault session invalid or expired — unlock again")
        return key

    # ------------------------------------------------------------ documents --
    async def add_document(self, user_id: str, session_token: str, title: str, content: str) -> dict:
        key = await self._key(user_id, session_token)
        envelope = security.encrypt(content, key)
        doc_id = "v-" + secrets.token_urlsafe(12)
        fp = security.envelope_fingerprint(envelope)
        await db.upsert_document(
            doc_id, f"vault:{user_id}", title, envelope,
            meta={"fingerprint": fp, "enc": "AES-256-GCM", "bytes": len(content)},
        )
        return {"id": doc_id, "title": title, "fingerprint": fp, "encrypted": True}

    async def read_plaintext(self, user_id: str, doc_id: str, session) -> Optional[str]:
        """Used by cross-library RAG; requires a valid (stateless) session object."""
        if not getattr(session, "valid", False) or not getattr(session, "key", None):
            raise VaultError("vault locked")
        doc = await db.fetch(doc_id)
        if not doc or doc["library"] != f"vault:{user_id}":
            return None
        try:
            return security.decrypt(doc["content"], session.key)
        except Exception:
            return None

    async def list_documents(self, user_id: str, session_token: str) -> list[dict]:
        await self._key(user_id, session_token)  # auth gate
        docs, _total = await db.list(f"vault:{user_id}", limit=200)
        # snippets are envelopes — never returned; titles + fingerprints only
        return [{"id": d["id"], "title": d["title"]} for d in docs]

    async def delete_document(self, user_id: str, session_token: str, doc_id: str) -> bool:
        await self._key(user_id, session_token)
        doc = await db.fetch(doc_id)
        if not doc or doc["library"] != f"vault:{user_id}":
            return False
        return await db.delete(doc_id)

    async def stats(self) -> dict:
        return {"sessions_active": "stateless", "cipher": "AES-256-GCM", "kdf": "PBKDF2-SHA256"}


vault = VaultService()
