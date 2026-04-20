// LocalChat — admin dashboard (SPA shell).
//
// Architecture:
//   - Single-page app with a left rail. Each rail item renders a section
//     into <main id="adMain"> on demand.
//   - All state lives in `S`. Data is refreshed lazily per section, plus
//     a 5-second poll of /stats keeps the topbar metrics + Overview live.
//   - DOM helpers: `el()` builds nodes (no innerHTML for user-controlled
//     data). `esc()` is reserved for the few static-template strings.

"use strict";

// ─── DOM helpers ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;          // explicit opt-in
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") { if (v) n.setAttribute(k, ""); }
    else n.setAttribute(k, v);
  }
  if (children != null) {
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c == null || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  return n;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── Formatting ─────────────────────────────────────────────────────
const fmtSize = (n) => {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
};
const fmtDur = (s) => {
  if (s == null) return "—";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};
const fmtRel = (ts) => {
  if (!ts) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 5) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
};
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleString() : "—";

// ─── State ──────────────────────────────────────────────────────────
const S = {
  route: "overview",
  data: { stats: null, users: [], channels: [], uploads: [], settings: null,
          share: [], info: null, logs: { lines: [], total: 0, path: null } },
  logs: { auto: false, follow: true, filter: "", level: "all", lines: 200, errors: 0 },
  upload: { sort: "date", filter: "", selected: new Set() },
  user: { onlineOnly: false, filter: "" },
  sessions: { events: [], path: null, userFilter: null, eventFilter: "all", textFilter: "", limit: 500, loading: false },
  settingsTab: "general",
  pollTimer: null,
  logsTimer: null,
  update: { current: null, latest: null, url: null, isNewer: false, lastChecked: 0, dismissed: 0 },
  recent: [],   // recent-activity feed (parsed from log)
  prevOnline: null,
  onlineDelta: null,
};

// ─── API ────────────────────────────────────────────────────────────
// Admin endpoints are gated to loopback at the server, so no token is
// needed (and no token is sent). A 403 means "you opened the dashboard
// from another device" — surface that to the user instead of looping.
async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 403) { onForbidden(); throw new Error("admin is host-only"); }
  if (!res.ok) throw new Error(await res.text() || res.statusText);
  return res.json();
}

function onForbidden() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  if (S.logsTimer) { clearInterval(S.logsTimer); S.logsTimer = null; }
  const main = $("adMain");
  if (main) {
    main.replaceChildren(el("div", { class: "ad-empty" }, [
      el("div", { class: "ad-empty-title" }, "Admin dashboard is host-only"),
      el("div", { class: "muted sm" }, "Open this page from the computer that is running LocalChat (https://localhost) to use the admin tools."),
    ]));
  }
}

// ─── Toast & modal ──────────────────────────────────────────────────
function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function confirmDialog({ title = "Confirm", body = "", okText = "OK", okClass = "btn-primary", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const root = $("adModal");
    root.classList.remove("hidden");
    const close = (ok) => { root.classList.add("hidden"); root.replaceChildren(); resolve(ok); };
    const panel = el("div", { class: "ad-modal-panel", role: "document" }, [
      el("h3", { class: "ad-modal-title" }, title),
      el("div", { class: "ad-modal-body" }, body.split("\n").map((line) => el("p", null, line))),
      el("div", { class: "ad-modal-foot" }, [
        el("button", { class: "btn btn-ghost", type: "button", onclick: () => close(false) }, cancelText),
        el("button", { class: `btn ${okClass}`, type: "button", onclick: () => close(true) }, okText),
      ]),
    ]);
    root.replaceChildren(panel);
    root.onclick = (e) => { if (e.target === root) close(false); };
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(false); document.removeEventListener("keydown", esc); }
      if (e.key === "Enter")  { close(true);  document.removeEventListener("keydown", esc); }
    }, { once: false });
    setTimeout(() => panel.querySelector(".btn-ghost")?.focus(), 30);
  });
}

// One-time display of an admin-issued temporary password. The string
// is only ever returned once by the server, so make it easy to copy
// before the dialog is dismissed.
function showTempPasswordDialog(username, password) {
  const root = $("adModal");
  root.classList.remove("hidden");
  const close = () => { root.classList.add("hidden"); root.replaceChildren(); };
  const pwInput = el("input", {
    class: "ad-input",
    type: "text",
    readonly: true,
    value: password,
    style: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.1em;letter-spacing:.05em;",
    onclick: (e) => e.target.select(),
  });
  const copyBtn = el("button", {
    class: "btn btn-primary", type: "button",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(password);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      } catch {
        pwInput.select();
        document.execCommand?.("copy");
      }
    },
  }, "Copy");
  const panel = el("div", { class: "ad-modal-panel", role: "document" }, [
    el("h3", { class: "ad-modal-title" }, "Temporary password for " + username),
    el("div", { class: "ad-modal-body" }, [
      el("p", null, "Share this password with the user privately. They will be signed out and must use it to log in, then choose a new password."),
      el("p", { class: "muted xs" }, "This is the only time the password is shown."),
      el("div", { style: "display:flex;gap:8px;align-items:stretch;margin-top:8px;" }, [
        pwInput, copyBtn,
      ]),
    ]),
    el("div", { class: "ad-modal-foot" }, [
      el("button", { class: "btn btn-primary", type: "button", onclick: close }, "Done"),
    ]),
  ]);
  root.replaceChildren(panel);
  root.onclick = (e) => { if (e.target === root) close(); };
  setTimeout(() => pwInput.focus(), 30);
}

// ─── Top-level orchestrator ─────────────────────────────────────────
async function refreshAll() {
  try {
    // Fetch in parallel; everything else can degrade gracefully.
    const [info, stats, users, channels, uploads, settings, share] = await Promise.all([
      fetch("/api/info").then((r) => r.ok ? r.json() : null).catch(() => null),
      api("/stats"), api("/users"), api("/channels"),
      api("/uploads"), api("/settings"), api("/share"),
    ]);
    S.data.info = info;
    S.data.stats = stats;
    S.data.users = users.users || [];
    S.data.channels = channels.channels || [];
    S.data.uploads = uploads.files || [];
    S.data.settings = settings;
    S.data.share = share.entries || [];
    onLiveOk();
    renderTopbar();
    renderRail();
    renderRoute();
    // Best-effort secondary refreshes.
    loadLogs(true);
    checkForUpdates(false);
  } catch (err) {
    onLiveDown(err);
  }
}

function onLiveOk() {
  $("adLive")?.classList.remove("warn", "off");
  $("adLive")?.classList.add("ok");
  if ($("adLive")) $("adLive").lastChild.textContent = "live";
}
function onLiveDown(err) {
  console.warn(err);
  $("adLive")?.classList.remove("ok", "warn");
  $("adLive")?.classList.add("off");
  if ($("adLive")) $("adLive").lastChild.textContent = "offline";
  toast("Connection error: " + (err?.message || err));
}

function renderTopbar() {
  const v = S.data.info?.version;
  if (v) $("adVersion").textContent = "v" + v;
}

