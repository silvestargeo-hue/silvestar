"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Hit } from "@/lib/api";
import { highlight, downloadFile, copyText, toast, useDebounced, Modal } from "@/lib/kit";

type Recent = { q: string; ts: number };
type Doc = { id: string; title: string; snippet: string };

export function ArchiveView({ userId, sessionToken }: { userId: string; sessionToken: string }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [sort, setSort] = useState<"score" | "title">("score");
  const [vaultIncluded, setVaultIncluded] = useState(false);
  const [preview, setPreview] = useState<Hit | null>(null);
  const [related, setRelated] = useState<{ id: string; title: string }[]>([]);
  const [versions, setVersions] = useState<{ id: string; title: string; snippet: string }[]>([]);
  const [history, setHistory] = useState<Recent[]>([]);
  const debouncedQ = useDebounced(query, 400);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.archiveList(100);
      setDocs(r.documents);
      setTotal(r.total);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
    }
  }, []);

  useEffect(() => {
    load();
    try { setHistory(JSON.parse(localStorage.getItem("sv-search-history") || "[]")); } catch {}
  }, [load]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setHits(null); return; }
    try {
      const r = await api.search(q.trim(), 10, userId, sessionToken);
      setHits(r.results);
      setVaultIncluded(r.vault_included);
      setHistory((h) => {
        const next = [{ q: q.trim(), ts: Date.now() / 1000 }, ...h.filter((x) => x.q !== q.trim())].slice(0, 8);
        localStorage.setItem("sv-search-history", JSON.stringify(next));
        return next;
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
    }
  }, [userId, sessionToken]);

  // live search as you type
  useEffect(() => { runSearch(debouncedQ); }, [debouncedQ, runSearch]);

  const openPreview = async (h: Hit) => {
    setPreview(h);
    setRelated([]);
    setVersions([]);
    try {
      if (h.library === "archive") {
        const [rel, ver] = await Promise.all([api.relatedDocs(h.doc_id), api.docVersions(h.doc_id)]);
        setRelated(rel.related.map((r) => ({ id: r.id, title: r.title })));
        setVersions(ver.versions);
      }
    } catch { /* optional enrichments */ }
  };

  const exportAll = async () => {
    try {
      const data = await api.archiveExport();
      downloadFile(`silvestar-archive-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
      toast(`Exported ${data.count} documents`, "ok");
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const importFile = async (f: File) => {
    try {
      const parsed = JSON.parse(await f.text());
      const list: { title: string; content: string }[] = Array.isArray(parsed) ? parsed
        : (parsed.documents || []).map((d: any) => ({ title: d.title ?? "untitled", content: d.content ?? d.snippet ?? "" }));
      const r = await api.archiveImport(list.filter((d) => d.title && d.content));
      toast(`Imported ${r.imported} documents`, "ok");
      await load();
    } catch (e) {
      toast(`Import failed: ${e}`, "err");
    }
  };

  const add = async () => {
    if (!title.trim() || !content.trim()) return;
    try {
      await api.archiveAdd(title.trim(), content.trim(), "web-ui", tags.split(",").map((t) => t.trim()).filter(Boolean));
      setTitle(""); setContent(""); setTags("");
      toast("Published to Archive ✓", "ok");
      await load();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const remove = async (id: string) => {
    await api.archiveDelete(id);
    toast("Deleted", "ok");
    await load();
  };

  const sortedHits = useMemo(() => {
    if (!hits) return null;
    const h = [...hits];
    if (sort === "title") h.sort((a, b) => a.title.localeCompare(b.title));
    else h.sort((a, b) => b.score - a.score);
    return h;
  }, [hits, sort]);

  const cloud = useMemo(() => {
    const stop = new Set("the a an and or of to in is are was were for on with as by it this that be have has from at".split(" "));
    const freq = new Map<string, number>();
    for (const d of docs) {
      for (const w of `${d.title} ${d.snippet}`.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []) {
        if (!stop.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  }, [docs]);

  return (
    <div className="grid2">
      <div className="card">
        <h2>📚 Archive Library — global search</h2>
        <div className="hint">
          Public, world-readable library. Search runs across the Archive and, when unlocked, your Vault too
          {vaultIncluded ? " — vault is currently INCLUDED." : "."}
        </div>
        <div className="row">
          <input
            value={query}
            placeholder="Global search — results update as you type…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch(query)}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as any)} style={{ flex: "0 0 130px" }}>
            <option value="score">↕ relevance</option>
            <option value="title">A–Z title</option>
          </select>
        </div>

        {history.length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {history.map((h) => (
              <span key={h.ts} className="chip" onClick={() => setQuery(h.q)}>🕘 {h.q}</span>
            ))}
          </div>
        )}

        {sortedHits && (
          <div style={{ marginTop: 10 }}>
            {sortedHits.length === 0 && <div className="hint">No results.</div>}
            {sortedHits.map((h) => (
              <div key={h.doc_id} className="hit" style={{ cursor: "pointer" }} onClick={() => openPreview(h)}>
                <div className="t">
                  <span className={`tag ${h.library}`}>{h.library === "vault" ? "🔒 vault" : "📚 archive"}</span>
                  {h.title} <span className="score">{h.score.toFixed ? h.score.toFixed(3) : h.score}</span>
                </div>
                <div className="s" dangerouslySetInnerHTML={{ __html: highlight(h.snippet, query) }} />
              </div>
            ))}
          </div>
        )}

        {cloud.length > 0 && (
          <>
            <div className="hint" style={{ marginTop: 14 }}>Keyword cloud — tap to search</div>
            <div className="cloud">
              {cloud.map(([w, n]) => (
                <span
                  key={w}
                  className="chip"
                  style={{ fontSize: Math.min(11 + n * 1.5, 20) }}
                  onClick={() => setQuery(w)}
                >
                  {w}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="card">
          <h2>Publish to Archive</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <textarea value={content} placeholder="Content…" onChange={(e) => setContent(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <input value={tags} placeholder="tags, comma, separated" onChange={(e) => setTags(e.target.value)} />
            <button onClick={add}>Publish</button>
          </div>
        </div>

        <div className="card">
          <h2>Library tools</h2>
          <div className="row">
            <button className="ghost" onClick={exportAll}>⬇ Export JSON</button>
            <label className="chip" style={{ minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 14px" }}>
              ⬆ Import JSON
              <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            </label>
            <a href={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/v1/archive/rss`} target="_blank" rel="noreferrer">
              <button className="ghost">📡 RSS feed</button>
            </a>
          </div>
        </div>

        <div className="card">
          <h2>Browse ({total} documents)</h2>
          {docs.map((d) => (
            <div key={d.id} className="hit">
              <div className="t">
                {d.title}
                <button className="danger" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 12 }} onClick={() => remove(d.id)}>
                  delete
                </button>
              </div>
              <div className="s">{d.snippet}</div>
            </div>
          ))}
          {docs.length === 0 && <div className="hint">Empty — publish the first document.</div>}
        </div>
      </div>

      {preview && (
        <Modal title={`📄 ${preview.title}`} onClose={() => setPreview(null)}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <span className={`tag ${preview.library}`}>{preview.library}</span>
            <span className="tag">score {preview.score.toFixed ? preview.score.toFixed(3) : preview.score}</span>
          </div>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{preview.snippet}</p>
          {related.length > 0 && (
            <>
              <div className="hint">Related documents</div>
              <div className="chips">{related.map((r) => <span key={r.id} className="chip">📄 {r.title}</span>)}</div>
            </>
          )}
          {versions.length > 0 && (
            <>
              <div className="hint" style={{ marginTop: 10 }}>Version history ({versions.length})</div>
              {versions.map((v) => (
                <div key={v.id} className="hit"><div className="t">🕘 {v.title}</div><div className="s">{v.snippet}</div></div>
              ))}
            </>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="mini" onClick={() => { copyText(`${preview.title}\n\n${preview.snippet}`); toast("Copied", "ok"); }}>📋 Copy</button>
            <button className="mini" onClick={() => {
              const url = `${location.origin}/?doc=${preview.doc_id}`;
              copyText(url); toast("Share link copied", "ok");
            }}>🔗 Share link</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
