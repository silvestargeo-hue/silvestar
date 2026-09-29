# Silvestar — Backup & Restore Guide

## Automated backup (primary)
A GitHub Action (`.github/workflows/backup.yml`) runs **every Monday 03:00 UTC**:
- mirrors the full `silvestar-data` repo into **private `silvestar-data-backup`**
- stores a rolling JSON export (last 8) in `exports/`

Restore from it:
```bash
git clone --mirror https://<TOKEN>@github.com/silvestargeo-hue/silvestar-data-backup.git
git -C silvestar-data-backup.git push --mirror https://<TOKEN>@github.com/silvestargeo-hue/silvestar-data.git
```
Or trigger a fresh backup anytime: repo **Actions → Weekly backup → Run workflow**.

## Local manual backup (secondary)
- `silvestar-backup-*.json` — admin API export (archive + graph docs)
- `silvestar-data.git/` — **full mirror** of the GitHub data repo:
  every stored file, the accounts index, audit log, and all KV documents

## Restore scenarios

### A) Data repo lost/corrupted (files, docs, accounts)
```bash
cd silvestar-data.git
git push --mirror https://<TOKEN>@github.com/silvestargeo-hue/silvestar-data.git
```
The platform immediately serves from the restored repo (storage is read live).

### B) Database lost (Neon)
Recreate a free Postgres (neon.tech), set `DATABASE_URL` in Vercel → redeploy.
Accounts/files live in the data repo (A); the DB holds derived indexes and
rebuild on demand. Re-import archive docs with the admin backup JSON:
```bash
curl -X POST https://silvestar-api.vercel.app/api/v1/archive/import \
  -H "x-admin-key: <ADMIN_KEY>" -H 'Content-Type: application/json' \
  -d @silvestar-backup-<date>.json
```

### C) Just want one file back
Browse `silvestar-data.git` → `files/<user_id>/...` — files are stored as-is.

## Refresh this backup
```bash
cd silvestar-data.git && git fetch --all            # update mirror
# plus a fresh admin export JSON via /api/v1/admin/backup
```
