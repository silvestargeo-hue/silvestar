"use client";

/** Library — real file management: bulk upload (any type), folders,
 *  online viewer (PDF/image/text/Office), download, rename, move, delete.
 *  Files are stored on GitHub (free) and extracted text is AI-searchable. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast, Modal } from "@/lib/kit";

type FileMeta = {
  id: string; name: string; path: string; folder: string;
  size: number; mime: string; note?: string; uploaded: number; indexed: boolean;
};
type ListRes = { files: FileMeta[]; folders: string[]; total: number };

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

function authHeaders(sessionToken: string, userId: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (sessionToken) h["Authorization"] = `Bearer ${sessionToken}`;
  if (userId) h["x-silvestar-user"] = userId;
  return h;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function icon(mime: string, name: string): string {
  const e = name.toLowerCase().split(".").pop() || "";
  if (mime.startsWith("image/")) return "🖼";
  if (mime === "application/pdf" || e === "pdf") return "📕";
  if (e === "docx" || e === "doc") return "📘";
  if (e === "xlsx" || e === "xls" || e === "csv") return "📊";
  if (e === "pptx" || e === "ppt") return "📽";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  if (["zip", "rar", "7z", "tar", "gz"].includes(e)) return "🗜";
  if (["txt", "md", "log", "json"].includes(e)) return "📄";
  return "📦";
}

export function LibraryView({ userId, sessionToken }: { userId: string; sessionToken: string }) {
  const [data, setData] = useState<ListRes>({ files: [], folders: [], total: 0 });
  const [folder, setFolder] = useState("");          // current folder
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string>("");
  const [viewFile, setViewFile] = useState<FileMeta | null>(null);
  const [viewUrl, setViewUrl] = useState<string>("");
  const [viewText, setViewText] = useState<string>("");
  const [renameTarget, setRenameTarget] = useState<FileMeta | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [moveTarget, setMoveTarget] = useState<FileMeta | null>(null);
  const [moveVal, setMoveVal] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderVal, setNewFolderVal] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [design, setDesign] = useState<{ accent: string; view: "grid" | "list" }>(
    () => { try { return JSON.parse(localStorage.getItem("sv-library-design") || '{"accent":"#8a05ff","view":"grid"}'); } catch { return { accent: "#8a05ff", view: "grid" as const }; } }
  );
  const oneRef = useRef<HTMLInputElement>(null);
  const bulkRef = useRef<HTMLInputElement>(null);

  const saveDesign = (d: typeof design) => {
    setDesign(d);
    localStorage.setItem("sv-library-design", JSON.stringify(d));
  };

  const load = useCallback(async (f: string = folder) => {
    try {
      const r = await fetch(`${API}/api/v1/files?folder=${encodeURIComponent(f)}&prefix=${encodeURIComponent(query)}`,
        { headers: authHeaders(sessionToken, userId) });
      if (!r.ok) throw new Error(`${r.status}`);
      setData(await r.json());
    } catch (e) {
      toast("Failed to load library", "err");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, query, sessionToken, userId]);

  useEffect(() => { load(); }, [load]);

  // ------------------------------------------------------------- uploads --
  const doUpload = async (list: FileList | null, bulk: boolean) => {
    if (!list || !list.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(list)) fd.append(bulk ? "files" : "file", f);
      if (folder) fd.append("folder", folder);
      const r = await fetch(`${API}/api/v1/files/${bulk ? "upload-bulk" : "upload"}`, {
        method: "POST", headers: authHeaders(sessionToken, userId), body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      if (bulk) {
        toast(`Uploaded ${j.uploaded} file(s)` + (j.failed ? `, ${j.failed} failed` : ""), j.failed ? "err" : "ok");
        (j.errors || []).forEach((e: { filename: string; error: string }) => toast(`${e.filename}: ${e.error}`, "err"));
      } else {
        toast(`Uploaded ${j.name}`, "ok");
      }
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "err");
    } finally { setBusy(false); }
  };

  // drag & drop bulk upload
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length) doUpload(files, files.length > 1 || !files[0].type);
  };

  // ------------------------------------------------------------- actions --
  const dl = (f: FileMeta) => {
    const url = `${API}/api/v1/files/download?path=${encodeURIComponent(f.path)}`;
    const a = document.createElement("a");
    // pass auth via fetch → blob so sessions work
    fetch(url, { headers: authHeaders(sessionToken, userId) })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then((b) => {
        const u = URL.createObjectURL(b);
        const a = document.createElement("a");
        a.href = u; a.download = f.name; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 4000);
      })
      .catch(() => toast("Download failed", "err"));
  };

  const openViewer = async (f: FileMeta) => {
    setViewFile(f); setViewText(""); setViewUrl("");
    const url = `${API}/api/v1/files/view?path=${encodeURIComponent(f.path)}`;
    const mime = f.mime || "";
    if (mime.startsWith("image/") || mime === "application/pdf") { setViewUrl(url); return; }
    try {
      const r = await fetch(url, { headers: authHeaders(sessionToken, userId) });
      if (!r.ok) throw new Error();
      if (mime.startsWith("text/") || /\.(txt|md|csv|json|log|srt|html|xml)$/i.test(f.name)) {
        setViewText(await r.text());
      } else if (/\.(docx?|pptx?|xlsx?|csv)$/i.test(f.name)) {
        const blob = await r.blob();
        setViewUrl(URL.createObjectURL(blob)); // Office viewer fallback: download/preview
        setViewText("(Office file — use Download to open locally, or preview below)");
      } else {
        const blob = await r.blob();
        setViewUrl(URL.createObjectURL(blob));
        setViewText("(Binary file — preview not supported, use Download)");
      }
    } catch { toast("Preview failed", "err"); }
  };

  const doRename = async () => {
    if (!renameTarget || !renameVal.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ path: renameTarget.path, new_name: renameVal.trim() }),
      });
      if (!r.ok) throw new Error();
      toast("Renamed", "ok"); setRenameTarget(null);
      await load();
    } catch { toast("Rename failed", "err"); } finally { setBusy(false); }
  };

  const doMove = async () => {
    if (!moveTarget) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ path: moveTarget.path, new_folder: moveVal.trim() }),
      });
      if (!r.ok) throw new Error();
      toast("Moved", "ok"); setMoveTarget(null);
      await load();
    } catch { toast("Move failed", "err"); } finally { setBusy(false); }
  };

  const doDelete = async (f: FileMeta) => {
    if (!confirm(`Delete "${f.name}" permanently?`)) return;
    try {
      const r = await fetch(`${API}/api/v1/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ path: f.path }),
      });
      if (!r.ok) throw new Error();
      toast("Deleted", "ok");
      await load();
    } catch { toast("Delete failed", "err"); }
  };

  const doNewFolder = async () => {
    if (!newFolderVal.trim()) return;
    try {
      const r = await fetch(`${API}/api/v1/files/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ folder: (folder ? folder + "/" : "") + newFolderVal.trim() }),
      });
      if (!r.ok) throw new Error();
      toast("Folder created", "ok"); setNewFolderOpen(false); setNewFolderVal("");
      await load();
    } catch { toast("Could not create folder", "err"); }
  };

  // ------------------------------------------------------------- render ---
  const crumbs = folder ? folder.split("/") : [];
  const visible = query
    ? data.files
    : data.files.filter((f) => f.folder === folder);

  return (
    <div className="view" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div className="view-head">
        <div>
          <h2>🗂 Library</h2>
          <p className="muted">
            {data.total} file(s) · {data.folders.length} folder(s) · any type up to 40MB · AI-searchable
          </p>
        </div>
        <div className="row gap">
          <input className="input" placeholder="Search files…" value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ width: 160 }} />
          <button className="btn ghost" onClick={() => saveDesign({ ...design, view: design.view === "grid" ? "list" : "grid" })}>
            {design.view === "grid" ? "☰ List" : "▦ Grid"}
          </button>
          <button className="btn ghost" onClick={() => setNewFolderOpen(true)}>📁 New folder</button>
          <button className="btn ghost" disabled={busy} onClick={() => bulkRef.current?.click()}>⬆ Bulk upload</button>
          <button className="btn primary" disabled={busy} onClick={() => oneRef.current?.click()}>⬆ Upload</button>
        </div>
      </div>

      <input ref={oneRef} type="file" hidden onChange={(e) => { doUpload(e.target.files, false); e.target.value = ""; }} />
      <input ref={bulkRef} type="file" multiple hidden onChange={(e) => { doUpload(e.target.files, true); e.target.value = ""; }} />

      {uploading && <div className="muted">Uploading…</div>}

      {/* breadcrumbs */}
      {crumbs.length > 0 && (
        <div className="crumbs">
          <button className="link" onClick={() => setFolder("")}>🏠 root</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {" / "}
              <button className="link" onClick={() => setFolder(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </div>
      )}

      {/* subfolders */}
      {folder === "" && data.folders.length > 0 && (
        <div className="folder-grid" style={{ borderColor: design.accent + "33" }}>
          {data.folders.map((f) => (
            <button key={f} className="folder-chip" onClick={() => setFolder(f)} style={{ borderColor: design.accent + "55" }}>
              📁 {f.split("/").pop()} <span className="muted small">({f.split("/").length > 1 ? f.split("/").slice(0, -1).join("/") + "/" : "root"})</span>
            </button>
          ))}
        </div>
      )}

      {/* drop hint */}
      {dragOver && <div className="drop-hint">⬇ Drop files to upload{folder ? ` into ${folder}` : ""}</div>}

      {/* files */}
      {visible.length === 0 ? (
        <div className="empty">
          <div className="big">🗂</div>
          <p>No files here yet. Drag & drop files anywhere, or use Upload.</p>
          <p className="muted small">PDF · Word · Excel · PPT · images · audio · video · zip — anything ≤ 40MB.<br />Text inside PDF/Word/PPT/Excel is extracted so <b>Ask Silvestar</b> can search it.</p>
        </div>
      ) : design.view === "grid" ? (
        <div className="file-grid">
          {visible.map((f) => (
            <div key={f.path} className="file-card" style={{ borderColor: design.accent + "22" }}>
              <button className="file-open" onClick={() => openViewer(f)} title="View">
                <span className="file-icon">{icon(f.mime, f.name)}</span>
                <span className="file-name">{f.name}</span>
              </button>
              <span className="file-meta muted small">{fmtSize(f.size)}{f.indexed ? " · 🔍 AI-indexed" : ""}</span>
              <div className="file-actions">
                <button className="btn tiny" onClick={() => openViewer(f)} title="View">👁</button>
                <button className="btn tiny" onClick={() => dl(f)} title="Download">⬇</button>
                <button className="btn tiny" onClick={() => { setRenameTarget(f); setRenameVal(f.name); }} title="Rename">✏</button>
                <button className="btn tiny" onClick={() => { setMoveTarget(f); setMoveVal(f.folder); }} title="Move to folder">➡</button>
                <button className="btn tiny danger" onClick={() => doDelete(f)} title="Delete">🗑</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="file-table">
          <thead><tr><th>Name</th><th>Size</th><th>Folder</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.path}>
                <td><button className="link" onClick={() => openViewer(f)}>{icon(f.mime, f.name)} {f.name}</button></td>
                <td>{fmtSize(f.size)}</td>
                <td>{f.folder || "—"}</td>
                <td>{new Date(f.uploaded * 1000).toLocaleDateString()}</td>
                <td className="file-actions">
                  <button className="btn tiny" onClick={() => dl(f)}>⬇</button>
                  <button className="btn tiny" onClick={() => { setRenameTarget(f); setRenameVal(f.name); }}>✏</button>
                  <button className="btn tiny" onClick={() => { setMoveTarget(f); setMoveVal(f.folder); }}>➡</button>
                  <button className="btn tiny danger" onClick={() => doDelete(f)}>🗑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* viewer modal */}
      {viewFile && (
        <Modal title={`${icon(viewFile.mime, viewFile.name)} ${viewFile.name}`} onClose={() => { setViewFile(null); setViewUrl(""); setViewText(""); }}>
          <div className="viewer">
            {viewUrl && viewFile.mime === "application/pdf" && (
              <iframe src={viewUrl} className="viewer-frame" title={viewFile.name} />
            )}
            {viewUrl && viewFile.mime.startsWith("image/") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={viewUrl} alt={viewFile.name} className="viewer-img" />
            )}
            {viewText && <pre className="viewer-text">{viewText.slice(0, 20000)}</pre>}
            <div className="row gap" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => dl(viewFile)}>⬇ Download</button>
              <span className="muted small">{fmtSize(viewFile.size)} · {viewFile.mime}{viewFile.indexed ? " · searchable by AI" : ""}</span>
            </div>
          </div>
        </Modal>
      )}

      {/* rename modal */}
      {renameTarget && (
        <Modal title="Rename file" onClose={() => setRenameTarget(null)}>
          <input className="input" value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus />
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={doRename}>Save</button>
            <button className="btn ghost" onClick={() => setRenameTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* move modal */}
      {moveTarget && (
        <Modal title={`Move "${moveTarget.name}" to folder`} onClose={() => setMoveTarget(null)}>
          <input className="input" placeholder="e.g. projects/2026 (empty = root)" value={moveVal} onChange={(e) => setMoveVal(e.target.value)} autoFocus />
          <div className="muted small" style={{ marginTop: 6 }}>Existing: {data.folders.join(", ") || "none"}</div>
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={doMove}>Move</button>
            <button className="btn ghost" onClick={() => setMoveTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* new folder modal */}
      {newFolderOpen && (
        <Modal title="New folder" onClose={() => setNewFolderOpen(false)}>
          <input className="input" placeholder="folder name" value={newFolderVal} onChange={(e) => setNewFolderVal(e.target.value)} autoFocus
            onKeyDown={(e) => e.key === "Enter" && doNewFolder()} />
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={doNewFolder}>Create</button>
            <button className="btn ghost" onClick={() => setNewFolderOpen(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* user design: accent color */}
      <div className="design-bar muted small">
        Accent:
        {["#8a05ff", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899"].map((c) => (
          <button key={c} aria-label={"accent " + c}
            className={`swatch ${design.accent === c ? "on" : ""}`}
            style={{ background: c }}
            onClick={() => saveDesign({ ...design, accent: c })} />
        ))}
        <span className="muted">— saved to this device</span>
      </div>
    </div>
  );
}
