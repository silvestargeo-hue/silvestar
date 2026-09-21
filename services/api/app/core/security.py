"""Module 5 — Vault cryptography.

AES-256-GCM (Rust-backed via the `cryptography` package's OpenSSL binding).
Per-user key derivation: PBKDF2-HMAC-SHA256 with per-user random salt.
Ciphertext envelope format: base64(salt[16] | nonce[12] | ciphertext+tag).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import settings

_SALT_LEN = 16
_NONCE_LEN = 12


def derive_key(password: str, salt: bytes, iterations: int | None = None) -> bytes:
    """PBKDF2-HMAC-SHA256 → 32-byte AES-256 key."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations or settings.vault_kdf_iterations, dklen=32
    )


def encrypt(plaintext: str, key: bytes) -> str:
    """Encrypt UTF-8 text into the base64 envelope."""
    nonce = os.urandom(_NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("ascii")


def decrypt(envelope: str, key: bytes) -> str:
    """Decrypt a base64 envelope back to UTF-8 text."""
    raw = base64.b64decode(envelope.encode("ascii"))
    nonce, ct = raw[:_NONCE_LEN], raw[_NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8")


def new_salt() -> bytes:
    return os.urandom(_SALT_LEN)


def hash_password(password: str, salt: bytes | None = None) -> dict:
    """Server-side verifier hash for vault password (never store the password)."""
    salt = salt or new_salt()
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, settings.vault_kdf_iterations, dklen=32)
    return {"salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(dk).decode(), "iterations": settings.vault_kdf_iterations}


def verify_password(password: str, salt_b64: str, expected_hash_b64: str) -> bool:
    salt = base64.b64decode(salt_b64)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, settings.vault_kdf_iterations, dklen=32)
    import hmac as _h
    return _h.compare_digest(base64.b64encode(dk).decode(), expected_hash_b64)


# ------------------------------------------------- stateless session tokens --
# Serverless-safe: a vault session is a self-contained, signed+encrypted token,
# so any cold function instance can restore the session without shared memory.
# The signing/wrapping secret is derived from the user's stored verifier hash —
# unique per user, never stored in the token, requires db access to forge.


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _session_secret(verifier_hash_b64: str) -> bytes:
    return hmac.new(("sessv1:" + verifier_hash_b64).encode(), b"silvestar-session", hashlib.sha256).digest()


def issue_session_token(user_id: str, key: bytes, verifier_hash_b64: str, ttl_seconds: int) -> str:
    secret = _session_secret(verifier_hash_b64)
    meta = _b64e(json.dumps({"u": user_id, "exp": int(time.time()) + ttl_seconds}).encode())
    nonce = os.urandom(_NONCE_LEN)
    wrapped = nonce + AESGCM(secret[:32]).encrypt(nonce, key, None)
    body = meta + "." + _b64e(wrapped)
    return body + "." + _b64e(hmac.new(secret, body.encode(), hashlib.sha256).digest())


def open_session_token(token: str, user_id: str, verifier_hash_b64: str) -> bytes | None:
    """Validate a stateless session token and return the vault AES key, or None."""
    try:
        body, sig_b64 = token.rsplit(".", 1)
        secret = _session_secret(verifier_hash_b64)
        expected = _b64e(hmac.new(secret, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, sig_b64):
            return None
        meta_b64, keyblob_b64 = body.split(".", 1)
        meta = json.loads(_b64d(meta_b64))
        if meta.get("u") != user_id or int(meta.get("exp", 0)) < time.time():
            return None
        raw = _b64d(keyblob_b64)
        return AESGCM(secret[:32]).decrypt(raw[:_NONCE_LEN], raw[_NONCE_LEN:], None)
    except Exception:
        return None


def envelope_fingerprint(envelope: str) -> str:
    """Stable fingerprint of ciphertext — lets cross-library RAG reference vault
    documents WITHOUT exposing plaintext (retrieval identity only)."""
    return hashlib.sha256(envelope.encode("ascii")).hexdigest()[:16]
