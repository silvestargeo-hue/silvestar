"""Module 16 — Media Studio: images, audio→notes, CSV insights. Free stack.

- generate_image: keyless Pollinations image endpoint, saved into the Library
- transcribe: Groq Whisper (whisper-large-v3-turbo free tier) → text, then an
  AI meeting-notes pass; the transcript + notes are stored in the Library
- csv analysis helpers are handled in the API layer with local csv parsing +
  the AI chain for narrative insights.
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote

import httpx

from ..config import settings
from .ai import ai


def _safe_name(prompt: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", prompt[:40]).strip("-") or "image"
    return f"{base}-{int(time.time())}.{ext}"


async def generate_image(prompt: str, user_id: str, file_store) -> dict:
    """Text → image via keyless Pollinations; result stored in the Library."""
    url = f"https://image.pollinations.ai/prompt/{quote(prompt[:400])}?width=1024&height=1024&nologo=true&seed={int(time.time())}"
    async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
        r = await client.get(url)
    if r.status_code != 200 or not r.content or len(r.content) < 1000:
        raise RuntimeError(f"image service returned HTTP {r.status_code}")
    name = _safe_name(prompt, "jpg")
    return await file_store.upload(user_id, name, r.content, folder="AI-Images",
                                   note=f"prompt: {prompt[:200]}")


async def transcribe_audio(filename: str, data: bytes, user_id: str, file_store,
                           make_notes: bool = True) -> dict:
    """Audio → transcript via Groq Whisper, then AI meeting notes. Both saved."""
    if not settings.groq_api_key:
        raise RuntimeError("transcription requires GROQ_API_KEY")
    if len(data) > 25 * 1024 * 1024:
        raise RuntimeError("audio too large — Groq Whisper free limit is 25MB")
    async with httpx.AsyncClient(timeout=300) as client:
        r = await client.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {settings.groq_api_key}"},
            files={"file": (filename, data)},
            data={"model": "whisper-large-v3-turbo", "response_format": "text"},
        )
    if r.status_code != 200:
        raise RuntimeError(f"transcription failed: HTTP {r.status_code} {r.text[:120]}")
    transcript = (r.text or "").strip()

    notes = ""
    if make_notes and transcript:
        res = await ai.summarize(
            "Turn this transcript into clean meeting notes: a 2-sentence summary, "
            "key decisions, action items with owners if mentioned, and open questions.",
            transcript[:14000],
        )
        notes = res.get("summary", "")

    base = re.sub(r"\.[a-z0-9]+$", "", filename, flags=re.I) or "audio"
    ts = int(time.time())
    t_name = f"{base}-transcript-{ts}.txt"
    t_rec = await file_store.upload(user_id, t_name, transcript.encode(), folder="Transcripts")
    out = {"transcript_file": t_name, "chars": len(transcript)}
    if notes:
        n_name = f"{base}-notes-{ts}.md"
        await file_store.upload(user_id, n_name,
                                f"# Meeting notes — {base}\n\n{notes}\n\n---\n\n## Transcript\n\n{transcript}".encode(),
                                folder="Meeting-Notes")
        out["notes_file"] = n_name
        out["notes"] = notes[:600]
    return out
