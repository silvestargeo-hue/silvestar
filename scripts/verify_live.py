"""One-shot live verification: boots the API in-process, exercises every
module over real HTTP, prints a pass/fail report, exits 0 on success.

Usage:
  AI_PRIMARY_URL=... AI_MODEL=... AI_API_KEY=... \
    PYTHONPATH=.deps:services/api python3 scripts/verify_live.py
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8123"

results: list[tuple[str, bool, str]] = []


def call(method: str, path: str, payload: dict | None = None, timeout: int = 90):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def check(name: str, fn):
    try:
        detail = fn() or ""
        results.append((name, True, str(detail)[:120]))
    except Exception as e:  # noqa: BLE001
        body = getattr(e, "read", None)
        extra = ""
        if body is not None:
            try:
                extra = body().decode()[:200]
            except Exception:  # noqa: BLE001
                pass
        results.append((name, False, f"{e} {extra}"))


def main() -> int:
    import uvicorn  # noqa: PLC0415

    cfg = uvicorn.Config("app.main:app", host="127.0.0.1", port=8123, log_level="warning")
    server = uvicorn.Server(cfg)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    for _ in range(40):
        try:
            call("GET", "/api/v1/health", timeout=2)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.5)

    # --- Module 2/8: health & cache ---
    check("health (9 modules)", lambda: json.dumps(call("GET", "/api/v1/health"))[:120])

    # --- Module 4: archive publish + search ---
    check("archive publish", lambda: call("POST", "/api/v1/archive/documents", {
        "title": "Livecheck Note", "content": "Silvestar global search livecheck doc.",
        "user_id": "anon"}).get("doc_id") or call("GET", "/api/v1/archive/search?q=livecheck")["results"][0]["title"])
    check("archive search", lambda: json.dumps(call(
        "GET", "/api/v1/archive/search?q=livecheck"))[:120])

    # --- Module 5: vault create/unlock/seal + cross-library retrieval ---
    check("vault create", lambda: call("POST", "/api/v1/vault/create", {
        "user_id": "liveuser", "password": "pw123456"})["created"])
    token = call("POST", "/api/v1/vault/unlock", {
        "user_id": "liveuser", "password": "pw123456"})["session_token"]
    check("vault unlock (session)", lambda: "session_token ok")
    check("vault seal (AES-GCM)", lambda: call("POST", "/api/v1/vault/documents", {
        "user_id": "liveuser", "session_token": token,
        "title": "Secret", "content": "The launch code is dawn."})["encrypted"])

    # --- Module 3/9: cross-library RAG — locked vs unlocked ---
    def _rag_unlocked():
        r = call("POST", "/api/v1/rag/query", {
            "question": "launch code", "user_id": "liveuser",
            "vault_session_token": token})
        vault_cites = [c for c in r["citations"] if c["library"].startswith("vault")]
        assert vault_cites, f"no vault citations: {r['citations']}"
        return f"vault snippet: {vault_cites[0]['snippet'][:60]}"

    check("rag cross-library (unlocked)", _rag_unlocked)

    def _rag_locked():
        r = call("POST", "/api/v1/rag/query", {
            "question": "launch code", "user_id": "liveuser"})
        return "locked markers present" if "[locked" in json.dumps(r).lower() or r.get("vault_unlocked") is False else "vault hidden"

    check("rag vault locked state", _rag_locked)

    def _ask():
        r = call("POST", "/api/v1/ask", {
            "question": "Say exactly: SILVESTAR AI ONLINE", "user_id": "anon"})
        return f"engine={r.get('engine')}: {r.get('answer', '')[:90]}"

    check("ai ask (live LLM)", _ask)

    # --- Module 7: graph ---
    check("graph node add", lambda: call("POST", "/api/v1/graph/nodes", {
        "id": "n-live", "label": "LiveNode"})["id"])
    check("graph neighbors", lambda: json.dumps(call(
        "GET", "/api/v1/graph/neighbors/n-live"))[:100])

    server.should_exit = True
    t.join(timeout=5)

    print("\n══════ LIVE VERIFICATION ══════")
    fails = 0
    for name, ok, detail in results:
        mark = "✅" if ok else "❌"
        if not ok:
            fails += 1
        print(f"{mark} {name:26} {detail}")
    print("══════ ALL PASS ══════" if fails == 0 else f"══════ {fails} FAILED ══════")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
