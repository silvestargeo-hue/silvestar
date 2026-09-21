# Silvestar Platform

Full-stack, 9-module knowledge platform with the **Silvestar AI** assistant.

| # | Module | Implementation |
|---|--------|----------------|
| 1 | Web frontend | Next.js 15 + React 19 + TS, glassmorphic UI, animated scenic lock screen |
| 2 | API core | FastAPI (Rust-accelerated: pydantic-core, orjson, uvloop) |
| 3 | RAG engine | Cross-library retrieval (Archive + Vault), cited answers, 256-dim embeddings |
| 4 | Archive Library | Public global search; pgvector when `DATABASE_URL` is set, SQLite fallback otherwise |
| 5 | Personal Vault | AES-256-GCM per-user, PBKDF2 keys, session unlock, encrypted-at-rest snippets |
| 6 | Realtime | Native WebSocket hub (chat/presence) + LiveKit token service for A/V rooms |
| 7 | Graph | Neo4j driver + embedded fallback for the knowledge graph |
| 8 | Cache | Redis driver + in-memory fallback (rate limiting, hot queries) |
| 9 | Silvestar AI | OpenAI/Groq when keys exist, **keyless open-LLM fallback chain** otherwise |

## Run locally

```bash
# API
cd services/api
pip install -r requirements.txt
uvicorn app.main:app --port 8000

# Web
cd apps/web
npm install && npm run build && npm start   # http://localhost:3000
```

## Run the full stack (real pgvector + Redis + Neo4j)

```bash
docker compose -f infra/docker-compose.yml up -d --build
# web → http://localhost:3000   api → http://localhost:8000/health
```

## Tests

```bash
cd <repo root>
PYTHONPATH=services/api python -m pytest tests/ -q     # 16 tests, all modules + integration
```

## Deploy

- **Render (one click):** push to GitHub → render.com → Blueprint → pick this repo (`render.yaml`).
- **Docker anywhere:** see `infra/docker-compose.yml`.
- Env vars: see `.env.example`. Everything is optional — absent infra URLs activate embedded engines; absent AI keys activate the keyless chain.

## Security notes

- Vault documents are sealed with AES-256-GCM before they touch storage; searches over locked vaults return `[locked]` markers only, and plaintext snippets are released exclusively inside an active unlock session.
- Set a strong `SILVESTAR_SECRET` in production; it feeds per-user key derivation.
