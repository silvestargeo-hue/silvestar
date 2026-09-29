# ⭐ Silvestar Platform

**A free-for-life personal AI platform** — file Library, encrypted Vault, knowledge
Archive, graph, realtime rooms, and a real AI assistant. No credit card, no trials,
no expirations.

**Live:** https://silvestar-web.vercel.app · **Companion OS:** https://silvestargeo-hue.github.io/jarvis-os/

## Modules

| Tab | What it does |
|---|---|
| 🏠 Home | Dashboard: live stats, quick actions |
| 🤖 Ask Silvestar | RAG AI over your documents (Groq + 6 fallback engines) |
| 🗂 Library | Files up to 40 MB (PDF/Word/images/any), folders, viewer, bulk upload — text becomes AI-searchable |
| 📚 Archive | Knowledge documents: search, versions, export |
| 🔒 Vault | AES-256-GCM encrypted docs; AI only sees them while unlocked |
| 🕸 Graph | Nodes + relationships between your ideas |
| 🎙 Rooms | Realtime voice & chat |
| ⚙️ Settings | Theme, accent colors, profile, lock screen, system status |
| 📖 Guide | Built-in manual |
| 🛡 Admin | Users, documents, AI model, audit (admin role only) |

Installable as an Android/iOS PWA (home-screen icon + shortcuts).

## Stack (all free tiers)

| Layer | Provider |
|---|---|
| Web (Next.js) | Vercel |
| API (FastAPI) | Vercel (Python runtime) |
| Database (pgvector) | Neon |
| File storage | GitHub repo (Contents API) |
| AI | Groq → Gemini → Pollinations → OpenRouter → local |
| Email (OTP) | Resend |

## Repo layout

```
apps/web        Next.js PWA (the site)
services/api    FastAPI backend (app/, api/index.py, vercel.json)
```

## Deploy notes

- **API**: `cd services/api && npx vercel deploy --prod` (legacy builds config — don't delete `vercel.json`)
- **Web**: git push to `main` (Vercel git integration, rootDirectory `apps/web`)
- Env vars live in Vercel project settings (`DATABASE_URL`, `GITHUB_TOKEN`,
  `GITHUB_DATA_REPO`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`,
  `SILVESTAR_ADMIN_KEY`, …)