function renderRail() {
  $("navUsers").textContent     = S.data.users.length || "";
  if ($("navSessions")) {
    const online = S.data.users.filter((u) => u.online).length;
    $("navSessions").textContent = online ? online + " on" : "";
  }
  $("navChannels").textContent  = S.data.channels.length || "";
  $("navUploads").textContent   = S.data.uploads.length || "";
  $("navLogs").textContent      = S.logs.errors || "";
  $("navLogs").classList.toggle("hidden", !S.logs.errors);
}

function setRoute(name) {
  S.route = name;
  document.querySelectorAll(".ad-nav li").forEach((li) =>
    li.classList.toggle("active", li.dataset.route === name));
  // Close mobile rail on navigate.
  $("adRail")?.classList.remove("open");
  renderRoute();
  try { history.replaceState({}, "", "#" + name); } catch {}
}

function renderRoute() {
  const main = $("adMain");
  main.scrollTop = 0;
  const sec = sections[S.route] || sections.overview;
  main.replaceChildren(sec());
}

// ─── Sections ───────────────────────────────────────────────────────
const sections = {
  overview:  renderOverview,
  users:     renderUsersSection,
  sessions:  renderSessionsSection,
  channels:  renderChannelsSection,
  uploads:   renderUploadsSection,
  logs:      renderLogsSection,
  share:     renderShareSection,
  broadcast: renderBroadcastSection,
  settings:  renderSettingsSection,
};

// ── Overview ────────────────────────────────────────────────────────
function renderOverview() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader("Overview", "Live snapshot of the server."));

  const s = S.data.stats || {};
  const m = s.metrics || {};
  const cfg = S.data.settings || {};
  const uploadBudget = (cfg.maxUploadMb || 0) * 1024 * 1024 * Math.max(1, S.data.users.length || 1);
  const uploadPct = uploadBudget ? Math.min(100, Math.round((s.upload_dir_bytes || 0) / uploadBudget * 100)) : 0;

  // Detect online delta vs last sample.
  if (S.prevOnline != null && S.prevOnline !== s.users_online) {
    S.onlineDelta = s.users_online - S.prevOnline;
  }
  S.prevOnline = s.users_online;

  const grid = el("div", { class: "ad-stat-grid" });
  grid.append(
    statTile("Online users",  s.users_online ?? 0,
             S.onlineDelta != null ? `${S.onlineDelta > 0 ? "▲ +" : "▼ "}${S.onlineDelta} since last refresh` : "—",
             "users", () => setRoute("users")),
    statTile("Channels",      s.channels ?? 0,
             `${S.data.channels.filter((c) => c.isPrivate).length} private`,
             "channels", () => setRoute("channels")),
    statTile("Uploads",       S.data.uploads.length,
             fmtSize(s.upload_dir_bytes ?? 0) + " stored",
             "uploads", () => setRoute("uploads")),
    statTile("Messages",      m.total_messages ?? 0,
             `${m.active_connections ?? 0} live conns · ${m.total_connections ?? 0} lifetime`),
    statTile("Uptime",        fmtDur(m.uptime_s ?? 0), null),
    statTile("Disk usage",    fmtSize(s.upload_dir_bytes ?? 0),
             uploadBudget ? `${uploadPct}% of budget` : null,
             null, null,
             uploadBudget ? uploadPct : null),
  );
  root.append(grid);

  // Recent activity (parsed log tail)
  const act = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Recent activity"),
      el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => setRoute("logs") }, "View all logs"),
    ]),
    el("div", { class: "ad-activity", id: "adActivity" }, renderActivityItems()),
  ]);
  root.append(act);

  // Inline broadcast quick-action.
  const bcast = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [el("h3", null, "Quick announcement")]),
    el("form", { class: "ad-broadcast", onsubmit: (e) => { e.preventDefault(); broadcast(e); } }, [
      el("input", { id: "bcast", type: "text", placeholder: "Send a system message to #general…", required: true, maxlength: 500 }),
      el("button", { class: "btn btn-primary", type: "submit" }, "Send"),
    ]),
  ]);
  root.append(bcast);

  return root;
}

function renderActivityItems() {
  const items = S.recent.slice(0, 12);
  if (!items.length) return [el("p", { class: "muted sm" }, "No recent activity. Logs will appear here as users join, send messages, or the server emits events.")];
  return items.map((it) => el("div", { class: "ad-act-item " + (it.kind || "") }, [
    el("span", { class: "ad-act-dot" }),
    el("span", { class: "ad-act-text" }, it.text),
    el("span", { class: "muted xs ad-act-time", title: it.iso || "" }, it.rel || ""),
  ]));
}

function statTile(label, value, sub, route, onclick, pct) {
  const tile = el("div", {
    class: "ad-stat" + (onclick ? " clickable" : ""),
    onclick: onclick || undefined,
    role: onclick ? "button" : null,
    tabindex: onclick ? "0" : null,
    onkeydown: onclick ? (e) => { if (e.key === "Enter" || e.key === " ") onclick(); } : null,
  }, [
    el("div", { class: "ad-stat-k" }, label),
    el("div", { class: "ad-stat-v" }, String(value)),
    sub ? el("div", { class: "ad-stat-sub" }, sub) : null,
    pct != null ? el("div", { class: "ad-stat-bar" }, [
      el("div", { class: "ad-stat-bar-fill " + (pct > 90 ? "danger" : pct > 70 ? "warn" : ""), style: `width:${pct}%` }),
    ]) : null,
  ]);
  return tile;
}

// ── Users ───────────────────────────────────────────────────────────
function renderUsersSection() {
  const root = el("section", { class: "ad-section" });
  const total = S.data.users.length;
  const online = S.data.users.filter((u) => u.online).length;
  root.append(sectionHeader(
    `Users (${online} online · ${total} total)`,
    "Every user that has ever connected. Click History for the full session log."
  ));

  const toolbar = el("div", { class: "ad-toolbar" }, [
    el("input", {
      type: "search", placeholder: "Filter username or IP…", class: "ad-search", value: S.user.filter,
      oninput: (e) => { S.user.filter = e.target.value.toLowerCase(); paintUsers(); },
    }),
    el("label", { class: "ad-toggle" }, [
      el("input", { type: "checkbox", checked: S.user.onlineOnly,
        onchange: (e) => { S.user.onlineOnly = e.target.checked; paintUsers(); } }),
      el("span", null, "Show online only"),
    ]),
    el("span", { class: "ad-toolbar-sp" }),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: refreshAll }, "Refresh"),
  ]);
  root.append(toolbar);

  const list = el("div", { class: "ad-user-list", id: "adUserList" });
  root.append(list);
  paintUsers(list);
  return root;
}

function paintUsers(host) {
  host = host || $("adUserList");
  if (!host) return;
  const q = S.user.filter;
  let list = S.data.users;
  if (S.user.onlineOnly) list = list.filter((u) => u.online);
  if (q) list = list.filter((u) => (u.username || "").toLowerCase().includes(q) || (u.ip || u.lastIp || "").toLowerCase().includes(q));
  if (!list.length) {
    host.replaceChildren(emptyState("No users", q ? "Nothing matches your filter." : "Nobody is connected right now."));
    return;
  }
  host.replaceChildren(...list.map((u) => userRow(u)));
}

