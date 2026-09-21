"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Hit } from "@/lib/api";

export function ArchiveView({ userId, sessionToken }: { userId: string; sessionToken: string }) {
  const [docs, setDocs] = useState<{ id: string; title: string; snippet: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [vaultIncluded, setVaultIncluded] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.archiveList(100);
      setDocs(r.documents);
      setTotal(r.total);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!title.trim() || !content.trim()) return;
    await api.archiveAdd(title.trim(), content.trim(), "web-ui");
    setTitle("");
    setContent("");
    setMsg("Published to Archive ✓");
    await load();
  };

  const search = async () => {
    if (!query.trim()) return;
    const r = await api.search(query.trim(), 10, userId, sessionToken);
    setHits(r.results);
    setVaultIncluded(r.vault_included);
  };

  const remove = async (id: string) => {
    await api.archiveDelete(id);
    await load();
  };

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
            placeholder="Global search…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button onClick={search}>Search</button>
        </div>
        {hits && (
          <div style={{ marginTop: 10 }}>
            {hits.length === 0 && <div className="hint">No results.</div>}
            {hits.map((h) => (
              <div key={h.doc_id} className="hit">
                <div className="t">
                  <span className={`tag ${h.library}`}>{h.library === "vault" ? "🔒 vault" : "📚 archive"}</span>
                  {h.title} <span className="score">{h.score}</span>
                </div>
                <div className="s">{h.snippet}</div>
              </div>
            ))}
          </div>
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
            <button onClick={add}>Publish</button>
          </div>
          {msg && <div className="hint">{msg}</div>}
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
    </div>
  );
}
