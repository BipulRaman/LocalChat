// LocalChat — admin dashboard.

"use strict";

const $ = (id) => document.getElementById(id);
let token = null;

function init() {
  const urlTok = new URLSearchParams(location.search).get("token");
  if (urlTok) {
    localStorage.setItem("localchat-admin-token", urlTok);
    history.replaceState({}, "", location.pathname);
    token = urlTok;
  } else {
    token = localStorage.getItem("localchat-admin-token");
  }
  if (token) { showDash(); refreshAll(); }
}

async function saveToken(e) {
  e.preventDefault();
  const t = $("tokenInput").value.trim();
  if (!t) return;
  token = t;
  localStorage.setItem("localchat-admin-token", t);
  showDash();
  try { await refreshAll(); } catch { /* unauthorized handled */ }
}
function logoutAdmin() {
  token = null;
  localStorage.removeItem("localchat-admin-token");
  $("dash").classList.add("hidden");
  $("auth").classList.remove("hidden");
}
function showDash() {
  $("auth").classList.add("hidden");
  $("dash").classList.remove("hidden");
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { logoutAdmin(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(await res.text() || res.statusText);
  return res.json();
}

const fmtSize = (n) => {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
};
const fmtDur = (s) => {
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function refreshAll() {
  try {
    const [stats, users, channels, uploads, settings, share] = await Promise.all([
      api("/stats"), api("/users"), api("/channels"),
      api("/uploads"), api("/settings"), api("/share"),
    ]);
    renderStats(stats);
    renderUsers(users.users);
    renderChannels(channels.channels);
    renderUploads(uploads.files);
    loadSettings(settings);
    renderShare(share.entries || []);
    loadLogs();
    checkForUpdates(false);
  } catch (err) { console.error(err); toast("Error: " + err.message); }
}

function renderStats(s) {
  const m = s.metrics || {};
  const cards = [
    ["Online users", s.users_online ?? 0, null],
    ["Channels",     s.channels ?? 0, null],
    ["Messages",     m.total_messages ?? 0, "since start"],
    ["Uploads",      m.total_uploads ?? 0, fmtSize(m.bytes_uploaded ?? 0) + " total"],
    ["Disk used",    fmtSize(s.upload_dir_bytes ?? 0), "uploads folder"],
    ["Uptime",       fmtDur(m.uptime_s ?? 0), null],
    ["Connections",  m.active_connections ?? 0, `${m.total_connections ?? 0} lifetime`],
  ];
  const host = $("cards"); host.innerHTML = "";
  for (const [k, v, sub] of cards) {
    host.insertAdjacentHTML("beforeend",
      `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`);
  }
}

function renderUsers(list) {
  const tb = document.querySelector("#usersTable tbody");
  if (!list.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">No users online</td></tr>`; return; }
  tb.innerHTML = list.map((u) => `
    <tr>
      <td><code>${u.id}</code></td>
      <td>${esc(u.username)}</td>
      <td><code>${esc(u.ip || "")}</code></td>
      <td>${new Date((u.joinedAt || 0) * 1000).toLocaleTimeString()}</td>
      <td>${u.msgCount || 0}</td>
      <td>
        <button class="btn btn-ghost" data-act="kick" data-id="${u.id}">Kick</button>
        <button class="btn btn-danger" data-act="ban"  data-id="${u.id}">Ban</button>
      </td>
    </tr>`).join("");
  tb.onclick = async (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === "kick") { await api(`/kick/${id}`, { method: "POST" }); toast("User kicked"); }
      if (btn.dataset.act === "ban")  { await api(`/ban/${id}`,  { method: "POST" }); toast("User banned"); }
      refreshAll();
    } catch (err) { toast("Error: " + err.message); }
  };
}

function renderChannels(list) {
  const tb = document.querySelector("#channelsTable tbody");
  if (!list.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">No channels</td></tr>`; return; }
  tb.innerHTML = list.map((c) => `
    <tr>
      <td><code>${esc(c.id)}</code></td>
      <td>${c.kind}${c.isPrivate ? " 🔒" : ""}${c.kind === "dm" ? " 🔐 E2EE" : ""}</td>
      <td>${esc(c.name || "")}</td>
      <td>${(c.members || []).length}</td>
      <td>${c.kind === "lobby" ? "" : `<button class="btn btn-danger" data-act="del" data-id="${esc(c.id)}">Delete</button>`}</td>
    </tr>`).join("");
  tb.onclick = async (e) => {
    const btn = e.target.closest("button"); if (!btn || btn.dataset.act !== "del") return;
    if (!confirm(`Delete channel ${btn.dataset.id}?`)) return;
    try {
      await api(`/channel/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
      toast("Channel deleted"); refreshAll();
    } catch (err) { toast("Error: " + err.message); }
  };
}

function renderUploads(files) {
  const tb = document.querySelector("#uploadsTable tbody");
  if (!files.length) { tb.innerHTML = `<tr><td colspan="3" class="muted">No uploaded files</td></tr>`; return; }
  tb.innerHTML = files.map((f) => `
    <tr>
      <td><a href="/uploads/${encodeURIComponent(f.name)}" target="_blank">${esc(f.name)}</a></td>
      <td>${fmtSize(f.size)}</td>
      <td><button class="btn btn-danger" data-name="${esc(f.name)}">Delete</button></td>
    </tr>`).join("");
  tb.onclick = async (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    if (!confirm(`Delete ${btn.dataset.name}?`)) return;
    try {
      await api(`/upload/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
      toast("File deleted"); refreshAll();
    } catch (err) { toast("Error: " + err.message); }
  };
}

function renderShare(entries) {
  const host = $("shareGrid");
  if (!host) return;
  if (!entries.length) { host.innerHTML = `<p class="muted">No reachable addresses detected.</p>`; return; }
  host.innerHTML = entries.map((e) => `
    <div class="share-card">
      <div class="share-qr">${e.qr}</div>
      <div class="share-meta">
        <div class="share-label">${esc(e.label)}</div>
        <a class="share-url" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>
        <div class="share-actions">
          <button class="btn btn-ghost" data-act="copy" data-url="${esc(e.url)}">Copy link</button>
          <button class="btn btn-ghost" data-act="open" data-url="${esc(e.url)}">Open</button>
        </div>
      </div>
    </div>`).join("");
  host.onclick = async (ev) => {
    const btn = ev.target.closest("button"); if (!btn) return;
    const url = btn.dataset.url;
    if (btn.dataset.act === "copy") {
      try { await navigator.clipboard.writeText(url); toast("Link copied"); }
      catch { toast("Copy failed"); }
    } else if (btn.dataset.act === "open") {
      window.open(url, "_blank", "noopener");
    }
  };
}

function loadSettings(s) {
  $("s_port").value = s.port;
  $("s_max_upload").value = s.maxUploadMb;
  $("s_history").value = s.historyRam;
  $("s_rotate").value = s.rotateMb;
  $("s_lan_admin").checked = s.allowLanAdmin;
  $("s_autostart").checked = s.autostart;
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    const body = {
      port: parseInt($("s_port").value, 10) || 0,
      maxUploadMb: parseInt($("s_max_upload").value, 10),
      historyRam: parseInt($("s_history").value, 10),
      rotateMb: parseInt($("s_rotate").value, 10),
      allowLanAdmin: $("s_lan_admin").checked,
      autostart: $("s_autostart").checked,
    };
    const r = await api("/settings", { method: "POST", body: JSON.stringify(body) });
    $("settingsStatus").textContent = r.restart_required
      ? "Saved. Restart the server to apply the port change."
      : "Saved.";
    setTimeout(() => $("settingsStatus").textContent = "", 4000);
  } catch (err) {
    $("settingsStatus").textContent = "Error: " + err.message;
  }
}

async function broadcast(e) {
  e.preventDefault();
  const text = $("bcast").value.trim();
  if (!text) return;
  try {
    await api("/broadcast", { method: "POST", body: JSON.stringify({ text }) });
    $("bcast").value = "";
    toast("Announcement sent");
  } catch (err) { toast("Error: " + err.message); }
}

Object.assign(window, { saveToken, logoutAdmin, refreshAll, saveSettings, broadcast, toggleTheme, restartServer, shutdownServer, loadLogs, checkForUpdates });

// ── App logs ────────────────────────────────────────────────────────
let _logsTimer = null;
async function loadLogs() {
  const lines = parseInt($("logsLines").value, 10) || 200;
  try {
    const r = await api(`/logs?lines=${lines}`);
    const view = $("logsView");
    view.textContent = (r.lines || []).join("\n");
    // Pin to bottom so newest entries are visible.
    view.scrollTop = view.scrollHeight;
    $("logsMeta").textContent = r.path
      ? `${r.lines.length} of ${r.total} lines · ${r.path}`
      : "Log file not initialized.";
  } catch (err) {
    $("logsMeta").textContent = "Error loading logs: " + err.message;
  }
}
function setupLogsAuto() {
  const cb = $("logsAuto");
  if (!cb) return;
  const apply = () => {
    if (_logsTimer) { clearInterval(_logsTimer); _logsTimer = null; }
    if (cb.checked) _logsTimer = setInterval(loadLogs, 5000);
  };
  cb.addEventListener("change", apply);
  apply();
}

// ── Update check (queries GitHub releases from the browser) ─────────
const REPO = "BipulRaman/LocalChat";
let _currentVersion = null;
let _lastUpdateCheck = 0;

async function fetchCurrentVersion() {
  if (_currentVersion) return _currentVersion;
  try {
    const r = await fetch("/api/info", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      _currentVersion = j.version || null;
    }
  } catch {}
  return _currentVersion;
}

function compareSemver(a, b) {
  const parse = (v) => String(v).replace(/^v/i, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const da = A[i] || 0, db = B[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

async function checkForUpdates(forceUi) {
  // Throttle background checks to once per hour.
  const now = Date.now();
  if (!forceUi && now - _lastUpdateCheck < 3600 * 1000) return;
  _lastUpdateCheck = now;

  const cur = await fetchCurrentVersion();
  if ($("updCurrent")) $("updCurrent").textContent = cur ? "v" + cur : "—";
  const latestEl = $("updLatest");
  const dlBtn = $("updDownload");
  const status = $("updStatus");
  if (latestEl) latestEl.textContent = "checking…";
  if (status) status.textContent = "";

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "Accept": "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error("GitHub API " + r.status);
    const rel = await r.json();
    const tag = (rel.tag_name || "").trim();
    if (!tag) throw new Error("no tag in release");
    if (latestEl) latestEl.textContent = tag;

    const cmp = cur ? compareSemver(cur, tag) : -1;
    if (cmp < 0) {
      // Prefer a Windows .exe asset if present, else the release page.
      let url = rel.html_url || `https://github.com/${REPO}/releases/latest`;
      const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name) || /\.msi$/i.test(a.name));
      if (asset && asset.browser_download_url) url = asset.browser_download_url;
      if (dlBtn) {
        dlBtn.href = url;
        dlBtn.classList.remove("hidden");
        dlBtn.textContent = asset ? `Download ${asset.name}` : "Open release page";
      }
      if (status) status.textContent = `A newer version is available (${tag}).`;
      if (forceUi) toast(`Update available: ${tag}`);
    } else {
      if (dlBtn) dlBtn.classList.add("hidden");
      if (status) status.textContent = "You are on the latest version.";
    }
  } catch (err) {
    if (latestEl) latestEl.textContent = "unavailable";
    if (status) status.textContent = "Could not check for updates: " + err.message;
  }
}

async function restartServer() {
  if (!confirm("Restart the server now? Active connections will drop and reconnect automatically.")) return;
  try {
    await api("/restart", { method: "POST" });
    toast("Restarting…");
    waitForServerBack();
  } catch (err) {
    // The server may close the socket before responding — that's expected.
    toast("Restart triggered. Reconnecting…");
    waitForServerBack();
  }
}

async function shutdownServer() {
  if (!confirm("Shut down the server? You'll need to start it again manually.")) return;
  try {
    await api("/shutdown", { method: "POST" });
  } catch {}
  toast("Server shutting down.");
}

function waitForServerBack() {
  let tries = 0;
  const max = 30;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch("/api/info", { cache: "no-store" });
      if (r.ok) { toast("Server back online — reloading…"); setTimeout(() => location.reload(), 600); return; }
    } catch {}
    if (tries < max) setTimeout(tick, 700);
    else toast("Could not reconnect. Reload the page manually.");
  };
  setTimeout(tick, 1500);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("localchat-theme", next);
  updateThemeIcon();
}
function updateThemeIcon() {
  const isDark = (document.documentElement.getAttribute("data-theme") || "dark") === "dark";
  const sun  = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const moon = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const btn = document.getElementById("themeBtn");
  if (btn) btn.innerHTML = (isDark ? sun : moon) + (isDark ? " Light" : " Dark");
}
updateThemeIcon();
init();
setupLogsAuto();
setInterval(() => { if (token) api("/stats").then(renderStats).catch(() => {}); }, 5000);
