# Silvestar Web Clipper (Chrome/Edge, MV3)

Clip any webpage straight into your Silvestar Library — one click, fully AI-searchable.

## Install (2 minutes, free)
1. Download this `extension/` folder (or the repo) to your computer.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select the `extension/` folder.
5. Click the 🟣 icon → open **Settings** inside the popup:
   - API URL: `https://silvestar-api.vercel.app`
   - Session token: paste your `sv-session` value (from the web app:
     DevTools → Application → Local Storage → `sv-session`).
6. Browse any page → click the icon → **Clip into Library**.

The clip lands in `Library/clippings/<title>.md` with the source URL, and the
AI can search and cite it immediately.

## Alternative: no install
In the web app, Library → **🔗 Import from URL** does the same for single links.
