"use client";

/** Offline mode + background sync.
 * - Caches successful GET JSON responses (per-user) so the app still renders
 *   offline.
 * - Queues failed POSTs (reminders, card reviews, deck imports…) in
 *   localStorage and flushes them automatically when connectivity returns.
 * Zero cost: no server component — the browser is the queue. */

const QUEUE_KEY = "sv-offline-queue-v1";
const CACHE_PREFIX = "sv-offline-get:";
const MAX_QUEUE = 100;

type QueuedReq = {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  queuedAt: number;
};

function readQueue(): QueuedReq[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedReq[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(0, MAX_QUEUE)));
  } catch {}
}

/** True when the browser reports (or assumes) it has no network. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Cache a successful GET (per-user namespaced). Best-effort, never throws. */
export function cacheGet(url: string, data: unknown, userKey: string) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + userKey + ":" + url,
      JSON.stringify({ at: Date.now(), data }),
    );
  } catch {}
}

/** Read a cached GET; returns undefined when missing or older than maxAgeMs. */
export function readCache<T = unknown>(url: string, userKey: string, maxAgeMs = 7 * 86400_000): T | undefined {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userKey + ":" + url);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (Date.now() - parsed.at > maxAgeMs) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** Queue a POST for later when offline; returns the queue length after add. */
export function enqueue(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method: string = "POST",
): number {
  const q = readQueue();
  q.push({
    id: `o${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url,
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    queuedAt: Date.now(),
  });
  writeQueue(q);
  return q.length;
}

export function queueSize(): number {
  return readQueue().length;
}

/** Flush the queue in order. Stops at the first failure (queue head must go
 * first to preserve ordering). Returns how many requests succeeded. */
export async function flushQueue(): Promise<number> {
  let done = 0;
  let q = readQueue();
  while (q.length) {
    const job = q[0];
    try {
      const res = await fetch(job.url, {
        method: job.method,
        headers: { ...(job.body ? { "Content-Type": "application/json" } : {}), ...job.headers },
        body: job.body,
      });
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410 || res.status === 422) {
        // permanent failure — drop instead of retrying forever
        q = q.slice(1);
        writeQueue(q);
        continue;
      }
      if (!res.ok) throw new Error(`retry later (${res.status})`);
      q = q.slice(1);
      writeQueue(q);
      done += 1;
    } catch {
      break; // still offline / server error — keep the rest queued
    }
  }
  return done;
}

let wired = false;

/** Wire global auto-flush listeners (online event + interval probe). Safe to
 * call multiple times; listeners are registered once. */
export function initOfflineSync(onFlushed?: (n: number) => void) {
  if (wired || typeof window === "undefined") return;
  wired = true;
  const tryFlush = async () => {
    if (isOffline() || queueSize() === 0) return;
    const n = await flushQueue();
    if (n > 0 && onFlushed) onFlushed(n);
  };
  window.addEventListener("online", tryFlush);
  window.addEventListener("focus", tryFlush);
  setInterval(tryFlush, 30_000);
  setTimeout(tryFlush, 3_000);
}
