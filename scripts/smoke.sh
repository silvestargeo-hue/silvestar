#!/usr/bin/env bash
# Silvestar end-to-end smoke test — run any time:
#   bash scripts/smoke.sh [API_BASE]
# Default API: https://silvestar-api.vercel.app
set -u
API="${1:-https://silvestar-api.vercel.app}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got $2, want $3)"; fi; }

echo "⭐ Silvestar smoke test → $API"
E="smoke.$(date +%s)@gmail.com"; P="Smoke-$(date +%s)-test!"

# 1. health
H=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/health")
check "health" "$H" "200"

# 2. auth cycle
curl -s -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' -d "{\"email\":\"$E\",\"password\":\"$P\"}" >/dev/null
T=$(curl -s -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$E\",\"password\":\"$P\"}" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')
[ -n "$T" ] && ok "register+login" || bad "register+login"
U=$(curl -s -X POST "$API/api/v1/auth/session" -H 'Content-Type: application/json' -d "{\"session_token\":\"$T\"}" | sed -n 's/.*"user_id":"\([^"]*\)".*/\1/p')
[ -n "$U" ] && ok "session validate" || bad "session validate"

# 3. AI
A=$(curl -s -X POST "$API/api/v1/ask" -H 'Content-Type: application/json' -d '{"question":"Reply with exactly: SMOKE_OK","user_id":"smoke"}')
echo "$A" | grep -q "SMOKE_OK" && ok "AI answers (engine: $(echo "$A" | sed -n 's/.*"engine":"\([^"]*\)".*/\1/p'))" || bad "AI answers"

# 4. files
printf "smoke test file" > /tmp/sv-smoke.txt
FP=$(curl -s -X POST "$API/api/v1/files/upload" -H "Authorization: Bearer $T" -F "file=@/tmp/sv-smoke.txt" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
[ -n "$FP" ] && ok "file upload" || bad "file upload"
D=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/files/download?path=$FP" -H "Authorization: Bearer $T")
check "file download" "$D" "200"
curl -s -X POST "$API/api/v1/files/delete" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"path\":\"$FP\"}" >/dev/null

# 5. vault
VP="Vault-smoke-$(date +%s)!"
curl -s -X POST "$API/api/v1/vault/create" -H 'Content-Type: application/json' -d "{\"user_id\":\"$U\",\"password\":\"$VP\"}" >/dev/null
VS=$(curl -s -X POST "$API/api/v1/vault/unlock" -H 'Content-Type: application/json' -d "{\"user_id\":\"$U\",\"password\":\"$VP\"}" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')
[ -n "$VS" ] && ok "vault create+unlock" || bad "vault create+unlock"

# 6. archive
A=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/archive/stats?user_id=$U" -H "Authorization: Bearer $T")
check "archive stats" "$A" "200"

# 7. notifications
N=$(curl -s -X POST "$API/api/v1/notifications" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"user_id\":\"$U\",\"message\":\"smoke\"}")
echo "$N" | grep -q '"queued":true' && ok "notifications" || bad "notifications"

# 8. graph
G=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/graph/stats" -H "Authorization: Bearer $T")
check "graph" "$G" "200"

rm -f /tmp/sv-smoke.txt
echo "-------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