function userRow(u) {
  const initial = (u.username?.[0] || "?").toUpperCase();
  const online = !!u.online;
  const sub = [];
  const ip = u.ip || u.lastIp;
  if (ip) sub.push(el("span", null, ip));
  if (sub.length) sub.push(el("span", { class: "ad-sep" }, "·"));
  if (online) {
    sub.push(el("span", { title: fmtTime(u.lastConnect) },
      "online since " + fmtRel(u.lastConnect) +
      (u.sockets > 1 ? ` (${u.sockets} sockets)` : "")));
  } else if (u.lastSeen) {
    sub.push(el("span", { title: fmtTime(u.lastSeen) }, "last seen " + fmtRel(u.lastSeen)));
  } else {
    sub.push(el("span", { title: fmtTime(u.joinedAt) }, "joined " + fmtRel(u.joinedAt)));
  }
  sub.push(el("span", { class: "ad-sep" }, "·"));
  sub.push(el("span", null, (u.totalSessions || 0) + " sessions"));
  sub.push(el("span", { class: "ad-sep" }, "·"));
  sub.push(el("span", null, (u.msgCount || 0) + " msgs"));

  return el("div", { class: "ad-row ad-user-row" + (online ? " online" : " offline") }, [
    el("div", { class: "ad-avatar", style: `background:${u.color || colorForName(u.username || "")}`, title: u.username }, [
      document.createTextNode(initial),
      el("span", { class: "ad-presence-dot " + (online ? "on" : "off"),
                   title: online ? "Online" : "Offline" }),
    ]),
    el("div", { class: "ad-row-meta" }, [
      el("div", { class: "ad-row-title" }, [
        document.createTextNode(u.username || "—"),
        el("span", { class: "ad-tag", title: "User ID" }, "#" + u.id),
        el("span", { class: "ad-tag ad-tag-" + (online ? "ok" : "info") }, online ? "online" : "offline"),
      ]),
      el("div", { class: "ad-row-sub muted xs" }, sub),
    ]),
    el("div", { class: "ad-row-actions" }, [
      el("button", { class: "btn btn-ghost btn-sm", type: "button",
        onclick: () => { S.sessions.userFilter = u.id; setRoute("sessions"); } }, "History"),
      online ? el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => {
        try { await api(`/kick/${u.id}`, { method: "POST" }); toast("Kicked " + u.username); refreshAll(); }
        catch (err) { toast("Error: " + err.message); }
      } }, "Kick") : null,
      el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => {
        const ok = await confirmDialog({
          title: "Reset password?",
          body: `Reset the password for ${u.username}?\n\nA new temporary password will be generated. ${u.username} will be signed out and must use the temporary password to log in, then choose a new one.`,
          okText: "Reset password", okClass: "btn-primary",
        });
        if (!ok) return;
        try {
          const res = await api(`/reset-password/${u.id}`, { method: "POST" });
          showTempPasswordDialog(u.username, res.tempPassword);
          refreshAll();
        } catch (err) { toast("Error: " + err.message); }
      } }, "Reset password"),
      el("button", { class: "btn btn-danger btn-sm", type: "button", onclick: async () => {
        const ok = await confirmDialog({
          title: "Ban user?",
          body: `Ban ${u.username} (${ip || "no IP"})?\n\nThis adds them to banned-users and banned-IPs and disconnects them. You can unban from Settings → Access.`,
          okText: "Ban", okClass: "btn-danger",
        });
        if (!ok) return;
        try { await api(`/ban/${u.id}`, { method: "POST" }); toast("Banned " + u.username); refreshAll(); }
        catch (err) { toast("Error: " + err.message); }
      } }, "Ban"),
    ]),
  ]);
}

// ── Sessions (audit log) ────────────────────────────────────────────
function renderSessionsSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader(
    "Session history",
    "Append-only audit of every WebSocket connect and disconnect, with IP and duration. Persists across server restarts."
  ));

  const focusedUser = S.sessions.userFilter
    ? S.data.users.find((u) => u.id === S.sessions.userFilter)
    : null;

  const toolbar = el("div", { class: "ad-toolbar" }, [
    el("input", {
      type: "search", placeholder: "Filter username or IP…", class: "ad-search",
      value: S.sessions.textFilter,
      oninput: (e) => { S.sessions.textFilter = e.target.value.toLowerCase(); paintSessions(); },
    }),
    el("label", { class: "ad-toolbar-label muted sm" }, "Event"),
    el("select", { class: "ad-select", onchange: (e) => { S.sessions.eventFilter = e.target.value; paintSessions(); } }, [
      ["all", "All"], ["connect", "Connected"], ["disconnect", "Disconnected"],
    ].map(([v, l]) => el("option", { value: v, selected: S.sessions.eventFilter === v }, l))),
    el("label", { class: "ad-toolbar-label muted sm" }, "Show"),
    el("select", { class: "ad-select", onchange: (e) => { S.sessions.limit = parseInt(e.target.value, 10) || 500; loadSessions(); } }, [
      [200, "Last 200"], [500, "Last 500"], [2000, "Last 2 000"], [5000, "Last 5 000"],
    ].map(([v, l]) => el("option", { value: v, selected: S.sessions.limit === v }, l))),
    focusedUser
      ? el("span", { class: "ad-pill warn", title: "Filtered to one user" }, [
          document.createTextNode(`only ${focusedUser.username} `),
          el("button", { class: "btn btn-ghost btn-sm", type: "button",
            onclick: () => { S.sessions.userFilter = null; paintSessions(); } }, "clear"),
        ])
      : null,
    el("span", { class: "ad-toolbar-sp" }),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: loadSessions }, "Refresh"),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: downloadSessions }, "Download CSV"),
  ]);
  root.append(toolbar);

  const list = el("div", { class: "ad-session-list", id: "adSessionList" }, [
    el("p", { class: "muted sm" }, "Loading…"),
  ]);
  root.append(list);

  const meta = el("p", { class: "muted xs", id: "adSessionMeta" }, "—");
  root.append(meta);

  loadSessions();
  return root;
}

async function loadSessions() {
  const host = $("adSessionList");
  if (host) host.replaceChildren(el("p", { class: "muted sm" }, "Loading…"));
  S.sessions.loading = true;
  try {
    const r = await api(`/sessions?limit=${S.sessions.limit}`);
    S.sessions.events = r.events || [];
    S.sessions.path = r.path || null;
    paintSessions();
  } catch (err) {
    if (host) host.replaceChildren(emptyState("Could not load sessions", err.message));
  } finally {
    S.sessions.loading = false;
  }
}

function paintSessions() {
  const host = $("adSessionList");
  const meta = $("adSessionMeta");
  if (!host) return;
  let list = S.sessions.events.slice();
  if (S.sessions.userFilter) list = list.filter((e) => e.userId === S.sessions.userFilter);
  if (S.sessions.eventFilter !== "all") list = list.filter((e) => e.event === S.sessions.eventFilter);
  const q = S.sessions.textFilter;
  if (q) list = list.filter((e) =>
    (e.username || "").toLowerCase().includes(q) || (e.ip || "").toLowerCase().includes(q));

  if (!list.length) {
    host.replaceChildren(emptyState("No matching events", "Try widening the filters or refreshing."));
  } else {
    host.replaceChildren(...list.map(sessionRow));
  }
  if (meta) {
    meta.textContent = `${list.length} of ${S.sessions.events.length} events` +
      (S.sessions.path ? ` · ${S.sessions.path}` : "");
  }
}

