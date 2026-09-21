const RAW_API_URL: string =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
// tolerate hosts without a scheme (e.g. Render fromService host)
export const API_URL: string = RAW_API_URL.startsWith("http")
  ? RAW_API_URL
  : `https://${RAW_API_URL}`;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export interface Health {
  status: string;
  version: string;
  uptime_s: number;
  db: { mode: string; ok: boolean };
  cache: { mode: string; ok: boolean };
  graph: { mode: string; ok: boolean };
  vault: { sessions_active: number };
  ai: { assistant: string; primary_reachable: boolean };
  livekit: { enabled: boolean };
}

export interface Hit {
  doc_id: string;
  library: string;
  title: string;
  snippet: string;
  score: number;
  fingerprint?: string;
}

export interface AskResult {
  answer: string;
  engine: string;
  citations: { i: number; library: string; title: string; score: number; doc_id: string }[];
  vault_unlocked: boolean;
  latency_ms: number;
}

export const api = {
  health: () => req<Health>("/api/v1/health"),

  // Archive
  archiveList: (limit = 50, offset = 0) =>
    req<{ documents: { id: string; title: string; snippet: string }[]; total: number }>(
      `/api/v1/archive/documents?limit=${limit}&offset=${offset}`
    ),
  archiveAdd: (title: string, content: string, source = "", tags: string[] = []) =>
    req<{ id: string; library: string }>("/api/v1/archive/documents", {
      method: "POST",
      body: JSON.stringify({ title, content, source, tags }),
    }),
  archiveDelete: (id: string) =>
    req<{ deleted: boolean }>(`/api/v1/archive/documents/${id}`, { method: "DELETE" }),
  search: (q: string, limit = 8, user_id = "anon", vault_session_token = "") =>
    req<{ results: Hit[]; vault_included: boolean }>(
      `/api/v1/archive/search?q=${encodeURIComponent(q)}&limit=${limit}&user_id=${encodeURIComponent(user_id)}&vault_session_token=${encodeURIComponent(vault_session_token)}`
    ),

  // Vault
  vaultCreate: (user_id: string, password: string) =>
    req<{ created: boolean }>("/api/v1/vault/create", {
      method: "POST",
      body: JSON.stringify({ user_id, password }),
    }),
  vaultUnlock: (user_id: string, password: string) =>
    req<{ session_token: string; expires_in: number }>("/api/v1/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ user_id, password }),
    }),
  vaultLock: (user_id: string, session_token: string) =>
    req<{ locked: boolean }>("/api/v1/vault/lock", {
      method: "POST",
      body: JSON.stringify({ user_id, session_token }),
    }),
  vaultAdd: (user_id: string, session_token: string, title: string, content: string) =>
    req<{ id: string; fingerprint: string }>("/api/v1/vault/documents", {
      method: "POST",
      body: JSON.stringify({ user_id, session_token, title, content }),
    }),
  vaultList: (user_id: string, session_token: string) =>
    req<{ documents: { id: string; title: string }[]; count: number }>(
      `/api/v1/vault/documents?user_id=${encodeURIComponent(user_id)}&session_token=${encodeURIComponent(session_token)}`
    ),
  vaultDelete: (doc_id: string, user_id: string, session_token: string) =>
    req<{ deleted: boolean }>(
      `/api/v1/vault/documents/${doc_id}?user_id=${encodeURIComponent(user_id)}&session_token=${encodeURIComponent(session_token)}`,
      { method: "DELETE" }
    ),

  // AI
  ask: (question: string, user_id: string, vault_session_token = "", history: { role: string; content: string }[] = []) =>
    req<AskResult>("/api/v1/ask", {
      method: "POST",
      body: JSON.stringify({ question, user_id, vault_session_token, history }),
    }),

  // Rooms / realtime
  roomToken: (room: string, identity: string) =>
    req<{ mode: string; token: string; url: string }>(
      `/api/v1/rooms/${encodeURIComponent(room)}/token?identity=${encodeURIComponent(identity)}`
    ),

  // Graph
  graphStats: () => req<{ nodes: number; edges: number; relationships: Record<string, number> }>("/api/v1/graph/stats"),
  graphNode: (id: string, labels: string[], props: Record<string, unknown> = {}) =>
    req<Record<string, unknown>>("/api/v1/graph/nodes", {
      method: "POST",
      body: JSON.stringify({ id, labels, props }),
    }),
  graphEdge: (src: string, rel: string, dst: string) =>
    req<Record<string, unknown>>("/api/v1/graph/edges", {
      method: "POST",
      body: JSON.stringify({ src, rel, dst }),
    }),
  graphPath: (src: string, dst: string) =>
    req<{ path: string[] }>(`/api/v1/graph/path?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`),

  // ---- power tools ----
  archiveExport: () =>
    req<{ format: string; count: number; documents: { id: string; title: string; content: string }[] }>("/api/v1/archive/export"),
  archiveImport: (docs: { title: string; content: string }[]) =>
    req<{ imported: number }>("/api/v1/archive/import", { method: "POST", body: JSON.stringify({ documents: docs }) }),
  relatedDocs: (doc_id: string) =>
    req<{ related: { id: string; title: string; snippet: string; score: number }[] }>(`/api/v1/archive/related/${doc_id}`),
  archiveDigest: () =>
    req<{ summary: string; engine: string; count: number }>("/api/v1/archive/digest", { method: "POST" }),
  docVersions: (doc_id: string) =>
    req<{ versions: { id: string; title: string; snippet: string }[] }>(`/api/v1/archive/documents/${doc_id}/versions`),

  // ---- Level-50 platform services ----
  notifications: (user_id: string) =>
    req<{ notifications: { id: string; message: string; ts: string }[]; unread: number }>(
      `/api/v1/notifications?user_id=${encodeURIComponent(user_id)}`),
  addNotification: (user_id: string, message: string) =>
    req<{ queued: boolean }>("/api/v1/notifications", { method: "POST", body: JSON.stringify({ user_id, message }) }),
  dismissNotification: (nid: string, user_id: string) =>
    req<{ read: boolean }>(`/api/v1/notifications/${nid}?user_id=${encodeURIComponent(user_id)}`, { method: "DELETE" }),
  publicStats: () =>
    req<{ archive_documents: number; active_rooms: number; ai_online: boolean; assistant: string; uptime_s: number }>("/api/v1/stats/public"),
  metrics: () => req<Record<string, any>>("/api/v1/metrics"),
  adminAudit: () =>
    req<{ total: number; entries: { id: string; action: string; detail: string }[] }>("/api/v1/admin/audit", { headers: adminHeaders() }),
  adminBackup: () =>
    req<Record<string, any>>("/api/v1/admin/backup", { headers: adminHeaders() }),

  // ---- Modules 10-11: user panel + admin panel ----
  meStats: (user_id: string, session_token = "") =>
    req<{
      user_id: string; vault_unlocked: boolean; vault_documents: number;
      archive_documents: number; recent_archive: { id: string; title: string }[];
      ai: { assistant: string; reachable: boolean };
    }>(`/api/v1/me/stats?user_id=${encodeURIComponent(user_id)}&session_token=${encodeURIComponent(session_token)}`),

  adminOverview: () =>
    req<Record<string, any>>("/api/v1/admin/overview", { headers: adminHeaders() }),
  adminAddDoc: (title: string, content: string, tags: string[] = []) =>
    req<Record<string, any>>("/api/v1/admin/documents", {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ title, content, tags }),
    }),
  adminDeleteDoc: (id: string) =>
    req<{ deleted: boolean }>(`/api/v1/admin/documents/${id}`, { method: "DELETE", headers: adminHeaders() }),
  adminCacheClear: () =>
    req<{ cleared: boolean }>("/api/v1/admin/cache/clear", { method: "POST", headers: adminHeaders() }),
  adminSetModel: (model: string) =>
    req<{ active_model: string; persisted: boolean }>("/api/v1/admin/ai/model", {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ model }),
    }),
};

function adminHeaders(): Record<string, string> {
  const k = typeof window !== "undefined" ? localStorage.getItem("sv-admin-key") || "" : "";
  return k ? { "x-admin-key": k } : {};
}
