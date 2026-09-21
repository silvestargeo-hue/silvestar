"""Module 9 — Silvestar AI assistant.

Keyless-first engine stack with automatic fallback and a local extractive
last resort so the assistant ALWAYS answers:
  1. OpenAI-compatible endpoint (Pollinations POST)      — keyless
  2. Pollinations GET completion                          — keyless
  3. Puter proxy (platform user-pays) if configured       — optional
  4. Local extractive answer over retrieved context       — always available
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote
from typing import Any

import httpx

from ..config import settings
from .rag import build_context, system_prompt


class SilvestarAI:
    name = "Silvestar"

    async def _post_openai(self, messages: list[dict], model_override: str | None = None) -> str | None:
        """OpenAI-compatible chat with auth + model failover (429/ratelimit aware)."""
        headers = {"Content-Type": "application/json"}
        if settings.ai_api_key:
            headers["Authorization"] = f"Bearer {settings.ai_api_key}"
        for model in [model_override or settings.ai_model, *settings.ai_failover_models]:
            for attempt in range(2):  # one retry per model on transient errors
                try:
                    async with httpx.AsyncClient(timeout=30) as client:
                        r = await client.post(settings.ai_primary_url, headers=headers, json={
                            "model": model,
                            "messages": messages,
                            "stream": False,
                        })
                        if r.status_code == 200:
                            return r.json()["choices"][0]["message"]["content"]
                except Exception:
                    pass
                if attempt == 0:
                    await __import__("asyncio").sleep(1.5)
        return None

    async def _get_completion(self, prompt: str) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                r = await client.get(f"{settings.ai_fallback_url}/{quote(prompt[:2000], safe='')}")
                if r.status_code == 200 and r.text.strip():
                    return r.text.strip()
        except Exception:
            pass
        return None

    async def _puter_proxy(self, messages: list[dict]) -> str | None:
        if not settings.puter_proxy_url:
            return None
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(settings.puter_proxy_url, json={"messages": messages})
                if r.status_code == 200:
                    return r.json().get("content")
        except Exception:
            pass
        return None

    @staticmethod
    def _local_extractive(question: str, context: str) -> str:
        """Last-resort extractive answer from the RAG context."""
        if not context:
            return ("I couldn't reach the AI engines and found no relevant context. "
                    "Add documents to the Archive or your Vault, then ask again.")
        q_terms = [t for t in re.findall(r"[a-z0-9]+", question.lower()) if len(t) > 2]
        scored: list[tuple[int, str]] = []
        for block in context.split("\n\n"):
            low = block.lower()
            s = sum(1 for t in q_terms if t in low)
            if s:
                scored.append((s, block))
        scored.sort(key=lambda p: p[0], reverse=True)
        if not scored:
            return "Here is what the libraries contain:\n\n" + context[:800]
        top = [b for _, b in scored[:3]]
        return "Based on the library context:\n\n" + "\n\n".join(top)

    async def summarize(self, instruction: str, corpus: str) -> dict:
        """Digest/summary over a provided corpus via the engine chain + local fallback."""
        messages = [
            {"role": "system", "content": "You are Silvestar, summarizing library documents. Be concise; use short bullet points."},
            {"role": "user", "content": instruction + "\n\n" + corpus[:12000]},
        ]
        answer = await self._post_openai(messages)
        engine = "openai-compatible"
        if not answer:
            answer = self._local_extractive(instruction, corpus[:4000])
            engine = "local-extractive"
        return {"summary": answer, "engine": engine}

    async def chat(self, question: str, user_id: str = "anon", vault_session_token: str = "",
                   history: list[dict] | None = None) -> dict:
        t0 = time.time()
        session = None
        if vault_session_token:
            from .vault import vault as vault_svc
            session = await vault_svc.validate(user_id, vault_session_token)

        context, cited = await build_context(question, user_id, session)
        messages = [{"role": "system", "content": system_prompt(context, cited)}]
        for m in (history or [])[-8:]:
            messages.append({"role": m.get("role", "user"), "content": str(m.get("content", ""))[:4000]})
        messages.append({"role": "user", "content": question})

        context_suffix = ("\n\nContext:\n" + context) if context else ""
        # runtime model override (set from the Admin Panel) wins over config
        override_model = None
        try:
            from .cache import cache
            override_model = await cache.get("ai:model")
        except Exception:
            pass
        effective_model = override_model or settings.ai_model
        engines = [
            ("openai-compatible", lambda: self._post_openai(messages, effective_model)),
            ("pollinations-get", lambda: self._get_completion(question + context_suffix)),
            ("puter-proxy", lambda: self._puter_proxy(messages)),
        ]
        answer, engine = None, "local-extractive"
        for name, call in engines:
            answer = await call()
            if answer:
                engine = name
                break
        if not answer:
            answer = self._local_extractive(question, context)

        return {
            "answer": answer,
            "engine": engine,
            "citations": [{"i": i, "library": c.library, "title": c.title, "score": c.score, "doc_id": c.doc_id}
                          for i, c in enumerate(cited, 1)],
            "vault_unlocked": bool(session and session.valid),
            "latency_ms": int((time.time() - t0) * 1000),
        }

    async def health(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(settings.ai_fallback_url.replace("/openai", "") + "/models")
                primary_ok = r.status_code < 500
        except Exception:
            primary_ok = False
        return {"assistant": self.name, "keyless": True, "primary_reachable": primary_ok,
                "fallback": "local-extractive always available"}


ai = SilvestarAI()