function sessionRow(e) {
  const isConnect = e.event === "connect";
  const label = isConnect ? "Connected" : "Disconnected";
  return el("div", { class: "ad-row ad-session-row" }, [
    el("div", { class: "ad-session-icon " + (isConnect ? "on" : "off"),
                title: label }, isConnect ? "▲" : "▼"),
    el("div", { class: "ad-row-meta" }, [
      el("div", { class: "ad-row-title" }, [
        document.createTextNode(e.username || "(unknown)"),
        el("span", { class: "ad-tag" }, "#" + e.userId),
        el("span", { class: "ad-tag ad-tag-" + (isConnect ? "ok" : "info") }, label),
        e.duration != null
          ? el("span", { class: "ad-tag" }, "duration " + fmtDur(e.duration))
          : null,
        e.sockets != null
          ? el("span", { class: "ad-tag" }, e.sockets + " socket" + (e.sockets === 1 ? "" : "s"))
          : null,
      ]),
      el("div", { class: "ad-row-sub muted xs" }, [
        el("span", { class: "ad-mono" }, e.ip || "—"),
        el("span", { class: "ad-sep" }, "·"),
        el("span", { title: fmtTime(e.ts) }, fmtRel(e.ts)),
      ]),
    ]),
  ]);
}

function downloadSessions() {
  const rows = [["timestamp_iso", "timestamp_unix", "event", "user_id", "username", "ip", "duration_s", "sockets"]];
  for (const e of S.sessions.events) {
    rows.push([
      new Date((e.ts || 0) * 1000).toISOString(),
      e.ts || 0, e.event || "", e.userId || 0, e.username || "", e.ip || "",
      e.duration ?? "", e.sockets ?? "",
    ]);
  }
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `localchat-sessions-${Date.now()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Channels ────────────────────────────────────────────────────────
function renderChannelsSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader(`Channels (${S.data.channels.length})`, "Public channels, private groups, and DMs."));

  const groups = { lobby: [], group_pub: [], group_priv: [], dm: [] };
  for (const c of S.data.channels) {
    if (c.kind === "lobby") groups.lobby.push(c);
    else if (c.kind === "dm") groups.dm.push(c);
    else if (c.isPrivate) groups.group_priv.push(c);
    else groups.group_pub.push(c);
  }
  const sorter = (a, b) => (a.name || a.id).localeCompare(b.name || b.id);
  for (const k of Object.keys(groups)) groups[k].sort(sorter);

  if (groups.lobby.length)      root.append(channelGroupCard("Lobby", "The public room everyone auto-joins.", groups.lobby));
  if (groups.group_pub.length)  root.append(channelGroupCard("Public groups", "Anyone can join.", groups.group_pub));
  if (groups.group_priv.length) root.append(channelGroupCard("Private groups", "Invite-only.", groups.group_priv));
  if (groups.dm.length)         root.append(channelGroupCard("Direct messages", "End-to-end encrypted. Only metadata is visible to admins.", groups.dm));
  if (!S.data.channels.length)  root.append(emptyState("No channels", "Channels appear once users create them."));

  return root;
}

function channelGroupCard(title, sub, list) {
  const card = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, [title, el("span", { class: "ad-tag" }, String(list.length))]),
      sub ? el("div", { class: "muted sm" }, sub) : null,
    ]),
    el("div", { class: "ad-channel-list" }, list.map(channelRow)),
  ]);
  return card;
}

function channelRow(c) {
  const name = c.kind === "dm"
    ? (c.dmUsers ? c.dmUsers.join(" ↔ ") : "(DM)")
    : (c.name || c.id);
  const subParts = [];
  subParts.push(`${(c.members || []).length} members`);
  subParts.push("created " + fmtRel(c.createdAt));
  const tags = [];
  if (c.kind === "lobby")   tags.push(["lobby", "info"]);
  if (c.isPrivate && c.kind === "group") tags.push(["private", "warn"]);
  if (c.kind === "dm")      tags.push(["E2EE", "ok"]);

  return el("div", { class: "ad-row ad-channel-row" }, [
    el("div", { class: "ad-channel-icon" }, c.kind === "dm" ? "↔" : (c.kind === "lobby" ? "★" : "#")),
    el("div", { class: "ad-row-meta" }, [
      el("div", { class: "ad-row-title" }, [
        document.createTextNode(name),
        ...tags.map(([t, k]) => el("span", { class: `ad-tag ad-tag-${k}` }, t)),
      ]),
      el("div", { class: "ad-row-sub muted xs" }, [
        el("span", { class: "ad-mono" }, c.id),
        el("span", { class: "ad-sep" }, "·"),
        el("span", null, subParts.join(" · ")),
      ]),
    ]),
    el("div", { class: "ad-row-actions" }, [
      c.kind === "lobby" ? null : el("button", {
        class: "btn btn-danger btn-sm", type: "button",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Delete channel?",
            body: `Delete ${name} (${c.id})?\n\nThis removes the channel and its message history for everyone. This cannot be undone.`,
            okText: "Delete", okClass: "btn-danger",
          });
          if (!ok) return;
          try {
            await api(`/channel/${encodeURIComponent(c.id)}`, { method: "DELETE" });
            toast("Channel deleted"); refreshAll();
          } catch (err) { toast("Error: " + err.message); }
        },
      }, "Delete"),
    ]),
  ]);
}

// ── Uploads ─────────────────────────────────────────────────────────
function renderUploadsSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader(`Uploads (${S.data.uploads.length})`, "Files uploaded by users."));

  const total = S.data.uploads.reduce((a, f) => a + (f.size || 0), 0);
  const cfg = S.data.settings || {};
  const cap = (cfg.maxUploadMb || 0) * 1024 * 1024;

  const summary = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Storage"),
      el("div", { class: "muted sm" }, `${S.data.uploads.length} files · ${fmtSize(total)} total · max per file ${cfg.maxUploadMb || "?"} MB`),
    ]),
  ]);
  root.append(summary);

  const toolbar = el("div", { class: "ad-toolbar" }, [
    el("input", {
      type: "search", placeholder: "Filter file name…", class: "ad-search", value: S.upload.filter,
      oninput: (e) => { S.upload.filter = e.target.value.toLowerCase(); paintUploads(); },
    }),
    el("label", { class: "ad-toolbar-label muted sm" }, "Sort"),
    el("select", {
      class: "ad-select", onchange: (e) => { S.upload.sort = e.target.value; paintUploads(); },
    }, [
      el("option", { value: "date", selected: S.upload.sort === "date" }, "Newest first"),
      el("option", { value: "size", selected: S.upload.sort === "size" }, "Largest first"),
      el("option", { value: "name", selected: S.upload.sort === "name" }, "Name (A→Z)"),
    ]),
    el("span", { class: "ad-toolbar-sp" }),
    el("button", {
      class: "btn btn-danger btn-sm", id: "adUpBulk", type: "button",
      onclick: bulkDeleteUploads,
    }, "Delete selected"),
  ]);
  root.append(toolbar);

  const grid = el("div", { class: "ad-upload-grid", id: "adUploadGrid" });
  root.append(grid);
  paintUploads(grid);
  return root;
}

function paintUploads(host) {
  host = host || $("adUploadGrid");
  if (!host) return;
  const bulkBtn = $("adUpBulk");
  let list = S.data.uploads.slice();
  const q = S.upload.filter;
  if (q) list = list.filter((f) => (f.name || "").toLowerCase().includes(q));
  switch (S.upload.sort) {
    case "size": list.sort((a, b) => (b.size || 0) - (a.size || 0)); break;
    case "name": list.sort((a, b) => (a.name || "").localeCompare(b.name || "")); break;
    default:     list.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0)); break;
  }
  if (!list.length) {
    host.replaceChildren(emptyState("No uploads", q ? "Nothing matches your filter." : "No files have been uploaded yet."));
    if (bulkBtn) bulkBtn.disabled = true;
    return;
  }
  host.replaceChildren(...list.map(uploadCard));
  if (bulkBtn) bulkBtn.disabled = !S.upload.selected.size;
}

function uploadCard(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const isImage = /^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(ext);
  const url = `/uploads/${encodeURIComponent(f.name)}`;
  const checked = S.upload.selected.has(f.name);
  return el("div", { class: "ad-up-card" + (checked ? " selected" : "") }, [
    el("label", { class: "ad-up-check", title: "Select" }, [
      el("input", {
        type: "checkbox", checked,
        onchange: (e) => {
          if (e.target.checked) S.upload.selected.add(f.name); else S.upload.selected.delete(f.name);
          paintUploads();
        },
      }),
    ]),
    el("a", { class: "ad-up-thumb", href: url, target: "_blank", rel: "noopener" },
      isImage ? [el("img", { src: url, alt: f.name, loading: "lazy" })] : [el("div", { class: "ad-up-ext" }, ext.slice(0, 4) || "file")]),
    el("div", { class: "ad-up-meta" }, [
      el("div", { class: "ad-up-name", title: f.originalName || f.name }, f.originalName || f.name),
      el("div", { class: "muted xs" }, `${fmtSize(f.size)}${f.uploadedAt ? " · " + fmtRel(f.uploadedAt) : ""}${f.uploadedByName ? " · " + f.uploadedByName : ""}`),
    ]),
    el("div", { class: "ad-up-actions" }, [
      el("button", {
        class: "btn btn-ghost btn-sm", type: "button",
        onclick: async () => {
          try { await navigator.clipboard.writeText(location.origin + url); toast("Link copied"); }
          catch { toast("Copy failed"); }
        },
      }, "Copy link"),
      el("button", {
        class: "btn btn-danger btn-sm", type: "button",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Delete file?", body: `Delete ${f.name}?\n\nThis removes the file from disk. This cannot be undone.`,
            okText: "Delete", okClass: "btn-danger",
          });
          if (!ok) return;
          try {
            await api(`/upload/${encodeURIComponent(f.name)}`, { method: "DELETE" });
            S.upload.selected.delete(f.name);
            toast("File deleted"); refreshAll();
          } catch (err) { toast("Error: " + err.message); }
        },
      }, "Delete"),
    ]),
  ]);
}

async function bulkDeleteUploads() {
  if (!S.upload.selected.size) return;
  const names = [...S.upload.selected];
  const ok = await confirmDialog({
    title: `Delete ${names.length} file${names.length > 1 ? "s" : ""}?`,
    body: names.slice(0, 8).join("\n") + (names.length > 8 ? `\n…and ${names.length - 8} more` : "") + "\n\nThis cannot be undone.",
    okText: "Delete all", okClass: "btn-danger",
  });
  if (!ok) return;
  let failed = 0;
  for (const name of names) {
    try { await api(`/upload/${encodeURIComponent(name)}`, { method: "DELETE" }); }
    catch { failed++; }
  }
  S.upload.selected.clear();
  toast(failed ? `Deleted ${names.length - failed}, ${failed} failed` : `Deleted ${names.length} files`);
  refreshAll();
}

// ── Logs ────────────────────────────────────────────────────────────
function renderLogsSection() {
  const root = el("section", { class: "ad-section ad-section-logs" });
  root.append(sectionHeader("App logs", "Tail of the server log file. Useful for spotting errors and audit events."));

  const toolbar = el("div", { class: "ad-toolbar ad-logs-toolbar" }, [
    el("input", {
      type: "search", placeholder: "Filter (text or regex)…", class: "ad-search",
      value: S.logs.filter,
      oninput: (e) => { S.logs.filter = e.target.value; paintLogs(); },
    }),
    el("label", { class: "ad-toolbar-label muted sm" }, "Level"),
    el("select", { class: "ad-select", onchange: (e) => { S.logs.level = e.target.value; paintLogs(); } }, [
      ["all", "All"], ["error", "Errors"], ["warn", "Warnings"], ["info", "Info"]
    ].map(([v, l]) => el("option", { value: v, selected: S.logs.level === v }, l))),
    el("label", { class: "ad-toolbar-label muted sm" }, "Lines"),
    el("input", {
      type: "number", min: 20, max: 5000, value: S.logs.lines, class: "ad-num",
      onchange: (e) => { S.logs.lines = clampInt(e.target.value, 20, 5000, 200); loadLogs(true); },
    }),
    el("label", { class: "ad-toggle" }, [
      el("input", { type: "checkbox", checked: S.logs.auto,
        onchange: (e) => { S.logs.auto = e.target.checked; setupLogsAuto(); } }),
      el("span", null, "Auto-refresh (5s)"),
    ]),
    el("label", { class: "ad-toggle" }, [
      el("input", { type: "checkbox", checked: S.logs.follow,
        onchange: (e) => { S.logs.follow = e.target.checked; if (S.logs.follow) scrollLogsToBottom(); } }),
      el("span", null, "Follow tail"),
    ]),
    el("span", { class: "ad-toolbar-sp" }),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => loadLogs(true) }, "Refresh"),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: downloadLogs }, "Download"),
  ]);
  root.append(toolbar);

  const view = el("div", { class: "ad-logs-view", id: "adLogsView", tabindex: "0", "aria-label": "Application log tail" });
  root.append(view);
  const meta = el("p", { class: "muted xs", id: "adLogsMeta" }, "—");
  root.append(meta);
  paintLogs(view, meta);
  return root;
}

async function loadLogs(force) {
  try {
    const r = await api(`/logs?lines=${S.logs.lines}`);
    S.data.logs = r;
    // Recompute error count and recent activity from the tail.
    parseRecent(r.lines || []);
    paintLogs();
    // Also refresh rail badge.
    if ($("navLogs")) {
      $("navLogs").textContent = S.logs.errors || "";
      $("navLogs").classList.toggle("hidden", !S.logs.errors);
    }
  } catch (err) {
    if (force) toast("Logs error: " + err.message);
  }
}

function levelOf(line) {
  const l = line.toLowerCase();
  if (l.includes(" error") || l.includes("panic")) return "error";
  if (l.includes(" warn"))  return "warn";
  return "info";
}

function paintLogs(view, meta) {
  view = view || $("adLogsView");
  meta = meta || $("adLogsMeta");
  if (!view) return;
  const all = S.data.logs?.lines || [];
  let q = S.logs.filter;
  let re = null;
  if (q) {
    try { re = new RegExp(q, "i"); } catch { /* fall back to substring */ }
  }
  const lines = all.filter((line) => {
    if (S.logs.level !== "all" && levelOf(line) !== S.logs.level) return false;
    if (!q) return true;
    return re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
  });

  // Render as DOM nodes (no innerHTML).
  view.replaceChildren(...lines.map((line) => {
    const lvl = levelOf(line);
    return el("div", { class: "ad-log-line ad-log-" + lvl }, line);
  }));

  if (meta) {
    meta.textContent = S.data.logs?.path
      ? `${lines.length} of ${all.length} lines · ${S.data.logs.path}`
      : "Log file not initialized.";
  }
  if (S.logs.follow) scrollLogsToBottom();
}

function scrollLogsToBottom() {
  const v = $("adLogsView");
  if (v) v.scrollTop = v.scrollHeight;
}

function setupLogsAuto() {
  if (S.logsTimer) { clearInterval(S.logsTimer); S.logsTimer = null; }
  if (S.logs.auto) S.logsTimer = setInterval(() => loadLogs(false), 5000);
}

function downloadLogs() {
  const blob = new Blob([(S.data.logs?.lines || []).join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `localchat-${Date.now()}.log`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseRecent(lines) {
  // Last 200 lines parsed into structured "events" for the Overview feed.
  // Format: "<iso> <event>: details…"
  S.logs.errors = 0;
  const events = [];
  for (const line of lines) {
    if (levelOf(line) === "error") S.logs.errors++;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const iso = m[1];
    const body = m[2];
    let kind = "info";
    if (/^bootstrap/.test(body))      kind = "info";
    else if (/^join/.test(body))      kind = "join";
    else if (/^leave/.test(body))     kind = "leave";
    else if (/error|panic/i.test(body)) kind = "error";
    events.push({
      kind, text: body, iso,
      rel: fmtRel(Math.floor(Date.parse(iso) / 1000)),
    });
  }
  S.recent = events.reverse();
  // If overview is currently shown, repaint its activity feed.
  if (S.route === "overview" && $("adActivity")) {
    $("adActivity").replaceChildren(...renderActivityItems());
  }
}

// ── Share ───────────────────────────────────────────────────────────
function renderShareSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader("Share & pair", "Scan from a phone or another device. Receivers must accept the self-signed certificate once."));

  const grid = el("div", { class: "ad-share-grid" });
  for (const e of S.data.share) {
    grid.append(el("div", { class: "ad-share-card" }, [
      // The QR is server-rendered SVG; safe to inline as HTML (no user input in path).
      el("div", { class: "ad-share-qr", html: e.qr || "" }),
      el("div", { class: "ad-share-meta" }, [
        el("div", { class: "ad-share-label" }, e.label),
        el("a", { class: "ad-share-url", href: e.url, target: "_blank", rel: "noopener" }, e.url),
        el("div", { class: "ad-share-actions" }, [
          el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => {
            try { await navigator.clipboard.writeText(e.url); toast("Link copied"); }
            catch { toast("Copy failed"); }
          } }, "Copy link"),
          el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => window.open(e.url, "_blank", "noopener") }, "Open"),
        ]),
      ]),
    ]));
  }
  if (!S.data.share.length) grid.append(emptyState("No reachable addresses", "The server could not detect any LAN addresses."));
  root.append(grid);
  return root;
}

// ── Broadcast ───────────────────────────────────────────────────────
function renderBroadcastSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader("Broadcast", "Send a system announcement that appears in #general for everyone."));
  const card = el("div", { class: "ad-card" }, [
    el("form", { class: "ad-broadcast-form", onsubmit: broadcast }, [
      el("label", { class: "field" }, [
        el("span", null, "Message"),
        el("textarea", { id: "bcast", rows: 3, maxlength: 500, required: true, placeholder: "e.g. Server will restart in 5 minutes for an update." }),
      ]),
      el("div", { class: "ad-form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, "Send to #general"),
      ]),
    ]),
  ]);
  root.append(card);
  return root;
}

async function broadcast(e) {
  e.preventDefault();
  const ta = $("bcast");
  const text = (ta?.value || "").trim();
  if (!text) return;
  try {
    await api("/broadcast", { method: "POST", body: JSON.stringify({ text }) });
    ta.value = "";
    toast("Announcement sent");
  } catch (err) { toast("Error: " + err.message); }
}

// ── Settings ────────────────────────────────────────────────────────
function renderSettingsSection() {
  const root = el("section", { class: "ad-section" });
  root.append(sectionHeader("Settings", "Server configuration, access control, and lifecycle."));

  const tabs = ["general", "access", "paths", "startup", "danger"];
  const labels = { general: "General", access: "Access", paths: "Paths", startup: "Startup", danger: "Danger zone" };
  const tabBar = el("div", { class: "ad-tabbar" });
  for (const t of tabs) {
    tabBar.append(el("button", {
      class: "ad-tab" + (S.settingsTab === t ? " active" : "") + (t === "danger" ? " danger" : ""),
      type: "button",
      onclick: () => { S.settingsTab = t; renderRoute(); },
    }, labels[t]));
  }
  root.append(tabBar);

  const body = el("div", { class: "ad-settings-body" });
  switch (S.settingsTab) {
    case "access":  body.append(renderSettingsAccess()); break;
    case "paths":   body.append(renderSettingsPaths()); break;
    case "startup": body.append(renderSettingsStartup()); break;
    case "danger":  body.append(renderSettingsDanger()); break;
    default:        body.append(renderSettingsGeneral()); break;
  }
  root.append(body);
  return root;
}

function renderSettingsGeneral() {
  const s = S.data.settings || {};
  const card = el("div", { class: "ad-card" }, [
    el("form", { id: "settingsForm", class: "ad-form-grid", onsubmit: saveGeneralSettings }, [
      formField("Port override (0 = auto)", el("input", { id: "s_port", type: "number", min: 0, max: 65535, value: s.port ?? 0 }),
        "Change requires restart."),
      formField("Max upload size (MB)", el("input", { id: "s_max_upload", type: "number", min: 1, max: 5000, value: s.maxUploadMb ?? 500 })),
      formField("History in RAM (per channel)", el("input", { id: "s_history", type: "number", min: 16, max: 1000, value: s.historyRam ?? 64 })),
      formField("Rotate history file at (MB)", el("input", { id: "s_rotate", type: "number", min: 1, max: 1000, value: s.rotateMb ?? 10 })),
      el("div", { class: "ad-form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, "Save"),
        el("span", { id: "settingsStatus", class: "muted sm" }),
      ]),
    ]),
  ]);
  return card;
}

async function saveGeneralSettings(e) {
  e.preventDefault();
  try {
    const body = {
      port: parseInt($("s_port").value, 10) || 0,
      maxUploadMb: clampInt($("s_max_upload").value, 1, 5000, 500),
      historyRam: clampInt($("s_history").value, 16, 1000, 64),
      rotateMb: clampInt($("s_rotate").value, 1, 1000, 10),
    };
    const r = await api("/settings", { method: "POST", body: JSON.stringify(body) });
    $("settingsStatus").textContent = r.restart_required
      ? "Saved. Restart the server to apply the port change."
      : "Saved.";
    setTimeout(() => $("settingsStatus") && ($("settingsStatus").textContent = ""), 4000);
    refreshAll();
  } catch (err) {
    $("settingsStatus").textContent = "Error: " + err.message;
  }
}

function renderSettingsAccess() {
  const s = S.data.settings || {};
  const root = el("div");

  // Host-only notice
  const noteCard = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Admin access"),
      el("div", { class: "muted sm" }, "The admin dashboard is only reachable from the host machine (loopback). Other devices on the LAN get a 404 and cannot use the /api/admin endpoints."),
    ]),
  ]);
  root.append(noteCard);

  // Banned users + IPs
  const banned = (s.bannedUsers || []).map((u) => ({ kind: "user", id: u }))
    .concat((s.bannedIps || []).map((i) => ({ kind: "ip", id: i })));
  const banCard = el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, [
        "Banned",
        el("span", { class: "ad-tag" }, String(banned.length)),
      ]),
      el("div", { class: "muted sm" }, "Users in this list cannot rejoin. IPs are blocked at connection time."),
    ]),
    banned.length
      ? el("ul", { class: "ad-ban-list" }, banned.map((b) => el("li", null, [
          el("span", { class: "ad-tag ad-tag-" + (b.kind === "ip" ? "info" : "warn") }, b.kind),
          el("span", { class: "ad-mono" }, b.id),
          el("button", {
            class: "btn btn-ghost btn-sm", type: "button", style: "margin-left:auto",
            onclick: async () => {
              if (b.kind !== "user") {
                toast("IP unban not supported in API yet — edit config.json and restart.");
                return;
              }
              try {
                await api(`/unban/${encodeURIComponent(b.id)}`, { method: "POST" });
                toast("Unbanned " + b.id); refreshAll();
              } catch (err) { toast("Error: " + err.message); }
            },
          }, "Unban"),
        ])))
      : el("div", { class: "muted sm" }, "No bans."),
  ]);
  root.append(banCard);

  return root;
}

function renderSettingsStartup() {
  const s = S.data.settings || {};
  return el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Startup"),
      el("div", { class: "muted sm" }, "Windows-only options."),
    ]),
    el("form", { class: "ad-form-grid", onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/settings", { method: "POST", body: JSON.stringify({ autostart: $("s_autostart").checked }) });
        toast("Saved"); refreshAll();
      } catch (err) { toast("Error: " + err.message); }
    } }, [
      el("label", { class: "ad-toggle" }, [
        el("input", { id: "s_autostart", type: "checkbox", checked: !!s.autostart }),
        el("span", null, "Start with Windows (current user only)"),
      ]),
      el("div", { class: "ad-form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, "Save"),
      ]),
    ]),
  ]);
}

function renderSettingsPaths() {
  const i = S.data.info || {};
  const rows = [
    { key: "data",    label: "Data folder",    desc: "App root: config, channels, message history, banned users.", path: i.data_dir },
    { key: "uploads", label: "Uploads folder", desc: "Files shared in chat (images, attachments).",                  path: i.uploads_dir },
    { key: "logs",    label: "Logs folder",    desc: "Server log files (rotated daily).",                            path: i.logs_dir },
    { key: "config",  label: "Config file",    desc: "settings.json — edited by Settings → General/Access.",         path: i.config_path },
  ];
  const open = async (key) => {
    try { await api("/open-path", { method: "POST", body: JSON.stringify({ key }) }); }
    catch (err) { toast("Open failed: " + err.message); }
  };
  return el("div", { class: "ad-card" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Server paths"),
      el("div", { class: "muted sm" }, "Click a row to open it in the host's file manager."),
    ]),
    el("div", { class: "ad-paths" }, rows.map((r) =>
      el("button", {
        class: "ad-path-row",
        type: "button",
        title: r.path || "",
        onclick: () => open(r.key),
      }, [
        el("div", { class: "ad-path-main" }, [
          el("div", { class: "ad-path-label" }, r.label),
          el("div", { class: "ad-path-desc muted xs" }, r.desc),
          el("code", { class: "ad-path-value" }, r.path || "—"),
        ]),
        el("span", { class: "ad-path-open", "aria-hidden": "true" }, "↗"),
      ])
    )),
  ]);
}

function renderSettingsDanger() {
  return el("div", { class: "ad-card ad-card-danger" }, [
    el("div", { class: "ad-card-head" }, [
      el("h3", null, "Danger zone"),
      el("div", { class: "muted sm" }, "These actions affect all users immediately."),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Restart server"),
        el("div", { class: "muted sm" }, "Active connections drop and reconnect automatically."),
      ]),
      el("button", { class: "btn btn-ghost", type: "button", onclick: restartServer }, "Restart…"),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Shut down server"),
        el("div", { class: "muted sm" }, "You'll need to start it again manually from Windows."),
      ]),
      el("button", { class: "btn btn-danger", type: "button", onclick: shutdownServer }, "Shut down…"),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Flush all users"),
        el("div", { class: "muted sm" }, "Removes every user record (live and historical) and the session audit log. Channels survive but their member lists are cleared. Active users are disconnected."),
      ]),
      el("button", { class: "btn btn-danger", type: "button",
        onclick: () => flushCategory("users", "/reset/users", "Flush all users?",
          "Deletes every user account, identity record, and session audit entry. Channels, settings, banned lists, and uploads are kept.") }, "Flush users…"),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Flush all channels"),
        el("div", { class: "muted sm" }, "Deletes every channel except the lobby, plus all messages and reactions. Users and uploads survive."),
      ]),
      el("button", { class: "btn btn-danger", type: "button",
        onclick: () => flushCategory("channels", "/reset/channels", "Flush all channels?",
          "Deletes every channel (lobby is recreated empty), all messages, and all reactions. Users, uploads, settings, and banned lists are kept.") }, "Flush channels…"),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Flush all messages"),
        el("div", { class: "muted sm" }, "Clears every channel's message history and reactions. Channels and members survive."),
      ]),
      el("button", { class: "btn btn-danger", type: "button",
        onclick: () => flushCategory("messages", "/reset/messages", "Flush all messages?",
          "Deletes every message and reaction from every channel. Channels, members, users, and uploads are kept.") }, "Flush messages…"),
    ]),
    el("div", { class: "ad-danger-row" }, [
      el("div", null, [
        el("div", { class: "ad-danger-title" }, "Factory reset (wipe all data)"),
        el("div", { class: "muted sm" }, "Master switch — does all of the above plus uploads. Server settings, banned lists, and the certificate are kept."),
      ]),
      el("button", { class: "btn btn-danger", type: "button", onclick: resetServer }, "Wipe all data…"),
    ]),
  ]);
}

// ─── Settings actions ──────────────────────────────────────────────
async function restartServer() {
  const ok = await confirmDialog({
    title: "Restart server?",
    body: "Active connections will drop and reconnect automatically.",
    okText: "Restart", okClass: "btn-primary",
  });
  if (!ok) return;
  try { await api("/restart", { method: "POST" }); } catch {}
  toast("Restart triggered. Reconnecting…");
  waitForServerBack();
}
async function shutdownServer() {
  const ok = await confirmDialog({
    title: "Shut down server?",
    body: "You'll need to start it again manually.",
    okText: "Shut down", okClass: "btn-danger",
  });
  if (!ok) return;
  try { await api("/shutdown", { method: "POST" }); } catch {}
  toast("Server shutting down.");
}

async function resetServer() {
  const ok = await confirmDialog({
    title: "Wipe ALL server data?",
    body:
      "This permanently deletes every user, channel, direct message, " +
      "reaction, uploaded file, and session record.\n\n" +
      "Server settings, banned users/IPs, the TLS certificate, and " +
      "application logs are kept.\n\n" +
      "This cannot be undone. Active users will be disconnected.",
    okText: "Continue", okClass: "btn-danger",
  });
  if (!ok) return;
  const typed = window.prompt('Type "RESET" (uppercase) to confirm.', "");
  if (typed !== "RESET") { toast("Reset cancelled."); return; }
  try {
    await api("/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET" }) });
    toast("All data wiped. Reloading…");
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    toast("Reset failed: " + err.message);
  }
}

/// Generic two-step flush for one category. Used by the per-category
/// danger-zone buttons; the master "wipe all" stays as resetServer().
async function flushCategory(kind, endpoint, title, body) {
  const ok = await confirmDialog({
    title, body: body + "\n\nThis cannot be undone.",
    okText: "Continue", okClass: "btn-danger",
  });
  if (!ok) return;
  const typed = window.prompt(`Type "RESET" (uppercase) to flush ${kind}.`, "");
  if (typed !== "RESET") { toast("Flush cancelled."); return; }
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify({ confirm: "RESET" }) });
    toast(`Flushed ${kind}. Refreshing…`);
    setTimeout(() => refreshAll(), 600);
  } catch (err) {
    toast("Flush failed: " + err.message);
  }
}
function waitForServerBack() {
  let tries = 0; const max = 30;
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

// ─── Update check ──────────────────────────────────────────────────
const REPO = "BipulRaman/LocalChat";

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
  const now = Date.now();
  if (!forceUi && now - S.update.lastChecked < 3600 * 1000) return;
  S.update.lastChecked = now;
  S.update.current = S.data.info?.version || S.update.current;

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "Accept": "application/vnd.github+json" }, cache: "no-store",
    });
    if (!r.ok) throw new Error("GitHub API " + r.status);
    const rel = await r.json();
    const tag = (rel.tag_name || "").trim();
    S.update.latest = tag;
    let url = rel.html_url || `https://github.com/${REPO}/releases/latest`;
    const asset = (rel.assets || []).find((a) => /\.(exe|msi)$/i.test(a.name));
    if (asset?.browser_download_url) url = asset.browser_download_url;
    S.update.url = url;

    const cur = S.update.current;
    const isNewer = cur && tag && compareSemver(cur, tag) < 0;
    paintUpdateBanner(isNewer, tag, url, cur);
    if (forceUi) toast(isNewer ? `Update available: ${tag}` : "You are on the latest version.");
  } catch (err) {
    if ($("adRailUpdate")) $("adRailUpdate").textContent = "update check failed";
    if (forceUi) toast("Update check failed: " + err.message);
  }
}

