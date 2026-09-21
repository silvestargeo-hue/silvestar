# Silvestar Platform — 50-Level Feature Manifest

Every level below is implemented and verified (16/16 pytest · 23+/30 live harness · Next build clean).

| Lv | Feature | Where |
|----|---------|-------|
| 1 | Archive Library (public, global search) | `/api/v1/archive/*`, ArchiveView |
| 2 | Personal Vault (AES-256-GCM at rest) | `/api/v1/vault/*`, VaultView |
| 3 | PBKDF2 per-user key derivation | `core/security.py` |
| 4 | Cross-library RAG (Archive + Vault) | `core/rag.py` |
| 5 | `[locked]` identity-only vault retrieval | `core/rag.py` |
| 6 | Cited AI answers `[1] [2]` | `core/ai.py` |
| 7 | Silvestar AI with keyless fallback chain | `core/ai.py` |
| 8 | OpenRouter/OpenAI + model failover | `core/ai.py` |
| 9 | Runtime AI model switching (admin) | `/api/v1/admin/ai/model` |
| 10 | WebSocket hub (chat/presence) | `/ws/{room}` |
| 11 | LiveKit token service (A/V rooms) | `/api/v1/rooms` |
| 12 | Knowledge graph + path finding | `/api/v1/graph/*` |
| 13 | Redis/memory cache layer | `core/cache.py` |
| 14 | Rate limiting | realtime hub |
| 15 | pgvector production schema | `core/db.py` |
| 16 | Embedded SQLite fallback | `core/db.py` |
| Lv17 | Version history (auto-snapshot on edit) | `PUT /archive/documents/{id}` |
| 18 | Related documents | `/archive/related/{id}` |
| 19 | AI Digest of the library | `/archive/digest` |
| 20 | Export (JSON backup) | `/archive/export` |
| 21 | Import (bulk restore) | `/archive/import` |
| 22 | RSS feed | `/archive/rss` |
| 23 | Live search with highlighting | ArchiveView |
| 24 | Sort by relevance / A–Z | ArchiveView |
| 25 | Search history (local, private) | ArchiveView |
| 26 | Keyword cloud (tap-to-search) | ArchiveView |
| 27 | Tags on publish | DocIn.tags |
| 28 | Preview modal (related + versions) | ArchiveView |
| 29 | Share links + copy | ArchiveView |
| 30 | Voice input (Web Speech API) | AskView |
| 31 | TTS read-aloud of answers | AskView |
| 32 | Typewriter answer reveal | `lib/kit.tsx` |
| 33 | Command palette (Ctrl/⌘+K) | CommandPalette |
| 34 | Keyboard shortcuts + help (?) | ShortcutsOverlay |
| 35 | Toast notifications | `lib/kit.tsx` |
| 36 | Dark / light themes (persisted) | `globals.css` |
| 37 | Offline banner + PWA caching | `sw.js` |
| 38 | Installable PWA (manifest) | `manifest.webmanifest` |
| 39 | Error boundary with retry | ErrorBoundary |
| 40 | Skeleton loaders | Skeletons + `.skel` |
| 41 | Admin Panel (key-guarded) | AdminPanel.tsx |
| 42 | Admin overview tiles + uptime | `/admin/overview` |
| 43 | Admin publish/delete docs | `/admin/documents` |
| 44 | Cache clear control | `/admin/cache/clear` |
| 45 | Audit log of admin actions | `/admin/audit` |
| 46 | Platform metrics (+ X-Response-Time) | `/api/v1/metrics` |
| 47 | Public landing stats | `/api/v1/stats/public` |
| 48 | Notification center + reminders | `/api/v1/notifications` |
| 49 | Admin full backup | `/admin/backup` |
| 50 | Animated scenic lock screen | LockScreen + LockScene |

**Cross-cutting:** mobile-first responsive (bottom nav, drawer, safe-areas, 44px targets), desktop sidebar shell, per-user stats API, stateless vault sessions with revocation, request telemetry, deploy configs (Render/Docker/Compose).
