const $ = (id) => document.getElementById(id);

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  $("title").value = tab.title || "";
  $("url").value = tab.url || "";
  // extract readable text from the page
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clone = document.cloneNode(true);
        clone.querySelectorAll("script,style,nav,footer,header,aside").forEach((n) => n.remove());
        return (clone.body?.innerText || "").replace(/\s+/g, " ").trim();
      },
    });
    $("text").value = (res.result || "").slice(0, 40000);
  } catch {}
  const cfg = await chrome.storage.local.get(["api", "token"]);
  if (cfg.api) $("api").value = cfg.api;
  if (cfg.token) $("token").value = cfg.token;
});

$("clip").onclick = async () => {
  const api = ($("api").value || "https://silvestar-api.vercel.app").replace(/\/$/, "");
  const token = $("token").value.trim();
  await chrome.storage.local.set({ api, token });
  const msg = $("msg");
  msg.className = ""; msg.textContent = "Uploading…";
  try {
    const title = ($("title").value || "clip").slice(0, 80).replace(/[\\/:*?"<>|]/g, "-");
    const body = [
      `# ${$("title").value || "Web clip"}`,
      `Source: ${$("url").value}`,
      "",
      $("text").value,
    ].join("\n");
    const fd = new FormData();
    fd.append("file", new Blob([body], { type: "text/markdown" }), `${title}.md`);
    fd.append("folder", $("folder").value.trim() || "clippings");
    const r = await fetch(`${api}/api/v1/files/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.status);
    msg.className = "ok";
    msg.textContent = `✓ Clipped as ${j.name} (AI-indexed: ${j.indexed ? "yes" : "no"})`;
  } catch (e) {
    msg.className = "err";
    msg.textContent = `✗ ${e.message || e}`;
  }
};