function paintUpdateBanner(isNewer, tag, url, cur) {
  const banner = $("adUpdateBanner");
  const railLine = $("adRailUpdate");
  S.update.isNewer = !!isNewer;
  if (railLine) {
    railLine.textContent = cur
      ? (isNewer ? `update available → ${tag}` : `v${cur} · up to date`)
      : "version unknown";
    railLine.classList.toggle("warn", !!isNewer);
    railLine.classList.toggle("clickable", !!isNewer && !!url);
    railLine.title = isNewer && url ? `Open ${url}` : "";
    railLine.onclick = (isNewer && url)
      ? () => window.open(url, "_blank", "noopener")
      : null;
  }
  if (!banner) return;
  if (!isNewer || S.update.dismissed === tag) {
    banner.classList.add("hidden");
    return;
  }
  $("adUpdTag").textContent = tag;
  $("adUpdLink").href = url;
  banner.classList.remove("hidden");
}

// ─── Helpers ────────────────────────────────────────────────────────
function sectionHeader(title, sub) {
  return el("div", { class: "ad-sec-head" }, [
    el("h2", null, title),
    sub ? el("p", { class: "muted sm" }, sub) : null,
  ]);
}
function emptyState(title, sub) {
  return el("div", { class: "ad-empty" }, [
    el("div", { class: "ad-empty-title" }, title),
    sub ? el("div", { class: "muted sm" }, sub) : null,
  ]);
}
function formField(label, input, hint) {
  return el("label", { class: "field" }, [
    el("span", null, label),
    input,
    hint ? el("span", { class: "muted xs" }, hint) : null,
  ]);
}
function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function colorForName(name) {
  const palette = ["#6366f1","#8b5cf6","#ec4899","#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6"];
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return palette[h % palette.length];
}
function iconSm(name) {
  const map = {
    folder: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v12M6 11l6-6 6 6M5 19h14"/></svg>',
    log:    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6"/></svg>',
  };
  const span = el("span", { class: "ad-rail-ico" });
  span.innerHTML = map[name] || "";
  return span;
}

