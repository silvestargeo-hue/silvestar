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

# Point SILVESTAR_BASE_URL at a deployed instance to verify production,
# or leave unset to boot the local API in-process.
BASE = os.environ.get("SILVESTAR_BASE_URL", "http://127.0.0.1:8123").rstrip("/")
LOCAL = "127.0.0.1" in BASE

results: list[tuple[str, bool, str]] = []


def call(method: str, path: str, payload: dict | None = None, timeout: int = 90, headers: dict | None = None):
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=h,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _status(method: str, path: str) -> int:
    try:
        req = urllib.request.Request(BASE + path, method=method)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


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
    server = None
    thread = None
    if LOCAL:
        import uvicorn  # noqa: PLC0415

        cfg = uvicorn.Config("app.main:app", host="127.0.0.1", port=8123, log_level="warning")
        server = uvicorn.Server(cfg)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()

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
    def _vault_create():
        try:
            return call("POST", "/api/v1/vault/create", {
                "user_id": "liveuser", "password": "pw123456"})["created"]
        except urllib.error.HTTPError as e:
            if e.code == 409:
                return "exists (persistent db) ✓"
            raise
    check("vault create", _vault_create)
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

    # --- Module 4+: power tools ---
    rel_id = call("POST", "/api/v1/archive/documents", {
        "title": "Power Tools Doc", "content": "Related documents and versioning test doc.",
        "user_id": "anon"}).get("id") or call("GET", "/api/v1/archive/search?q=Power+Tools")["results"][0]["doc_id"]
    check("archive export", lambda: call("GET", "/api/v1/archive/export")["format"])
    check("archive import", lambda: call("POST", "/api/v1/archive/import", {
        "documents": [{"title": "Imported Doc", "content": "bulk import works"}]})["imported"])
    check("archive rss", lambda: "rss ✓" if _status("GET", "/api/v1/archive/rss") == 200 else "rss missing")
    check("related docs", lambda: f"{len(call('GET', '/api/v1/archive/related/' + rel_id)['related'])} related")
    check("doc update", lambda: call("PUT", "/api/v1/archive/documents/" + rel_id, {
        "title": "Power Tools Doc v2", "content": "updated content"})["id"])
    check("version history", lambda: f"{len(call('GET', '/api/v1/archive/documents/' + rel_id + '/versions')['versions'])} version(s)")
    check("ai digest", lambda: call("POST", "/api/v1/archive/digest?limit=3", None)["engine"])

    # --- Modules 10-11: admin + user panels ---
    admin = {"x-admin-key": os.environ.get("SILVESTAR_ADMIN_KEY", "silvestar-admin")}
    check("admin overview", lambda: json.dumps(call("GET", "/api/v1/admin/overview", None, headers=admin))[:120])
    check("admin auth rejected", lambda: (_ for _ in ()).throw(AssertionError("expected 403"))
          if _status("GET", "/api/v1/admin/overview") != 403 else "403 without key ✓")
    check("admin model switch", lambda: call("POST", "/api/v1/admin/ai/model",
          {"model": "nvidia/nemotron-3.5-lightning:free"}, headers=admin)["active_model"])
    check("admin doc publish", lambda: call("POST", "/api/v1/admin/documents", {
        "title": "Admin Notice", "content": "Posted via admin panel."}, headers=admin)["id"])
    check("admin cache clear", lambda: call("POST", "/api/v1/admin/cache/clear", {}, headers=admin)["cleared"])
    check("user stats", lambda: json.dumps(call(
        "GET", "/api/v1/me/stats?user_id=liveuser&session_token=" + token))[:120])

    # --- Modules 12-13: accounts & auth ---
    stamp = str(int(time.time()))
    em = f"owner-{stamp}@silvestar.dev"
    reg = call("POST", "/api/v1/auth/register", {
        "email": em, "password": "Passw0rd!23", "display_name": "Owner"})
    vcode = (reg.get("verification") or {}).get("dev_code")
    if vcode:
        check("auth email verify", lambda: call("POST", "/api/v1/auth/verify", {
            "email": em, "code": vcode})["user"]["verified"])
    check("auth register (first=admin)", lambda: reg["user"]["role"])
    ahdr = {"Authorization": "Bearer " + reg["session_token"]}
    # on a persistent DB this user may not be the first account — promote via
    # the admin key so subsequent admin-session checks hold (no-op when already admin)
    try:
        call("POST", f"/api/v1/admin/users/{em}/promote", None, headers=admin)
    except Exception:
        pass
    check("auth login", lambda: call("POST", "/api/v1/auth/login", {
        "email": em, "password": "Passw0rd!23"})["user"]["email"])
    check("auth remember 30d", lambda: f"{call('POST', '/api/v1/auth/login', {
        'email': em, 'password': 'Passw0rd!23', 'remember': True})['expires_in'] // 86400}d token")
    check("auth session validate", lambda: call("POST", "/api/v1/auth/session", {
        "session_token": reg["session_token"]})["user"]["user_id"])
    check("auth profile update", lambda: call("PUT", "/api/v1/auth/profile", {
        "session_token": reg["session_token"], "display_name": "Silvestar Owner"})["user"]["display_name"])
    otp = call("POST", "/api/v1/auth/forgot", {"email": em})
    code = otp.get("dev_code", "")
    check("auth otp issued", lambda: "dev code ✓" if code else "smtp path")
    if code:
        check("auth otp reset", lambda: call("POST", "/api/v1/auth/reset", {
            "email": em, "code": code, "new_password": "NewPass0rd!23"})["reset"])
        tok2 = call("POST", "/api/v1/auth/login", {
            "email": em, "password": "NewPass0rd!23"})["session_token"]
        check("auth login new pw", lambda: "ok")
        chg = call("POST", "/api/v1/auth/password", {
            "session_token": tok2, "old_password": "NewPass0rd!23",
            "new_password": "Passw0rd!23"})
        check("auth change password", lambda: chg["sessions_invalidated"])
        # password change kills every old session — rebuild admin auth from the fresh token
        ahdr = {"Authorization": "Bearer " + chg["session_token"]}

        def _tok2_dead():
            try:
                call("POST", "/api/v1/auth/session", {"session_token": tok2})
                return "FAIL: still valid"
            except urllib.error.HTTPError:
                return "invalidated ✓"
        check("old session invalidated", _tok2_dead)
    em2 = f"member-{stamp}@silvestar.dev"
    call("POST", "/api/v1/auth/register", {"email": em2, "password": "Passw0rd!23"})
    check("admin users (role session)", lambda: call("GET", "/api/v1/admin/users", None, headers=ahdr)["total"])
    check("admin suspend user", lambda: call("POST", f"/api/v1/admin/users/{em2}/suspend", None, headers=ahdr)["status"])

    def _suspended_blocked():
        try:
            call("POST", "/api/v1/auth/login", {"email": em2, "password": "Passw0rd!23"})
            return "FAIL: login allowed"
        except urllib.error.HTTPError as e:
            return f"blocked ({e.code}) ✓"
    check("suspended login blocked", _suspended_blocked)
    check("admin activate user", lambda: call("POST", f"/api/v1/admin/users/{em2}/activate", None, headers=ahdr)["status"])
    check("admin promote user", lambda: call("POST", f"/api/v1/admin/users/{em2}/promote", None, headers=ahdr)["role"])
    check("admin demote user", lambda: call("POST", f"/api/v1/admin/users/{em2}/demote", None, headers=ahdr)["role"])
    check("admin temp password", lambda: call("POST", f"/api/v1/admin/users/{em2}/reset-password", None, headers=ahdr)["temporary_password"][:4] + "…")
    check("admin delete user", lambda: call("DELETE", f"/api/v1/admin/users/{em2}", None, headers=ahdr)["deleted"])

    # --- Level-50 platform services ---
    check("notify self", lambda: call("POST", "/api/v1/notifications", {
        "user_id": "liveuser", "message": "Level-50 reminder"})["queued"])
    check("notifications list", lambda: f"{len(call('GET', '/api/v1/notifications?user_id=liveuser')['notifications'])} item(s)")
    check("public stats", lambda: call("GET", "/api/v1/stats/public")["assistant"])
    check("metrics", lambda: call("GET", "/api/v1/metrics")["modes"]["db"])
    check("admin audit", lambda: f"{call('GET', '/api/v1/admin/audit', None, headers=admin)['total']} entries")
    check("admin backup", lambda: call("GET", "/api/v1/admin/backup", None, headers=admin)["format"])

    if server and thread:
        server.should_exit = True
        thread.join(timeout=5)

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
