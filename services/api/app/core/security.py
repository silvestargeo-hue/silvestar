"""Module 5 — Vault cryptography.

AES-256-GCM (Rust-backed via the `cryptography` package's OpenSSL binding).
Per-user key derivation: PBKDF2-HMAC-SHA256 with per-user random salt.
Ciphertext envelope format: base64(salt[16] | nonce[12] | ciphertext+tag).
"""
from __future__ import annotations

import base64
import hashlib
import os

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


def envelope_fingerprint(envelope: str) -> str:
    """Stable fingerprint of ciphertext — lets cross-library RAG reference vault
    documents WITHOUT exposing plaintext (retrieval identity only)."""
    return hashlib.sha256(envelope.encode("ascii")).hexdigest()[:16]