// ─── Theme ──────────────────────────────────────────────────────────
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("localchat-admin-theme", next); } catch {}
  paintThemeIcon();
}
function paintThemeIcon() {
  const isDark = (document.documentElement.getAttribute("data-theme") || "light") === "dark";
  const sun  = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>`;
  const moon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>`;
  const btn = $("adThemeBtn");
  if (btn) btn.innerHTML = isDark ? sun : moon;
}

// ─── Init ───────────────────────────────────────────────────────────
function init() {
  // Strip any legacy ?token= query the tray (or an older bookmark) may
  // still pass; the server no longer cares about it.
  if (location.search) {
    history.replaceState({}, "", location.pathname + location.hash);
  }
  // Clean up any token left in localStorage from older builds.
  try { localStorage.removeItem("localchat-admin-token"); } catch {}

  // Bind topbar
  $("adRefreshBtn").addEventListener("click", refreshAll);
  $("adThemeBtn").addEventListener("click", toggleTheme);
  $("adBurger")?.addEventListener("click", () => $("adRail").classList.toggle("open"));
  $("adUpdDismiss")?.addEventListener("click", () => {
    S.update.dismissed = S.update.latest;
    $("adUpdateBanner").classList.add("hidden");
  });

  // Bind rail
  document.querySelectorAll(".ad-nav li").forEach((li) =>
    li.addEventListener("click", () => setRoute(li.dataset.route)));

  // Initial route from hash
  const hash = (location.hash || "").replace(/^#/, "");
  if (hash && sections[hash]) S.route = hash;

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "r" || e.key === "R") refreshAll();
    if (e.key === "t" || e.key === "T") toggleTheme();
    if (e.key === "g") {
      // gN = jump to nth section
      const order = ["overview","users","sessions","channels","uploads","logs","share","broadcast","settings"];
      const next = (ev) => {
        const i = parseInt(ev.key, 10);
        if (!Number.isNaN(i) && i >= 1 && i <= order.length) setRoute(order[i - 1]);
        document.removeEventListener("keydown", next);
      };
      document.addEventListener("keydown", next, { once: true });
    }
  });

  paintThemeIcon();
  refreshAll();
  S.pollTimer = setInterval(() => {
    api("/stats").then((s) => {
      S.data.stats = s;
      if (S.route === "overview") renderRoute();
      renderTopbar();
      onLiveOk();
    }).catch(onLiveDown);
  }, 5000);
}

init();

