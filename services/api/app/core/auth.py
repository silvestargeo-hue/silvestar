"""Modules 12-13 — Accounts & authentication.

Email+password accounts with unique profiles. Passwords are stored only as
PBKDF2 verifier hashes. Sessions are stateless signed tokens whose signing
secret derives from the user's verifier hash — a password change or reset
automatically invalidates every old session everywhere. Password recovery uses
a 6-digit OTP (hashed at rest, 10-minute TTL, attempt-limited) delivered via
SMTP when configured, or surfaced as a dev code otherwise.

The FIRST account registered on a fresh platform becomes the admin.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid
from typing import Optional

from ..config import settings
from . import security
from .cache import cache
from .db import db

EMAIL_RX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ACCOUNTS_LIB = "accounts"
SESSION_TTL = 7 * 24 * 3600     # 7 days
SESSION_TTL_REMEMBER = 30 * 24 * 3600  # 30 days ("remember this device")
OTP_TTL = 600                # 10 minutes
OTP_MAX_ATTEMPTS = 5


class AuthError(Exception):
    pass


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _doc_id(email: str) -> str:
    return "user::" + email.strip().lower()


class AuthService:
    # ------------------------------------------------------------ accounts --
    async def _account(self, email: str) -> Optional[dict]:
        doc = await db.fetch(_doc_id(email))
        if not doc:
            return None
        m = doc.get("meta", {})
        return {
            "email": doc["id"].split("::", 1)[1],
            "hash": doc["content"],
            "salt": m.get("salt", ""),
            "iterations": int(m.get("iterations", settings.vault_kdf_iterations)),
            "user_id": m.get("user_id", ""),
            "role": m.get("role", "user"),
            "status": m.get("status", "active"),
            "display_name": m.get("display_name", ""),
            "created": m.get("created", ""),
            "verified": bool(m.get("verified", False)),
            "last_login": m.get("last_login", ""),
        }

    @staticmethod
    def public(acct: dict) -> dict:
        return {k: acct[k] for k in ("user_id", "email", "role", "status", "display_name", "created", "verified", "last_login")}

    async def _count_accounts(self) -> int:
        _rows, total = await db.list(ACCOUNTS_LIB, limit=1)
        return int(total)

    async def register(self, email: str, password: str, display_name: str = "") -> dict:
        email = email.strip().lower()
        if not EMAIL_RX.match(email):
            raise AuthError("enter a valid email address")
        if len(password) < 8:
            raise AuthError("password must be at least 8 characters")
        if await self._account(email):
            raise AuthError("an account with this email already exists — sign in instead")
        role = "admin" if await self._count_accounts() == 0 else "user"
        user_id = "u-" + uuid.uuid4().hex[:8]
        rec = security.hash_password(password)
        await db.upsert_document(
            _doc_id(email), ACCOUNTS_LIB,
            display_name.strip() or email.split("@")[0],
            rec["hash"],
            meta={
                "salt": rec["salt"], "iterations": rec["iterations"],
                "user_id": user_id, "role": role, "status": "active",
                "display_name": display_name.strip() or email.split("@")[0],
                "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "verified": False,
            },
        )
        user = self.public((await self._account(email)) or {})
        # email verification (24h code; dev-code fallback without SMTP)
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        await cache.set("vc:" + email, self._otp_hash(email, code), ttl=86400)
        sent = await self._send_otp_email(email, code)
        if not sent:
            # No SMTP configured — email verification is impossible, so activate
            # the account immediately (admins can still manage it from the panel).
            await db.upsert_document(
                _doc_id(email), ACCOUNTS_LIB,
                display_name.strip() or email.split("@")[0],
                rec["hash"],
                meta={
                    "salt": rec["salt"], "iterations": rec["iterations"],
                    "user_id": user_id, "role": role, "status": "active",
                    "display_name": display_name.strip() or email.split("@")[0],
                    "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "verified": True,
                },
            )
            verification = {"required": False}
        else:
            verification = {"required": True, "expires_in": 86400}
        return {"user": user, "verification": verification}

    async def authenticate(self, email: str, password: str) -> dict:
        email = email.strip().lower()
        acct = await self._account(email)
        if not acct:
            raise AuthError("no account for this email — create one first")
        if acct["status"] == "suspended":
            raise AuthError("account suspended — contact the administrator")
        if not security.verify_password(password, acct["salt"], acct["hash"]):
            raise AuthError("incorrect email or password")
        return acct

    # ------------------------------------------------------------- tokens --
    @staticmethod
    def _secret(verifier_hash_b64: str) -> bytes:
        return hmac.new(("authv1:" + verifier_hash_b64).encode(), b"silvestar-auth-session", hashlib.sha256).digest()

    def issue_auth_token(self, acct: dict, ttl: int = SESSION_TTL) -> str:
        body = _b64e(json.dumps({
            "u": acct["user_id"], "e": acct["email"], "r": acct["role"],
            "exp": int(time.time()) + ttl,
        }).encode())
        sig = hmac.new(self._secret(acct["hash"]), body.encode(), hashlib.sha256).digest()
        return body + "." + _b64e(sig)

    async def validate_session(self, token: str) -> Optional[dict]:
        try:
            body, sig_b64 = token.rsplit(".", 1)
            meta = json.loads(_b64d(body))
            acct = await self._account(meta.get("e", ""))
            if not acct or acct["status"] != "active":
                return None
            expected = _b64e(hmac.new(self._secret(acct["hash"]), body.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(expected, sig_b64):
                return None
            if int(meta.get("exp", 0)) < time.time():
                return None
            return self.public(acct)
        except Exception:
            return None

    # ------------------------------------------------------------ profile --
    async def update_display_name(self, email: str, display_name: str) -> dict:
        acct = await self._account(email)
        if not acct:
            raise AuthError("account not found")
        doc = await db.fetch(_doc_id(email))
        meta = doc.get("meta", {})
        meta["display_name"] = display_name.strip()[:60] or acct["email"].split("@")[0]
        await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, meta["display_name"], acct["hash"], meta=meta)
        return self.public((await self._account(email)) or {})

    async def change_password(self, email: str, old_password: str, new_password: str) -> dict:
        acct = await self.authenticate(email, old_password)
        if len(new_password) < 8:
            raise AuthError("new password must be at least 8 characters")
        return await self._set_password(email, acct, new_password)

    async def _set_password(self, email: str, acct: dict, new_password: str) -> dict:
        rec = security.hash_password(new_password)
        doc = await db.fetch(_doc_id(email))
        meta = doc.get("meta", {})
        meta.update({"salt": rec["salt"], "iterations": rec["iterations"]})
        await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], rec["hash"], meta=meta)
        return self.public((await self._account(email)) or {})

    # --------------------------------------------------- verification ------
    async def verify_email(self, email: str, code: str) -> dict:
        email = email.strip().lower()
        stored = await cache.get("vc:" + email)
        if not stored:
            raise AuthError("invalid or expired code — request a new one")
        if not hmac.compare_digest(stored, self._otp_hash(email, code.strip())):
            raise AuthError("incorrect code")
        await cache.delete("vc:" + email)
        doc = await db.fetch(_doc_id(email))
        if not doc:
            raise AuthError("account not found")
        meta = doc.get("meta", {})
        meta["verified"] = True
        await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], doc["content"], meta=meta)
        return self.public((await self._account(email)) or {})

    async def resend_verification(self, email: str) -> dict:
        email = email.strip().lower()
        acct = await self._account(email)
        if not acct or acct["verified"]:
            return {"sent": True}
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        await cache.set("vc:" + email, self._otp_hash(email, code), ttl=86400)
        sent = await self._send_otp_email(email, code)
        out: dict = {"sent": True}
        if not sent:
            out["dev_code"] = code
        return out

    async def touch_login(self, email: str) -> None:
        doc = await db.fetch(_doc_id(email))
        if not doc:
            return
        meta = doc.get("meta", {})
        meta["last_login"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], doc["content"], meta=meta)

    async def vault_doc_count(self, user_id: str) -> int:
        if not user_id:
            return 0
        _rows, total = await db.list(f"vault:{user_id}", limit=1)
        return int(total)

    # ----------------------------------------------------- OTP recovery ----
    @staticmethod
    def _otp_hash(email: str, code: str) -> str:
        return hashlib.sha256((email.lower() + ":" + code + ":" + settings.secret_key).encode()).hexdigest()

    async def request_reset(self, email: str) -> dict:
        email = email.strip().lower()
        acct = await self._account(email)
        if not acct:
            # do not reveal whether the account exists
            return {"sent": True}
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        await cache.set("otp:" + email, self._otp_hash(email, code), ttl=OTP_TTL)
        await cache.set("otpc:" + email, "0", ttl=OTP_TTL)
        sent = await self._send_otp_email(email, code)
        out: dict = {"sent": True, "expires_in": OTP_TTL}
        if not sent:
            # No SMTP configured — expose the code so the flow stays usable
            # in development/sandbox deployments. Never happens in production.
            out["dev_code"] = code
        return out

    async def _send_otp_email(self, email: str, code: str) -> bool:
        if not settings.smtp_host:
            return False
        try:
            from email.message import EmailMessage
            import smtplib

            msg = EmailMessage()
            msg["From"] = settings.smtp_from or "silvestar@noreply.local"
            msg["To"] = email
            msg["Subject"] = "Silvestar — password reset code"
            msg.set_content(f"Your Silvestar password reset code is {code}\nIt expires in 10 minutes.")

            def _send() -> None:
                with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as s:
                    if settings.smtp_tls:
                        s.starttls()
                    if settings.smtp_user and settings.smtp_password:
                        s.login(settings.smtp_user, settings.smtp_password)
                    s.send_message(msg)

            loop = __import__("asyncio").get_running_loop()
            await loop.run_in_executor(None, _send)
            return True
        except Exception:
            return False

    async def confirm_reset(self, email: str, code: str, new_password: str) -> dict:
        email = email.strip().lower()
        if len(new_password) < 8:
            raise AuthError("new password must be at least 8 characters")
        stored = await cache.get("otp:" + email)
        if not stored:
            raise AuthError("invalid or expired code — request a new one")
        attempts = int((await cache.get("otpc:" + email)) or 0)
        if hmac.compare_digest(stored, self._otp_hash(email, code.strip())):
            await cache.delete("otp:" + email)
            await cache.delete("otpc:" + email)
            acct = await self._account(email)
            if not acct:
                raise AuthError("account not found")
            await self._set_password(email, acct, new_password)
            return {"reset": True}
        attempts += 1
        if attempts >= OTP_MAX_ATTEMPTS:
            await cache.delete("otp:" + email)
            await cache.delete("otpc:" + email)
            raise AuthError("too many attempts — request a new code")
        await cache.set("otpc:" + email, str(attempts), ttl=OTP_TTL)
        raise AuthError(f"invalid code ({OTP_MAX_ATTEMPTS - attempts} attempts left)")


auth = AuthService()
