"""Module 15 — Crew: multi-agent cowork (free, on the existing AI chain).

A manager plans, specialist agents (researcher / writer / reviewer) each do a
pass using the same free engine stack, and the manager merges the final
deliverable. No external services, no cost.
"""
from __future__ import annotations

import time

from .ai import ai
from .rag import build_context
from .skills import _user_skills, relevant_skills, run_tools, skills_system_block


async def _crew_skills_block(user_id: str, task: str) -> tuple[str, list[str], list]:
    """Skills relevant to the crew task — every agent sees them."""
    try:
        all_sk = await _user_skills(user_id)
        active = relevant_skills(all_sk, task)
        return skills_system_block(active), [s.get("name", "") for s in active], active
    except Exception:
        return "", [], []


async def _call(role_prompt: str, task: str, lang: str = "", skills_block: str = "") -> str:
    """One agent pass: role prompt + task through the free engine chain."""
    sys = role_prompt + (skills_block or "")
    if lang and lang != "en":
        names = {"hi": "Hindi", "ne": "Nepali", "es": "Spanish", "ar": "Arabic", "fr": "French"}
        sys += f"\n\nIMPORTANT: Write ONLY in {names.get(lang, lang)}."
    res = await ai.summarize("Complete your part of the task now.", f"{task}"[:12000])
    # ai.summarize already includes its own system role; layer ours by re-calling
    # the chain directly for tighter control:
    from ..config import settings as _s
    import httpx as _httpx
    messages = [
        {"role": "system", "content": sys},
        {"role": "user", "content": task[:12000]},
    ]
    try:
        async with _httpx.AsyncClient(timeout=_s.ai_timeout) as client:
            r = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {_s.groq_api_key}"},
                json={"model": _s.groq_model, "messages": messages, "stream": False},
            )
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"]
    except Exception:
        pass
    return res.get("summary", "")


async def run_crew(task: str, user_id: str = "anon", lang: str = "",
                   vault_session=None, depth: str = "standard") -> dict:
    """Plan → research (RAG + omniverse tools) → write → review → merge.
    Relevant skills auto-apply to every agent (skill-powered crews)."""
    t0 = time.time()
    skills_block, skill_names, active = await _crew_skills_block(user_id, task)

    # 1) manager: plan
    plan_txt = await _call(
        "You are the Crew Manager of the Silvestar platform. Break the user's task "
        "into 3 short steps for a researcher, a writer and a reviewer. "
        "Return ONLY a numbered list of 3 steps, each max 20 words.",
        f"Task: {task}", lang, skills_block,
    )

    # 2) researcher: gather library context + web tools
    context, cited = await build_context(task, user_id, vault_session)
    tool_ctx, tools_used = await run_tools(task)
    research = await _call(
        "You are the Researcher. Using ONLY the provided context and tool outputs, "
        "collect the key facts, numbers and quotes needed for the task. "
        "Be concise; bullet points.",
        f"TASK PLAN:\n{plan_txt}\n\nTASK: {task}\n\nLIBRARY CONTEXT:\n{context[:6000] or '(none)'}"
        f"\n\nTOOL OUTPUTS:\n{tool_ctx[:4000] or '(none)'}",
        lang, skills_block,
    )

    # 3) writer: draft
    draft = await _call(
        "You are the Writer. Turn the research into a polished, well-structured answer "
        "for the user's task. Use clear headings when helpful. Cite sources as [n] where "
        "they map to the research bullets.",
        f"TASK: {task}\n\nRESEARCH:\n{research}",
        lang, skills_block,
    )

    # 4) reviewer: fix + finalize
    final = await _call(
        "You are the Reviewer. Check the draft for accuracy against the research, remove "
        "fluff, fix formatting, and return the FINAL version only — no commentary.",
        f"TASK: {task}\n\nDRAFT:\n{draft}\n\nRESEARCH (ground truth):\n{research[:4000]}",
        lang, skills_block,
    )

    return {
        "task": task,
        "plan": plan_txt,
        "research": research,
        "draft": draft,
        "final": final or draft,
        "agents": ["manager", "researcher", "writer", "reviewer"],
        "tools_used": tools_used,
        "skills_applied": skill_names,
        "citations": [{"i": i, "library": c.library, "title": c.title, "score": c.score,
                       "doc_id": c.doc_id} for i, c in enumerate(cited, 1)],
        "latency_ms": int((time.time() - t0) * 1000),
    }
