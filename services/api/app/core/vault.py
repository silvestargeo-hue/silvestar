"""Module 5 — Personal Vault service.

Per-user encrypted document store. Content is AES-256-GCM encrypted at rest;
the derived key never leaves the server process and only lives inside an
active session. Passwords are verified via PBKDF2 verifier hashes — the
password itself is never stored.
"""
from __future__ import annotations

import base64
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
        self._sessions: dict[str, dict] = {}

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
        doc = await db.fetch(self._account_doc_id(user_id))
        if not doc:
            return None
        return {"hash": doc["content"], "salt": doc["meta"].get("salt", ""),
                "iterations": int(doc["meta"].get("iterations", 200000))}

    # ------------------------------------------------------------- sessions --
    async def unlock(self, user_id: str, password: str) -> dict:
        acct = await self._account(user_id)
        if not acct:
            raise VaultError("no vault for user — create one first")
        if not security.verify_password(password, acct["salt"], acct["hash"]):
            raise VaultError("invalid vault password")
        key = security.derive_key(password, base64.b64decode(acct["salt"]), acct["iterations"])
        token = secrets.token_urlsafe(32)
        self._sessions[token] = {"user_id": user_id, "key": key, "exp": time.time() + SESSION_TTL}
        return {"session_token": token, "expires_in": SESSION_TTL}

    async def lock(self, session_token: str) -> bool:
        return self._sessions.pop(session_token, None) is not None

    def validate(self, user_id: str, session_token: str):
        """Returns VaultSessionInfo for RAG; purges expired sessions."""
        s = self._sessions.get(session_token)
        if not s or s["user_id"] != user_id or time.time() > s["exp"]:
            self._sessions.pop(session_token, None)
            from .rag import VaultSessionInfo
            return VaultSessionInfo(user_id=user_id, valid=False)
        from .rag import VaultSessionInfo
        return VaultSessionInfo(user_id=user_id, valid=True, expires_at=s["exp"])

    def _key(self, user_id: str, session_token: str) -> bytes:
        s = self._sessions.get(session_token)
        if not s or s["user_id"] != user_id or time.time() > s["exp"]:
            self._sessions.pop(session_token, None)
            raise VaultError("vault session invalid or expired — unlock again")
        return s["key"]

    # ------------------------------------------------------------ documents --
    async def add_document(self, user_id: str, session_token: str, title: str, content: str) -> dict:
        key = self._key(user_id, session_token)
        envelope = security.encrypt(content, key)
        doc_id = "v-" + secrets.token_urlsafe(12)
        fp = security.envelope_fingerprint(envelope)
        await db.upsert_document(
            doc_id, f"vault:{user_id}", title, envelope,
            meta={"fingerprint": fp, "enc": "AES-256-GCM", "bytes": len(content)},
        )
        return {"id": doc_id, "title": title, "fingerprint": fp, "encrypted": True}

    async def read_plaintext(self, user_id: str, doc_id: str, session) -> Optional[str]:
        """Used by cross-library RAG; requires a valid session object."""
        if not getattr(session, "valid", False):
            raise VaultError("vault locked")
        token = None
        for t, s in self._sessions.items():
            if s["user_id"] == user_id:
                token = t
                break
        if token is None:
            raise VaultError("vault locked")
        key = self._key(user_id, token)
        doc = await db.fetch(doc_id)
        if not doc or doc["library"] != f"vault:{user_id}":
            return None
        try:
            return security.decrypt(doc["content"], key)
        except Exception:
            return None

    async def list_documents(self, user_id: str, session_token: str) -> list[dict]:
        self._key(user_id, session_token)  # auth gate
        docs, _total = await db.list(f"vault:{user_id}", limit=200)
        # snippets are envelopes — never returned; titles + fingerprints only
        return [{"id": d["id"], "title": d["title"]} for d in docs]

    async def delete_document(self, user_id: str, session_token: str, doc_id: str) -> bool:
        self._key(user_id, session_token)
        doc = await db.fetch(doc_id)
        if not doc or doc["library"] != f"vault:{user_id}":
            return False
        return await db.delete(doc_id)

    async def stats(self) -> dict:
        sessions = len(self._sessions)
        return {"sessions_active": sessions, "cipher": "AES-256-GCM", "kdf": "PBKDF2-SHA256"}


vault = VaultService()
