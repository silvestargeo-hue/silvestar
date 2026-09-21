export const API_URL: string =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
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
};
