"use client";

/** Library — real file management: bulk upload (any type), folders,
 *  online viewer (PDF/image/text/Office), download, rename, move, delete.
 *  Files are stored on GitHub (free) and extracted text is AI-searchable. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast, Modal, copyText, renderMarkdown } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

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

export function LibraryView({ userId, sessionToken, onChatWithFile }: {
  userId: string; sessionToken: string; onChatWithFile?: (f: { path: string; name: string }) => void;
}) {
  const { t } = useI18n();
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
  const [shareUrl, setShareUrl] = useState("");
  const [shareTarget, setShareTarget] = useState<FileMeta | null>(null);
  const [sharePass, setSharePass] = useState("");
  const [verTarget, setVerTarget] = useState<FileMeta | null>(null);
  const [verList, setVerList] = useState<{ ts: number; size: number; vpath: string }[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderVal, setNewFolderVal] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragPaths, setDragPaths] = useState<string[]>([]);
  const [hoverFolder, setHoverFolder] = useState("");
  const [zipping, setZipping] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuery, setAiQuery] = useState("");
  const [aiResults, setAiResults] = useState<{ title: string; path: string; folder: string; score: number; snippet: string }[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiTried, setAiTried] = useState(false);
  const [sumBusy, setSumBusy] = useState(false);
  const [sumText, setSumText] = useState("");
  const [sumFiles, setSumFiles] = useState(0);
  const [suggested, setSuggested] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlVal, setUrlVal] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [spList, setSpList] = useState<{ name: string; role: string; folder: string }[]>([]);
  const [spName, setSpName] = useState("");
  const [spEmail, setSpEmail] = useState("");
  const [spInviteTo, setSpInviteTo] = useState("");
  const [spBusy, setSpBusy] = useState(false);
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

  useEffect(() => { load(); setSelected(new Set()); }, [load]);

  const loadSpaces = async () => {
    try {
      const r = await fetch(`${API}/api/v1/spaces`, { headers: authHeaders(sessionToken, userId) });
      const j = await r.json();
      setSpList(j.spaces || []);
    } catch { /* panel stays empty */ }
  };

  const createSpace = async () => {
    const n = spName.trim();
    if (!n || spBusy) return;
    setSpBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/spaces`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ name: n }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      toast(t("spCreated"), "ok");
      setSpName("");
      await loadSpaces();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setSpBusy(false); }
  };

  const inviteMember = async (space: string) => {
    const em = spEmail.trim();
    if (!em || spBusy) return;
    setSpBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/spaces/${encodeURIComponent(space)}/invite`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionToken, userId) },
        body: JSON.stringify({ email: em }),
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.reason || `${r.status}`);
      toast(t("spInvited"), "ok");
      setSpEmail(""); setSpInviteTo("");
      await loadSpaces();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setSpBusy(false); }
  };

  // web-clipper handoff: /?import=… deep link stashes a payload in localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem("sv-import");
      if (!raw) return;
      localStorage.removeItem("sv-import");
      const p = JSON.parse(raw) as { title?: string; text?: string; url?: string };
      if (!p?.text) return;
      const safe = (p.title || "Web clip").slice(0, 60).replace(/[\\/:*?"<>|]/g, "-");
      const body = `# ${p.title || "Web clip"}\nSource: ${p.url || ""}\n\n${p.text}`;
      const fd = new FormData();
      fd.append("file", new Blob([body], { type: "text/markdown" }), `${safe}.md`);
      fd.append("folder", "clippings");
      fetch(`${API}/api/v1/files/upload`, { method: "POST", headers: authHeaders(sessionToken, userId), body: fd })
        .then((r) => { if (!r.ok) throw new Error("import failed"); toast("Clip saved to Library ✓", "ok"); })
        .then(() => load())
        .catch(() => toast("Clip import failed", "err"));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------- bulk selection --
  const toggleSel = (path: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  };
  const clearSel = () => setSelected(new Set());

  const bulkOp = async (kind: "delete" | "move", folderTo = "") => {
    if (!selected.size) return;
    if (kind === "delete" && !confirm(`Delete ${selected.size} file(s) permanently?`)) return;
    await moveOrDelete(kind, [...selected], folderTo);
    clearSel();
  };

  const moveOrDelete = async (kind: "delete" | "move", paths: string[], folderTo = "") => {
    if (!paths.length) return;
    if (kind === "delete" && !confirm(`Delete ${paths.length} file(s) permanently?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/bulk-${kind}`, {
        method: "POST",
        headers: { ...authHeaders(sessionToken, userId), "Content-Type": "application/json" },
        body: JSON.stringify({ paths, folder: folderTo }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      const done = kind === "delete" ? j.deleted : j.moved;
      toast(`${done} file(s) ${kind === "move" ? "moved" : "deleted"}` + (j.failed ? `, ${j.failed} failed` : ""), j.failed ? "err" : "ok");
      await load();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setBusy(false); }
  };

  const dropOnFolder = (folderTo: string) => {
    if (!dragPaths.length) return;
    moveOrDelete("move", dragPaths, folderTo);
    setDragPaths([]);
    setHoverFolder("");
  };

  const dragStart = (f: FileMeta) => {
    // dragging a selected file drags the whole selection
    setDragPaths(selected.has(f.path) && selected.size > 0 ? [...selected] : [f.path]);
  };

  const downloadZip = async () => {
    setZipping(true);
    try {
      const r = await fetch(`${API}/api/v1/files/zip?folder=${encodeURIComponent(folder)}`,
        { headers: authHeaders(sessionToken, userId) });
      if (!r.ok) throw new Error(`${r.status}`);
      const b = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = (folder ? folder.replace(/\//g, "-") : "library") + ".zip";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("ZIP downloaded ✓", "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setZipping(false); }
  };

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
        // smart name: if the filename looks generic and the AI can read the file,
        // fetch a descriptive suggestion and prefill the rename dialog
        const generic = /^(untitled|document|new|file|scan|img|image|screenshot|download|doc\d*|\d{4}[-_]?\d{2}[-_]?\d{2}.*)$/i
          .test((j.name || "").replace(/\.[^.]+$/, ""));
        if (generic && j.indexed && j.path) {
          try {
            const s = await api.suggestName(j.path);
            if (s.suggestion) {
              setSuggested(s.suggestion);
              setRenameTarget(j as FileMeta);
              setRenameVal(s.suggestion + (j.name.match(/\.[^.]+$/)?.[0] || ""));
            }
          } catch {}
        }
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

  const doShare = async (f: FileMeta, password = "") => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/share`, {
        method: "POST",
        headers: { ...authHeaders(sessionToken, userId), "Content-Type": "application/json" },
        body: JSON.stringify({ path: f.path, password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "share failed");
      setShareTarget(null);
      setSharePass("");
      setShareUrl(j.url);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
    } finally { setBusy(false); }
  };

  const openVersions = async (f: FileMeta) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/versions?path=${encodeURIComponent(f.path)}`,
        { headers: authHeaders(sessionToken, userId) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "failed");
      setVerList(j.versions || []);
      setVerTarget(f);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
    } finally { setBusy(false); }
  };

  const doRestore = async (ts: number) => {
    if (!verTarget) return;
    if (!confirm("Restore this version? The current file is saved as a new version first.")) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/versions/restore`, {
        method: "POST",
        headers: { ...authHeaders(sessionToken, userId), "Content-Type": "application/json" },
        body: JSON.stringify({ path: verTarget.path, ts }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "restore failed");
      toast("Version restored ✓", "ok");
      setVerTarget(null);
      load();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
    } finally { setBusy(false); }
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

  // ------------------------------------------------------- AI file search --
  const runAiSearch = async () => {
    const q = aiQuery.trim();
    if (!q || aiBusy) return;
    setAiBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/files/search?q=${encodeURIComponent(q)}`,
        { headers: authHeaders(sessionToken, userId) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setAiResults(j.results || []);
      setAiTried(true);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setAiBusy(false); }
  };

  const chatWithFile = (f: FileMeta) => {
    if (!f.indexed) { toast("This file has no extractable text to chat with", "err"); return; }
    onChatWithFile?.({ path: f.path, name: f.name });
  };

  const runSummary = async () => {
    if (sumBusy) return;
    setSumBusy(true);
    setSumText("");
    try {
      const r = await api.folderSummary(folder);
      setSumText(r.summary || "");
      setSumFiles(r.files || 0);
      if (!r.summary) setSumText("");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setSumBusy(false); }
  };

  const importFromUrl = async () => {
    const u = urlVal.trim();
    if (!u || urlBusy) return;
    setUrlBusy(true);
    try {
      await api.importUrl(u, folder);
      toast("Imported ✓", "ok");
      setUrlOpen(false); setUrlVal("");
      await load();
    } catch (e) {
      toast(`${t("importFailed")}: ${e instanceof Error ? e.message : e}`, "err");
    } finally { setUrlBusy(false); }
  };

  const aiSuggestName = async () => {
    if (!renameTarget || !renameTarget.indexed) return;
    try {
      const s = await api.suggestName(renameTarget.path);
      if (s.suggestion) {
        setSuggested(s.suggestion);
        setRenameVal(s.suggestion + (renameTarget.name.match(/\.[^.]+$/)?.[0] || ""));
      } else toast("No suggestion — file may have no readable text", "err");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    }
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
          <input className="input" placeholder={t("searchFiles")} value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ width: 160 }} />
          <button className="btn ghost" onClick={() => setAiOpen(!aiOpen)} title={t("aiSearchHint")}>
            ✨ {t("aiSearch")}
          </button>
          {data.total > 0 && (
            <button className="btn ghost" disabled={sumBusy} onClick={runSummary} title={t("folderSummary")}>
              {sumBusy ? "⏳" : t("summarizeBtn")}
            </button>
          )}
          <button className="btn ghost" onClick={() => setUrlOpen(!urlOpen)} title={t("fromUrlHint")}>🔗 {t("fromUrl")}</button>
          <button className="btn ghost" onClick={() => saveDesign({ ...design, view: design.view === "grid" ? "list" : "grid" })}>
            {design.view === "grid" ? "☰ List" : "▦ Grid"}
          </button>
          <button className="btn ghost" disabled={zipping || !data.total} onClick={downloadZip} title="Download all files in view as ZIP">
            {zipping ? "⏳ Zipping…" : "🗜 ZIP"}
          </button>
          <button className="btn ghost" onClick={() => setNewFolderOpen(true)}>📁 New folder</button>
          <button className="btn ghost" disabled={busy} onClick={() => bulkRef.current?.click()}>⬆ Bulk upload</button>
          <button className="btn primary" disabled={busy} onClick={() => oneRef.current?.click()}>⬆ Upload</button>
        </div>
      </div>

      <input ref={oneRef} type="file" hidden onChange={(e) => { doUpload(e.target.files, false); e.target.value = ""; }} />
      <input ref={bulkRef} type="file" multiple hidden onChange={(e) => { doUpload(e.target.files, true); e.target.value = ""; }} />

      {uploading && <div className="muted">Uploading…</div>}

      {/* web clipper helper */}
      <details className="card" style={{ marginBottom: 12 }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadSpaces(); }}>
        <summary style={{ cursor: "pointer" }}>👥 {t("spTitle")}</summary>
        <div className="hint" style={{ marginTop: 6 }}>{t("spHint")}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" placeholder={t("spNamePh")} value={spName} maxLength={40}
            onChange={(e) => setSpName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSpace()} style={{ width: 180 }} />
          <button className="btn ghost" disabled={spBusy || !spName.trim()} onClick={createSpace}>➕ {t("spCreate")}</button>
        </div>
        {spInviteTo && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small">✉ {spInviteTo}:</span>
            <input className="input" placeholder={t("spEmailPh")} value={spEmail} type="email"
              onChange={(e) => setSpEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && inviteMember(spInviteTo)} style={{ width: 200 }} />
            <button className="btn ghost" disabled={spBusy || !spEmail.trim()} onClick={() => inviteMember(spInviteTo)}>{t("spInvite")}</button>
            <button className="btn ghost" onClick={() => setSpInviteTo("")}>✕</button>
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {spList.length === 0 && <span className="muted small">{t("spNone")}</span>}
          {spList.map((s) => (
            <span key={s.folder} className="folder-chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <button className="link" onClick={() => { setFolder(s.folder); }}>{s.name}</button>
              <span className="muted small">{s.role === "owner" ? t("spOwner") : t("spMember")}</span>
              {s.role === "owner" && spInviteTo !== s.name && (
                <button className="link" onClick={() => setSpInviteTo(s.name)} title={t("spInvite")}>✉</button>
              )}
            </span>
          ))}
        </div>
      </details>

      <details className="card" style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer" }}>✂️ Web clipper — save any page into this Library</summary>
        <div className="hint" style={{ marginTop: 6 }}>
          1) Drag this button to your bookmarks bar:
          <a
            href={`javascript:(function(){var s=window.getSelection()+'';if(!s){var c=document.cloneNode(true);c.querySelectorAll('script,style,nav,footer,header,aside').forEach(function(n){n.remove()});s=(c.body.innerText||'').replace(/\\s+/g,' ').trim()}location.href='${(typeof window!=="undefined"?window.location.origin:"")}/?import='+encodeURIComponent(s.slice(0,40000))+'&title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href)})()`}
            onClick={(e) => e.preventDefault()}
            style={{ margin: "0 6px", fontWeight: 700 }}
          >
            ✂️ Clip to Silvestar
          </a>
          2) On any page, click the bookmark — the page text lands in Library/clippings, AI-searchable.
          3) Prefer an extension? Load the MV3 clipper from the repo's <code>extension/</code> folder.
        </div>
      </details>

      {/* import-from-URL panel */}
      {urlOpen && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>🔗 {t("fromUrl")}</b>
          <div className="hint">{t("fromUrlHint")}</div>
          <div className="row">
            <input value={urlVal} placeholder="https://example.com/report.pdf"
              onChange={(e) => setUrlVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importFromUrl()} />
            <button onClick={importFromUrl} disabled={urlBusy || !urlVal.trim()}>
              {urlBusy ? "⏳" : t("fromUrlBtn")}
            </button>
          </div>
        </div>
      )}

      {/* AI folder summary card */}
      {(sumBusy || sumText) && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>✨ {t("folderSummary")} — {folder || "root"}</b>
          {sumBusy ? <div className="muted">…</div> : (
            <>
              <div className="muted small">{sumFiles} file(s) analyzed</div>
              <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{sumText}</pre>
            </>
          )}
        </div>
      )}

      {/* AI semantic search panel */}
      {aiOpen && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>✨ {t("aiSearch")}</b>
          <div className="hint">{t("aiSearchHint")}</div>
          <div className="row">
            <input value={aiQuery} placeholder={t("aiSearchEmpty")}
              onChange={(e) => setAiQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runAiSearch()} />
            <button onClick={runAiSearch} disabled={aiBusy}>{aiBusy ? "…" : t("aiSearchBtn")}</button>
          </div>
          {aiResults.map((r) => (
            <div key={r.path} className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <span>
                <b>{r.title}</b> <span className="muted small">· {r.folder || "root"} · {r.score}</span>
                <div className="muted small">{r.snippet}</div>
              </span>
              <button className="btn tiny" onClick={() => chatWithFile({ path: r.path, name: r.title, indexed: true } as FileMeta)}>
                💬 {t("chatWithFile")}
              </button>
            </div>
          ))}
          {aiTried && !aiBusy && aiResults.length === 0 && (
            <div className="muted small">No matching files. Upload text-based files (PDF/Word/TXT…) so the AI can read them.</div>
          )}
        </div>
      )}

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
            <button key={f} className={`folder-chip ${hoverFolder === f ? "drop-hover" : ""}`}
              onClick={() => setFolder(f)}
              style={{ borderColor: hoverFolder === f ? design.accent : design.accent + "55" }}
              onDragOver={(e) => { if (dragPaths.length) { e.preventDefault(); e.stopPropagation(); setHoverFolder(f); } }}
              onDragLeave={() => setHoverFolder("")}
              onDrop={(e) => { if (dragPaths.length) { e.preventDefault(); e.stopPropagation(); setDragOver(false); dropOnFolder(f); } }}
            >
              📁 {f.split("/").pop()} <span className="muted small">({f.split("/").length > 1 ? f.split("/").slice(0, -1).join("/") + "/" : "root"})</span>
              {hoverFolder === f && <span className="small"> ⬅ drop</span>}
            </button>
          ))}
        </div>
      )}

      {/* drop hint */}
      {dragOver && <div className="drop-hint">⬇ Drop files to upload{folder ? ` into ${folder}` : ""}</div>}

      {/* bulk toolbar */}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <b>{selected.size}</b>&nbsp;selected
          <button className="btn tiny" onClick={() => bulkOp("move", folder)}>{folder ? `Move here (${folder})` : "Move to root"}</button>
          <button className="btn tiny" onClick={() => { const f2 = prompt("Move to folder (empty = root):", folder || ""); if (f2 !== null) bulkOp("move", f2); }}>➡ Move to…</button>
          <button className="btn tiny danger" onClick={() => bulkOp("delete")}>🗑 Delete</button>
          <button className="btn tiny ghost" onClick={clearSel}>Cancel</button>
        </div>
      )}

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
            <div key={f.path} className={`file-card ${dragPaths.includes(f.path) ? "dragging" : ""}`}
              style={{ borderColor: selected.has(f.path) ? design.accent : design.accent + "22" }}
              draggable
              onDragStart={(e) => { dragStart(f); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragPaths([]); setHoverFolder(""); }}
            >
              <label className="sel-box" title="Select">
                <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggleSel(f.path)} />
              </label>
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
              <button className="btn tiny" onClick={() => setShareTarget(f)} title="Public share link">🔗</button>
              <button className="btn tiny" onClick={() => openVersions(f)} title="Version history">🕓</button>
              {f.indexed && <button className="btn tiny" onClick={() => chatWithFile(f)} title={t("chatWithFile")}>💬</button>}
              <button className="btn tiny danger" onClick={() => doDelete(f)} title="Delete">🗑</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="file-table">
          <thead><tr><th></th><th>Name</th><th>Size</th><th>Folder</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.path} style={selected.has(f.path) ? { outline: `2px solid ${design.accent}` } : undefined}>
                <td><input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.has(f.path)} onChange={() => toggleSel(f.path)} /></td>
                <td><button className="link" onClick={() => openViewer(f)}>{icon(f.mime, f.name)} {f.name}</button></td>
                <td>{fmtSize(f.size)}</td>
                <td>{f.folder || "—"}</td>
                <td>{new Date(f.uploaded * 1000).toLocaleDateString()}</td>
                <td className="file-actions">
                  <button className="btn tiny" onClick={() => dl(f)}>⬇</button>
                  <button className="btn tiny" onClick={() => { setRenameTarget(f); setRenameVal(f.name); }}>✏</button>
                <button className="btn tiny" onClick={() => { setMoveTarget(f); setMoveVal(f.folder); }}>➡</button>
                <button className="btn tiny" onClick={() => setShareTarget(f)} title="Public share link">🔗</button>                  <button className="btn tiny" onClick={() => openVersions(f)} title="Version history">🕓</button>
                  {f.indexed && <button className="btn tiny" onClick={() => chatWithFile(f)} title={t("chatWithFile")}>💬</button>}
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
            {viewText && (
              /\.(md|markdown)$/i.test(viewFile.name)
                ? <div className="viewer-text">{renderMarkdown(viewText.slice(0, 20000))}</div>
                : <pre className="viewer-text">{viewText.slice(0, 20000)}</pre>
            )}
            <div className="row gap" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => dl(viewFile)}>⬇ Download</button>
              <span className="muted small">{fmtSize(viewFile.size)} · {viewFile.mime}{viewFile.indexed ? " · searchable by AI" : ""}</span>
            </div>
          </div>
        </Modal>
      )}

      {/* share options modal */}
      {shareTarget && (
        <Modal title={`🔗 Share "${shareTarget.name}"`} onClose={() => { setShareTarget(null); setSharePass(""); }}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Anyone with the link can view this file. Add a password to require it before opening.
          </div>
          <input className="input" type="text" placeholder="Password (optional)" value={sharePass}
            onChange={(e) => setSharePass(e.target.value)} autoFocus />
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => doShare(shareTarget, sharePass)}>
              {sharePass ? "Create protected link" : "Create public link"}
            </button>
            <button className="btn ghost" onClick={() => { setShareTarget(null); setSharePass(""); }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* share link modal */}
      {shareUrl && (
        <Modal title="🔗 Public share link" onClose={() => setShareUrl("")}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Anyone with this link can view this file.
          </div>
          <input className="input" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} autoFocus />
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => { copyText(shareUrl); toast("Link copied ✓", "ok"); }}>Copy link</button>
            <button className="btn ghost" onClick={() => { window.open(shareUrl, "_blank", "noopener"); }}>Open</button>
            <button className="btn ghost" onClick={() => setShareUrl("")}>Done</button>
          </div>
        </Modal>
      )}

      {/* versions modal */}
      {verTarget && (
        <Modal title={`🕓 Versions of "${verTarget.name}"`} onClose={() => setVerTarget(null)}>
          {verList.length === 0 && <div className="hint">No previous versions yet. Re-upload the same filename to create one (keeps last 3).</div>}
          {verList.map((v) => (
            <div key={v.ts} className="hit">
              <div className="t">📦 {new Date(v.ts * 1000).toLocaleString()} · {fmtSize(v.size)}</div>
              <div className="row gap" style={{ marginTop: 6 }}>
                <button className="btn tiny" onClick={() => window.open(`${API}/api/v1/files/download?path=${encodeURIComponent(v.vpath)}`, "_blank", "noopener")}>Download</button>
                <button className="btn tiny primary" onClick={() => doRestore(v.ts)}>Restore</button>
              </div>
            </div>
          ))}
        </Modal>
      )}

      {/* rename modal */}
      {renameTarget && (
        <Modal title="Rename file" onClose={() => { setRenameTarget(null); setSuggested(""); }}>
          <input className="input" value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus />
          {suggested && <div className="muted small" style={{ marginTop: 4 }}>✨ AI: {suggested}</div>}
          <div className="row gap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={doRename}>Save</button>
            {renameTarget.indexed && <button className="btn ghost" onClick={aiSuggestName}>{t("suggestNameBtn")}</button>}
            <button className="btn ghost" onClick={() => { setRenameTarget(null); setSuggested(""); }}>Cancel</button>
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
