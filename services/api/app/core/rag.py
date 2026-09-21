"""Module 3 — RAG engine with cross-library retrieval.

Retrieves from BOTH the public Archive and the user's Personal Vault
(vault content is retrieved under its encrypted identity — snippets are only
included when the user holds an active vault session), then synthesizes a
cited answer with the Silvestar AI stack.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .cache import cache
from .db import db


@dataclass
class Retrieved:
    doc_id: str
    library: str          # 'archive' | 'vault'
    title: str
    snippet: str
    score: float
    fingerprint: str = ""  # set for vault docs (identity w/o plaintext)
    cited: bool = False


def chunk_text(text: str, chunk_chars: int = 700, overlap: int = 80) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= chunk_chars:
        return [text] if text else []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_chars, len(text))
        # prefer breaking on sentence boundary
        dot = text.rfind(". ", start, end)
        if dot > start + chunk_chars // 2:
            end = dot + 1
        chunks.append(text[start:end].strip())
        start = end - overlap if end < len(text) else end
    return [c for c in chunks if c]


async def retrieve(query: str, user_id: str, vault_session: "VaultSessionInfo | None" = None,
                   limit_per_lib: int = 5) -> list[Retrieved]:
    """Parallel search of Archive + Vault. Vault snippets decrypt ONLY if the
    caller presents a valid vault session; otherwise vault hits are identity-only."""
    archive_hits = await db.search("archive", query, limit=limit_per_lib)

    vault_hits_enc = await db.search(f"vault:{user_id}", query, limit=limit_per_lib)
    vault_out: list[Retrieved] = []
    for h in vault_hits_enc:
        fp = str(h.get("meta", {}).get("fingerprint", ""))
        if vault_session and vault_session.valid:
            # decrypt-at-rest content is stored plaintext-in-vault-row only for the
            # session holder; rows hold envelopes, so we read via vault service
            from .vault import vault as vault_svc  # circular-safe lazy import (instance)
            plain = await vault_svc.read_plaintext(user_id, h["id"], vault_session)
            snippet = plain[:400] if plain else "[locked]"
        else:
            snippet = "[locked — unlock vault to include]"
        vault_out.append(Retrieved(h["id"], "vault", h["title"], snippet, h["score"], fingerprint=fp))

    out = [Retrieved(h["id"], "archive", h["title"], h["content"][:400], h["score"]) for h in archive_hits]
    out += vault_out
    out.sort(key=lambda r: r.score, reverse=True)
    return out


async def build_context(query: str, user_id: str, vault_session: "VaultSessionInfo | None" = None) -> tuple[str, list[Retrieved]]:
    hits = await retrieve(query, user_id, vault_session)
    if not hits:
        return "", []
    blocks = []
    for i, h in enumerate(hits[:8], 1):
        blocks.append(f"[{i}] ({h.library}) {h.title}: {h.snippet}")
        h.cited = True
    return "\n\n".join(blocks), hits


def system_prompt(context: str, cited: list[Retrieved]) -> str:
    base = (
        "You are Silvestar, the AI assistant of the Silvestar platform. "
        "Answer grounded in the provided context when relevant. "
        "Cite sources inline like [1], [2] matching the context blocks. "
        "If context is empty or irrelevant, answer from general knowledge and say so."
    )
    if context:
        base += "\n\nCONTEXT:\n" + context
    return base


@dataclass
class VaultSessionInfo:
    user_id: str
    valid: bool = False
    expires_at: float = 0.0
