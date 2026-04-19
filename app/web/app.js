// ═════════════════════════════════════════════════════════════════════
// LocalChat — chat client
// • Vanilla JS, no build step
// • E2EE for DMs (ECDH P-256 + AES-GCM, Web Crypto API)
// ═════════════════════════════════════════════════════════════════════

"use strict";

// ── utils ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable avatar color from a username — mirrors server's pick_color_for (FNV-1a 32, lowercased).
const _AVATAR_COLORS = ["#6366f1","#8b5cf6","#ec4899","#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6"];
function colorForName(name) {
  if (!name) return _AVATAR_COLORS[0];
  let h = 0x811c9dc5 >>> 0;
  const s = name.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return _AVATAR_COLORS[h % _AVATAR_COLORS.length];
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return e;
}
function svg(path, size = 16, strokeWidth = 2) {
  return el("svg", { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", html: `<path d="${path}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>` });
}
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function fileExt(name) {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return "file";
  return name.slice(i + 1).slice(0, 4);
}
// True for short messages composed only of emoji / whitespace.
function isJumbo(text) {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  // Remove emoji + variation selectors + ZWJ + whitespace; if nothing remains, it's pure emoji.
  // Use \p{Extended_Pictographic} where supported.
  try {
    const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]/gu, "");
    return stripped.length === 0;
  } catch {
    return false;
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

// ── E2EE (Web Crypto) ────────────────────────────────────────────────
// Model: each browser has a persistent ECDH P-256 keypair stored in
// localStorage. Public key (JWK) is sent to server in the `join` op and
// relayed to peers in the user list. For each DM:
//   sharedKey = HKDF(ECDH(mySK, peerPK))  →  AES-GCM-256 key
// Sender encrypts:  text → {iv, ct}  wire format "e2e:v1:<iv_b64>:<ct_b64>"
// Since ECDH(a,B)=ECDH(b,A), both sides derive the same key and can
// decrypt — including the sender's own message in their history.

const E2EE = {
  kp: null,         // { privateKey, publicKey, publicJwk }
  available: false, // false on insecure contexts (plain HTTP non-localhost)
  peerKeyCache: new Map(),  // userId → CryptoKey (imported peer pubkey)
  sharedCache: new Map(),   // userId → AES-GCM CryptoKey (derived)

  async init() {
    // Web Crypto requires a secure context (HTTPS or localhost). On plain
    // HTTP from a LAN IP, `crypto.subtle` is undefined → DMs will fall back
    // to plaintext relayed by the server (still LAN-only).
    if (!window.isSecureContext || !crypto.subtle) {
      console.warn("E2EE disabled: insecure context (use HTTPS or localhost for end-to-end encryption)");
      this.available = false;
      return;
    }
    this.available = true;
    const stored = localStorage.getItem("localchat-e2ee-kp");
    if (stored) {
      try {
        const { privJwk, pubJwk } = JSON.parse(stored);
        const privateKey = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
        const publicKey  = await crypto.subtle.importKey("jwk", pubJwk,  { name: "ECDH", namedCurve: "P-256" }, true,  []);
        this.kp = { privateKey, publicKey, publicJwk: pubJwk };
        return;
      } catch (e) {
        console.warn("E2EE: failed to restore keypair, generating new", e);
      }
    }
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pubJwk  = await crypto.subtle.exportKey("jwk", kp.publicKey);
    localStorage.setItem("localchat-e2ee-kp", JSON.stringify({ privJwk, pubJwk }));
    this.kp = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk: pubJwk };
  },

  myPubJwk() { return this.kp?.publicJwk || null; },
  myPubStr() { return this.kp ? JSON.stringify(this.kp.publicJwk) : ""; },

  async _derive(userId, peerPubKeyStr) {
    if (!this.available || !this.kp) return null;
    if (this.sharedCache.has(userId)) return this.sharedCache.get(userId);
    let peerJwk;
    try { peerJwk = JSON.parse(peerPubKeyStr); } catch { return null; }
    const peerKey = await crypto.subtle.importKey("jwk", peerJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const aes = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      this.kp.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.sharedCache.set(userId, aes);
    return aes;
  },

  invalidatePeer(userId) {
    this.sharedCache.delete(userId);
    this.peerKeyCache.delete(userId);
  },

  async encryptFor(peerId, peerPubStr, plaintext) {
    if (!this.available) throw new Error("E2EE unavailable in this context");
    const key = await this._derive(peerId, peerPubStr);
    if (!key) throw new Error("peer has no E2EE key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      new TextEncoder().encode(plaintext)));
    return `e2e:v1:${b64(iv)}:${b64(ct)}`;
  },

  async tryDecrypt(peerId, peerPubStr, wire) {
    if (!this.available) return null;
    if (typeof wire !== "string" || !wire.startsWith("e2e:v1:")) return null;
    const parts = wire.split(":");
    if (parts.length !== 4) return null;
    try {
      const key = await this._derive(peerId, peerPubStr);
      if (!key) return null;
      const iv = unb64(parts[2]);
      const ct = unb64(parts[3]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch (e) {
      return null;
    }
  },
};

function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── State ────────────────────────────────────────────────────────────
const S = {
  ws: null,
  me: null,                // { id, username, avatar, color, pubkey }
  users: new Map(),        // id → user
  channels: new Map(),     // id → meta
  msgs: new Map(),         // channelId → array of wire messages (raw)
  reactions: new Map(),    // channelId → Map<msgId, Map<emoji, Set<userId>>>
  readMarks: new Map(),    // channelId → Map<userId, latestReadMsgId>
  unread: new Map(),       // channelId → count
  typing: new Map(),       // channelId → Map<userId, { username, until }>
  active: "pub:general",
  hasHistory: new Set(),   // channels we've requested history for
  typingTimer: null,
  reconnectTries: 0,
  hostname: "",
  sidebarTab: "mine",
  sidebarFilter: "",
};

// ── Boot ─────────────────────────────────────────────────────────────
(async function boot() {
  try { await E2EE.init(); } catch (e) { console.warn("E2EE init failed", e); }

  // Refresh speaker/headset icon when audio devices change (plug/unplug).
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => updateSpeakerIcon().catch(() => {}));
  }

  // Track on-screen keyboard (mobile) via visualViewport so the layout
  // shrinks correctly and the emoji popover/composer stay visible.
  if (window.visualViewport) {
    const setVV = () => {
      const vv = window.visualViewport;
      document.documentElement.style.setProperty("--vv-h", `${vv.height}px`);
    };
    setVV();
    window.visualViewport.addEventListener("resize", setVV);
    window.visualViewport.addEventListener("scroll", setVV);
  }
  fetch("/api/info").then((r) => r.json()).then((info) => {
    S.hostname = info.hostname || "";
    const h = $("hostInfo"); if (h) h.textContent = `host: ${S.hostname}`;
  }).catch(() => {});

  // Auto-rejoin if we previously chose a username on this device.
  const saved = localStorage.getItem("localchat-username");
  if (saved) {
    $("username").value = saved;
    connect(saved);
  }
})();

// ── Join flow ────────────────────────────────────────────────────────
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  if (!username) return;
  localStorage.setItem("localchat-username", username);
  connect(username);
});

function connect(username) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  $("joinStatus").textContent = "Connecting…";

  ws.onopen = () => {
    ws.send(JSON.stringify({
      op: "join",
      username,
      pubkey: E2EE.myPubStr(),
    }));
  };
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus("off", "disconnected");
    if (S.me) {
      S.reconnectTries += 1;
      setStatus("warn", "reconnecting…");
      setTimeout(() => connect(S.me.username), Math.min(6000, 400 * S.reconnectTries));
    } else {
      $("joinStatus").textContent = "Connection closed. Try again.";
    }
  };
  ws.onerror = () => {
    $("joinStatus").textContent = "Cannot reach server.";
  };
}

function setStatus(kind, label) {
  const pill = $("statusPill");
  if (!pill) return;
  pill.classList.remove("ok", "warn", "off");
  if (kind) pill.classList.add(kind);
  pill.querySelector(".txt").textContent = label;
}

// ── Event dispatch ───────────────────────────────────────────────────
function handleEvent(e) {
  switch (e.ev) {
    case "welcome":      return onWelcome(e);
    case "msg":          return onWireMsg(e.m);
    case "users":        return onUsers(e.users);
    case "history":      return onHistory(e);
    case "react":        return onReact(e);
    case "ch_created":   return onChannelCreated(e.channel);
    case "ch_deleted":   return onChannelDeleted(e.channel);
    case "error":        return onError(e);
    case "pong":         return;
    default:             console.debug("[ev]", e);
  }
}

function onError(e) {
  if (!S.me) {
    // Server rejected our auto-join (e.g. banned, bad name). Drop the
    // saved name so the join screen lets the user pick a new one.
    localStorage.removeItem("localchat-username");
    $("joinStatus").textContent = e.text || "error";
    return;
  }
  toast(e.text || "Server error");
}

function onWelcome(e) {
  S.me = e.user;
  S.reconnectTries = 0;
  setStatus("ok", "online");

  S.channels.clear();
  for (const c of e.channels) S.channels.set(c.id, c);
  S.users.clear();
  for (const u of e.users) S.users.set(u.id, u);

  $("join").classList.add("hidden");
  $("app").classList.remove("hidden");
  // Show admin link only when chat is opened on the host machine itself.
  const adminLink = $("adminLink");
  if (adminLink) {
    const h = location.hostname;
    const onHost = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    adminLink.hidden = !onHost;
  }
  $("meChip").innerHTML = "";
  $("meChip").append(
    el("div", { class: "avatar xs", style: `background:${e.user.color}` }, e.user.avatar || "?"),
    el("div", { class: "me-info" }, [
      el("div", { class: "name" }, e.user.username),
      el("div", { class: "id" }, `#${e.user.id}`),
    ]),
    el("button", {
      id: "themeToggle",
      class: "icon-btn", title: "Toggle theme", "aria-label": "Toggle theme",
      onclick: toggleTheme,
    }),
    el("button", {
      class: "icon-btn", title: "Sign out", "aria-label": "Sign out",
      onclick: signOut,
      html: `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 17l5-5-5-5M20 12H9M12 19H5a2 2 0 01-2-2V7a2 2 0 012-2h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    }),
  );

  updateThemeIcon();

  renderChannels();
  renderMembers();
  switchChannel(e.lobby || "pub:general");
  S.lobby = e.lobby || "pub:general";
}

function onUsers(list) {
  // Detect pubkey changes → invalidate derived keys for that user
  for (const u of list) {
    const prev = S.users.get(u.id);
    if (prev && prev.pubkey !== u.pubkey) E2EE.invalidatePeer(u.id);
    // If a peer that previously had no key now has one, allow re-warn next time it's lost.
    if (u.pubkey && _warnedNoKey && _warnedNoKey.has(u.id)) _warnedNoKey.delete(u.id);
  }
  S.users.clear();
  for (const u of list) S.users.set(u.id, u);
  const uc = $("userCount"); if (uc) uc.textContent = "";
  renderMembers();
  renderChannels();
  // Presence change can flip ticks from sent→delivered; refresh the visible stream.
  renderStream();
}

async function onWireMsg(m) {
  // Synthetic presence + typing markers piggyback on the broadcast bus.
  if (m.username === "__presence") {
    try { onUsers(JSON.parse(m.text).users); } catch {}
    return;
  }
  if (m.username === "__typing") {
    try { onTyping(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__react") {
    try { onReact(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__read") {
    try { onRead(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__call") {
    try { onCallSignal(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__dm_deleted") {
    try {
      const id = JSON.parse(m.text).channel || m.channel;
      onChannelDeleted(id);
    } catch {}
    return;
  }
  if (m.username === "__ch_deleted") {
    try {
      const id = JSON.parse(m.text).channel || m.channel;
      onChannelDeleted(id);
    } catch {}
    return;
  }
  // Suppress noisy join/leave system messages.
  if (m.kind === "system" && /\b(joined|left) the chat\b/.test(m.text || "")) {
    return;
  }
  const arr = S.msgs.get(m.channel) || [];
  arr.push(m);
  S.msgs.set(m.channel, arr);

  if (m.channel !== S.active) {
    S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
    renderChannels();
  } else {
    // Force-scroll if the new message is from us, or if we're already near bottom.
    const isMine = S.me && (m.userId === S.me.id || m.username === S.me.username);
    if (isMine) $("messages").dataset.activeChannel = "__force";
    await renderStream();
    if (!isMine) scheduleReadReceipt();
  }
}

async function onHistory({ channel, messages, reactions }) {
  const filtered = (messages || []).filter((m) =>
    !(m.kind === "system" && /\b(joined|left) the chat\b/.test(m.text || ""))
  );
  S.msgs.set(channel, filtered);
  S.hasHistory.add(channel);
  // Hydrate reactions for this channel.
  const rmap = new Map();
  if (reactions && typeof reactions === "object") {
    for (const [msgIdStr, byEmoji] of Object.entries(reactions)) {
      const inner = new Map();
      for (const [emoji, users] of Object.entries(byEmoji || {})) {
        inner.set(emoji, new Set((users || []).map(Number)));
      }
      rmap.set(Number(msgIdStr), inner);
    }
  }
  S.reactions.set(channel, rmap);
  if (S.active === channel) await renderStream();
}

function onReact({ channel, msgId, userId, emoji, on }) {
  let perCh = S.reactions.get(channel);
  if (!perCh) { perCh = new Map(); S.reactions.set(channel, perCh); }
  let perMsg = perCh.get(msgId);
  if (!perMsg) { perMsg = new Map(); perCh.set(msgId, perMsg); }
  let users = perMsg.get(emoji);
  if (!users) { users = new Set(); perMsg.set(emoji, users); }
  if (on) users.add(userId);
  else    users.delete(userId);
  if (users.size === 0) perMsg.delete(emoji);
  if (perMsg.size === 0) perCh.delete(msgId);
  if (channel === S.active) renderStream();
}

function toggleReaction(msgId, emoji) {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.ws.send(JSON.stringify({
    op: "react",
    channel: S.active,
    msgId,
    emoji,
  }));
}

// Read receipts: S.readMarks: Map<channelId, Map<userId, msgId>>
function onRead({ channel, userId, msgId }) {
  if (!channel || msgId == null || userId == null) return;
  let perCh = S.readMarks.get(channel);
  if (!perCh) { perCh = new Map(); S.readMarks.set(channel, perCh); }
  const cur = perCh.get(userId) || 0;
  if (msgId > cur) perCh.set(userId, msgId);
  if (channel === S.active) renderStream();
}

let _readSendTimer = null;
function sendReadReceipt() {
  if (!S.ws || S.ws.readyState !== 1) return;
  if (document.hidden) return;
  const arr = S.msgs.get(S.active) || [];
  // Find latest non-system message id authored by someone else.
  let latest = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m.kind === "system") continue;
    if (m.userId === S.me?.id) continue;
    if (m.id > latest) { latest = m.id; break; }
  }
  if (latest === 0) return;
  // Suppress if we've already marked this or higher locally.
  const myReads = S.readMarks.get(S.active);
  const mine = myReads?.get(S.me?.id) || 0;
  if (latest <= mine) return;
  if (myReads) myReads.set(S.me.id, latest); else S.readMarks.set(S.active, new Map([[S.me.id, latest]]));
  S.ws.send(JSON.stringify({ op: "read", channel: S.active, msgId: latest }));
}
function scheduleReadReceipt() {
  clearTimeout(_readSendTimer);
  _readSendTimer = setTimeout(sendReadReceipt, 350);
}

function onChannelCreated(ch) {
  S.channels.set(ch.id, ch);
  renderChannels();
  switchChannel(ch.id);
}

function onChannelDeleted(id) {
  S.channels.delete(id);
  S.msgs.delete(id);
  S.unread.delete(id);
  S.typing.delete(id);
  if (S.active === id) {
    // Fall back to lobby (or first remaining channel).
    const fallback = S.lobby || [...S.channels.keys()][0];
    if (fallback) switchChannel(fallback);
    else { S.active = null; renderStream(); updateHeader(); }
  }
  renderChannels();
}

function onTyping({ channel, userId, username, typing }) {
  if (userId === S.me?.id) return;
  let m = S.typing.get(channel); if (!m) { m = new Map(); S.typing.set(channel, m); }
  if (typing) m.set(userId, { username, until: Date.now() + 4000 });
  else m.delete(userId);
  renderTyping();
}

// ── Rendering ────────────────────────────────────────────────────────

// Collapsed state for sidebar groups, persisted across reloads.
const SB_COLLAPSE_KEY = "localchat-sb-collapsed";
const _sbCollapsed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(SB_COLLAPSE_KEY) || "[]")); }
  catch { return new Set(); }
})();
function _sbToggle(key, open) {
  if (open) _sbCollapsed.delete(key); else _sbCollapsed.add(key);
  localStorage.setItem(SB_COLLAPSE_KEY, JSON.stringify([..._sbCollapsed]));
}

function _sbGroup(key, title, count, items) {
  const open = !_sbCollapsed.has(key);
  const det = el("details", { class: "sb-group", open: open ? "" : null });
  const sum = el("summary", { class: "sb-group-head" }, [
    el("span", { class: "sb-caret", html: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>` }),
    el("span", { class: "sb-group-title" }, title),
  ]);
  det.append(sum);
  if (!open) det.removeAttribute("open");
  det.addEventListener("toggle", () => _sbToggle(key, det.open));
  const ul = el("ul", { class: "chat-list" });
  for (const it of items) ul.append(it);
  det.append(ul);
  return det;
}

function _channelItem(c) {
  const active = c.id === S.active ? "active" : "";
  const unread = S.unread.get(c.id) || 0;
  const canDelete = c.kind === "group" && S.me && c.createdBy === S.me.id;
  const askDelete = canDelete ? (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Delete channel",
      body: `Delete channel #${c.name || c.id}?\n\nThis removes the channel and its history for everyone. This cannot be undone.`,
      okText: "Delete",
    }).then((ok) => { if (ok) deleteChannel(c.id); });
  } : null;
  return el("li", {
    class: "chat-item " + active,
    onclick: () => switchChannel(c.id),
    oncontextmenu: askDelete || undefined,
  }, [
    el("div", { class: "avatar", style: `background:var(--brand)` }, "#"),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, c.name || c.id),
      el("div", { class: "chat-sub muted xs" },
        c.kind === "lobby" ? "lobby \u00b7 everyone" : (c.isPrivate ? "private channel" : "channel")),
    ]),
    unread ? el("span", { class: "badge badge-unread" }, String(unread)) : null,
    canDelete ? el("button", {
      class: "chat-del",
      title: `Delete #${c.name || c.id}`,
      "aria-label": "Delete channel",
      onclick: askDelete,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>`,
    }) : null,
  ]);
}

function deleteChannel(channelId) {
  sendOp({ op: "ch_delete", channel: channelId });
}

function _dmItem(c) {
  const u = dmPeer(c);
  const active = c.id === S.active ? "active" : "";
  const unread = S.unread.get(c.id) || 0;
  const online = !!(u && !u.offline);
  const peerName = u ? u.username : "unknown";
  const askDelete = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Delete conversation",
      body: `Delete your conversation with ${peerName}?\n\nThis removes the chat for both of you, including all messages. This cannot be undone.`,
      okText: "Delete",
    }).then((ok) => { if (ok) deleteDm(c.id); });
  };
  return el("li", {
    class: "chat-item " + active,
    onclick: () => switchChannel(c.id),
    oncontextmenu: askDelete,
  }, [
    el("div", { class: `avatar ${online ? "avatar-online" : "avatar-offline"}`, style: `background:${u?.color || "var(--brand)"}` }, [
      document.createTextNode(u?.avatar || (u?.username?.[0] || "?").toUpperCase()),
      el("span", { class: "presence-dot" }),
    ]),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, peerName),
      el("div", { class: "chat-sub muted xs" }, online ? "online" : "offline"),
    ]),
    unread ? el("span", { class: "badge badge-unread" }, String(unread)) : null,
    el("button", {
      class: "chat-del",
      title: `Delete conversation with ${peerName}`,
      "aria-label": "Delete conversation",
      onclick: askDelete,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>`,
    }),
  ]);
}

function deleteDm(channelId) {
  sendOp({ op: "dm_delete", channel: channelId });
}

function _personItem(u, online) {
  return el("li", {
    class: "chat-item",
    title: online ? `Message ${u.username}` : `${u.username} (offline)`,
    onclick: () => online && u.id != null
      ? sendOp({ op: "dm_open", user: u.id })
      : toast(`${u.username} is offline`),
  }, [
    el("div", { class: `avatar ${online ? "avatar-online" : "avatar-offline"}`, style: `background:${u.color || "var(--brand)"}` }, [
      document.createTextNode(u.avatar || (u.username?.[0] || "?").toUpperCase()),
      el("span", { class: "presence-dot" }),
    ]),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, u.username),
      el("div", { class: "chat-sub muted xs" }, online ? "online" : "offline"),
    ]),
  ]);
}

function renderChannels() {
  const root = $("sbGroups");
  if (!root) return;
  root.innerHTML = "";
  const tab = S.sidebarTab || "mine";
  const q = (S.sidebarFilter || "").trim().toLowerCase();
  const matches = (s) => !q || (s || "").toLowerCase().includes(q);

  // ── Channels ─────────────────────────────────────────────
  const channels = [];
  for (const c of S.channels.values()) {
    if (c.kind === "dm") continue;
    if (!matches(c.name || c.id)) continue;
    channels.push(c);
  }
  channels.sort((a, b) => {
    if (a.kind === "lobby") return -1;
    if (b.kind === "lobby") return 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  // ── DM channels (used inside Online/Offline groups for unread + history) ──
  const dmList = [...S.channels.values()].filter((c) => c.kind === "dm");

  // ── People (online + offline) ────────────────────────────
  const me = S.me;
  const myName = (me?.username || "").toLowerCase();
  const byName = new Map();
  for (const u of S.users.values()) {
    if (!me || u.id !== me.id) byName.set((u.username || "").toLowerCase(), { user: u, online: true });
  }
  for (const c of dmList) {
    if (!c.dmUsers) continue;
    for (const n of c.dmUsers) {
      const ln = (n || "").toLowerCase();
      if (!ln || ln === myName || byName.has(ln)) continue;
      byName.set(ln, {
        user: { username: n, color: colorForName(n), avatar: n[0]?.toUpperCase() || "?", offline: true },
        online: false,
      });
    }
  }
  const onlinePeople  = [...byName.values()].filter((x) =>  x.online && matches(x.user.username)).sort((a,b)=> a.user.username.localeCompare(b.user.username));
  const offlinePeople = [...byName.values()].filter((x) => !x.online && matches(x.user.username)).sort((a,b)=> a.user.username.localeCompare(b.user.username));

  // For DM tab we want DM channels grouped by online/offline (since they're conversations)
  const dmGroupedOnline  = dmList.filter((c) => {
    const p = dmPeer(c); return !!(p && !p.offline) && matches(p?.username);
  });
  const dmGroupedOffline = dmList.filter((c) => {
    const p = dmPeer(c); return !(p && !p.offline) && matches(p?.username);
  });
  const sortDm = (a, b) => (dmPeer(a)?.username || "").localeCompare(dmPeer(b)?.username || "");
  dmGroupedOnline.sort(sortDm); dmGroupedOffline.sort(sortDm);

  // ── Render based on tab ──────────────────────────────────
  if (tab === "online") {
    // Just online people — quick way to start a chat.
    const items = onlinePeople.map((x) => {
      // If a DM already exists with this peer, render the DM row (preserves unread).
      const existing = dmGroupedOnline.find(
        (c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()
      );
      return existing ? _dmItem(existing) : _personItem(x.user, true);
    });
    root.append(_sbGroup("online", "Online", items.length, items));
  } else if (tab === "mine") {
    // My channels and personal (DM) chats I've actually opened.
    root.append(_sbGroup("ch", "Channels", channels.length, channels.map(_channelItem)));
    const personal = [...dmGroupedOnline, ...dmGroupedOffline];
    root.append(_sbGroup("personal", "Personal", personal.length, personal.map(_dmItem)));
  } else {
    // All: channels + every DM + every person.
    root.append(_sbGroup("ch", "Channels", channels.length, channels.map(_channelItem)));
    const onlinePeopleNoDm = onlinePeople.filter((x) =>
      !dmGroupedOnline.some((c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()));
    const offlinePeopleNoDm = offlinePeople.filter((x) =>
      !dmGroupedOffline.some((c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()));
    const onlineItems  = [...dmGroupedOnline.map(_dmItem),  ...onlinePeopleNoDm.map((x) => _personItem(x.user, true))];
    const offlineItems = [...dmGroupedOffline.map(_dmItem), ...offlinePeopleNoDm.map((x) => _personItem(x.user, false))];
    root.append(_sbGroup("online",  "Online",  onlineItems.length,  onlineItems));
    root.append(_sbGroup("offline", "Offline", offlineItems.length, offlineItems));
  }

  if (!root.children.length) {
    root.append(el("div", { class: "chat-empty muted xs" }, "Nothing here yet."));
  }
}

function setSidebarTab(tab) {
  S.sidebarTab = tab;
  document.querySelectorAll(".sb-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  renderChannels();
}

function setSidebarFilter(v) {
  S.sidebarFilter = v || "";
  const input = $("sbSearch");
  if (input && input.value !== S.sidebarFilter) input.value = S.sidebarFilter;
  const clear = $("sbSearchClear");
  if (clear) clear.hidden = !S.sidebarFilter;
  renderChannels();
}

function renderMembers() {
  // People are now folded into renderChannels' Online/Offline groups.
}

async function renderStream() {
  const box = $("messages");
  const force = box.dataset.activeChannel !== S.active;
  const atBottom = force ? true : isAtBottom(box);
  box.dataset.activeChannel = S.active;
  box.innerHTML = "";
  const arr = S.msgs.get(S.active) || [];
  const ch = S.channels.get(S.active);

  if (arr.length === 0) {
    box.append(renderEmptyState(ch));
    updateHeader();
    return;
  }

  // Resolve DM peer (for E2EE decryption) once per render.
  const peer = dmPeer(ch);
  let prev = null;
  let prevDay = "";

  for (const m of arr) {
    const day = fmtDay(m.ts);
    if (day !== prevDay) {
      box.append(el("div", { class: "date-divider" }, el("span", {}, day)));
      prevDay = day; prev = null;
    }

    const isSystem = m.kind === "system";
    const isFollow = !isSystem
      && prev
      && prev.userId === m.userId
      && (m.ts - prev.ts) < 300 // 5 min
      && prev.kind !== "system";

    box.append(await renderMessage(m, { follow: isFollow, peer, ch }));
    prev = m;
  }
  updateHeader();
  if (atBottom) {
    // Snap to bottom now and after layout / image loads settle.
    const snap = () => { box.scrollTop = box.scrollHeight; };
    snap();
    requestAnimationFrame(snap);
    box.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", snap, { once: true });
    });
  }
}

function renderEmptyState(ch) {
  const isDm = ch && ch.kind === "dm";
  const title = isDm ? "Start a private conversation" : "Be the first to say something";
  const sub = isDm
    ? "Messages here are end-to-end encrypted. The server admin cannot read them."
    : "Say hi or share a file. Messages stay on this local network.";
  return el("div", { class: "stream-empty" }, [
    el("div", { class: "brand-mark", html: `<svg viewBox="0 0 32 32" width="56" height="56"><defs><linearGradient id="lcEmpty" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#lcEmpty)"/><path d="M8 10a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-5l-4 3v-3h-1a3 3 0 0 1-3-3z" fill="white"/><circle cx="13" cy="13.5" r="1.3" fill="#6366f1"/><circle cx="16" cy="13.5" r="1.3" fill="#6366f1"/><circle cx="19" cy="13.5" r="1.3" fill="#6366f1"/></svg>` }),
    el("h3", {}, title),
    el("p", {}, sub),
  ]);
}

async function renderMessage(m, { follow, peer, ch }) {
  if (m.kind === "system") {
    return el("div", { class: "msg system" },
      el("div", { class: "bubble" }, el("span", { class: "text" }, m.text)),
    );
  }

  const isOwn = m.userId === S.me?.id || (S.me && m.username === S.me.username);
  const isDm  = ch && ch.kind === "dm";

  // Decrypt DM ciphertext when possible.
  let displayText = m.text || "";
  let encrypted = false;
  if (peer && displayText.startsWith("e2e:v1:")) {
    const pt = await E2EE.tryDecrypt(peer.id, peer.pubkey, displayText);
    if (pt != null) { displayText = pt; encrypted = true; }
    else displayText = "🔒 (cannot decrypt — missing key)";
  }

  // Avatar slot: only on the first incoming bubble of a group, only in non-DM.
  let avatar;
  if (isOwn || isDm || follow) {
    avatar = el("div", { class: "avatar-spacer" });
  } else {
    avatar = el("div", {
      class: "avatar",
      style: `background:${m.color || "#6366f1"}`,
      title: m.username,
    }, m.avatar || "?");
  }

  const bubble = el("div", { class: "bubble" });

  // Header row above the bubble (Teams-style):
  //  - incoming first-of-group: "Author • Time"
  //  - own first-of-group: "Time" right-aligned
  //  - DM first-of-group: "Time"
  //  - follow-up bubbles: no header
  let header = null;
  const showAuthor = !follow && !isOwn && !isDm;
  if (!follow) {
    if (showAuthor) {
      header = el("div", { class: "msg-header" }, [
        el("span", {
          class: "author",
          style: `color:${m.color || "var(--brand)"}`,
        }, m.username),
        el("span", { class: "header-time" }, fmtTime(m.ts)),
      ]);
    } else {
      header = el("div", { class: "msg-header own-header" }, [
        el("span", { class: "header-time" }, fmtTime(m.ts)),
      ]);
    }
  }

  if (m.kind === "file" && m.file) {
    const f = m.file;
    const isImg = (f.mimeType || "").startsWith("image/");
    const dlUrl   = `/api/download/${encodeURIComponent(f.filename)}?name=${encodeURIComponent(f.originalName)}`;
    const viewUrl = `/uploads/${encodeURIComponent(f.filename)}`;
    const att = el("div", { class: "attachment" });

    if (isImg) {
      const img = el("img", { src: viewUrl, alt: f.originalName, loading: "lazy" });
      const wrap = el("div", { class: "image-att", title: "Click to expand" }, [
        img,
        el("div", { class: "img-meta" }, [
          el("span", {}, f.originalName),
          el("a", { href: dlUrl, onclick: (e) => e.stopPropagation() }, "Download"),
        ]),
      ]);
      wrap.addEventListener("click", () => openLightbox(viewUrl, f.originalName, dlUrl));
      att.append(wrap);
    } else {
      att.append(el("a", {
        class: "file", href: dlUrl, target: "_blank", rel: "noopener",
      }, [
        el("div", { class: "file-icon" }, fileExt(f.originalName)),
        el("div", { class: "file-meta" }, [
          el("div", { class: "file-name" }, f.originalName),
          el("div", { class: "file-sub" }, fmtSize(f.size)),
        ]),
        el("div", { class: "file-dl", html: `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` }),
      ]));
    }
    bubble.append(att);
    if (displayText) {
      bubble.append(el("div", { class: "text" }, displayText));
    }
  } else if (displayText) {
    const cls = isJumbo(displayText) ? "text jumbo" : "text";
    bubble.append(el("div", { class: cls }, displayText));
  }

  // Inline meta inside bubble: only ticks (own) + lock (E2EE). Time is in the header above.
  const metaChildren = [];
  if (encrypted) {
    metaChildren.push(el("span", { class: "enc-tag", title: "End-to-end encrypted" },
      svg("M6 10V7a6 6 0 0112 0v3M5 10h14v10H5z", 10, 2)));
  }
  if (isOwn) metaChildren.push(renderTicks(computeTickState(m, ch)));
  if (metaChildren.length) bubble.append(el("div", { class: "meta" }, metaChildren));

  // Reaction bar (rendered below the text inside bubble) + hover quick-add.
  const perCh = S.reactions.get(m.channel);
  const perMsg = perCh && perCh.get(m.id);
  if (perMsg && perMsg.size) {
    const bar = el("div", { class: "reactions" });
    for (const [emoji, users] of perMsg.entries()) {
      const mine = S.me && users.has(S.me.id);
      const names = [...users].map((id) => S.users.get(id)?.username || `#${id}`).join(", ");
      bar.append(el("button", {
        class: "reaction" + (mine ? " mine" : ""),
        title: `${names} reacted with ${emoji}`,
        onclick: (ev) => { ev.stopPropagation(); toggleReaction(m.id, emoji); },
      }, [
        el("span", { class: "r-emoji" }, emoji),
        el("span", { class: "r-count" }, String(users.size)),
      ]));
    }
    bubble.append(bar);
  }

  // Hover action group (skips system messages because they returned early).
  const actions = el("div", { class: "msg-actions" }, [
    el("button", {
      class: "ma-btn",
      title: "Add reaction",
      onclick: (ev) => { ev.stopPropagation(); openReactionPicker(ev.currentTarget, m.id); },
      html: `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10.5" r="1.1" fill="currentColor"/><circle cx="15" cy="10.5" r="1.1" fill="currentColor"/><path d="M8.5 14.2c.8 1.3 2.1 2.1 3.5 2.1s2.7-.8 3.5-2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    }),
    el("button", {
      class: "ma-btn",
      title: "Reply",
      onclick: (ev) => { ev.stopPropagation(); /* TODO: reply-to */ },
      html: `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M10 9V5l-7 7 7 7v-4c5 0 8 1.5 10 5-1-7-5-11-10-11z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    }),
  ]);
  bubble.append(actions);

  // Tail only on the first bubble of a group.
  const classes = ["msg"];
  if (isOwn) classes.push("own");
  if (isDm)  classes.push("dm");
  if (follow) classes.push("follow");
  else        classes.push("has-tail");

  const stack = el("div", { class: "msg-stack" });
  if (header) stack.append(header);
  stack.append(bubble);

  return el("div", { class: classes.join(" ") }, [avatar, stack]);
}

// Compute tick state for an own message:
//   "sent"      → message is in the room, no other connected peer.
//   "delivered" → at least one other channel member is currently online.
//   "read"      → at least one other channel member has read up to this msg.
function computeTickState(m, ch) {
  if (!ch || !m || !S.me) return "sent";
  // Read?
  const reads = S.readMarks.get(m.channel);
  if (reads) {
    for (const [uid, lastId] of reads.entries()) {
      if (uid === S.me.id) continue;
      if (lastId >= m.id) return "read";
    }
  }
  // Delivered? Any other online user who can see this channel.
  const memberSet = ch.members && ch.members.length
    ? new Set(ch.members)
    : null; // lobby/general → everyone counts
  for (const uid of S.users.keys()) {
    if (uid === S.me.id) continue;
    if (!memberSet || memberSet.has(uid)) return "delivered";
  }
  return "sent";
}

// WhatsApp-style ticks. Single grey = sent; double grey = delivered; double blue = read.
function renderTicks(state) {
  const cls = "ticks " + state;
  if (state === "sent") {
    return el("span", {
      class: cls,
      html: `<svg viewBox="0 0 16 12" width="15" height="12"><path d="M1 6.5l4 4L13 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    });
  }
  // Double tick: two checkmarks with the second overlapping slightly to the right (WhatsApp style).
  return el("span", {
    class: cls,
    html: `<svg viewBox="0 0 22 12" width="20" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5l4 4L13 1.5"/><path d="M9 10.5l4-4M13 6.5L21 1.5"/></svg>`,
  });
}

// Quick-reaction popover (small, fixed set)
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
function openReactionPicker(anchor, msgId) {
  closeReactionPicker();
  const pop = el("div", { class: "reaction-pop" });
  for (const e of QUICK_REACTIONS) {
    pop.append(el("button", {
      class: "rp-btn",
      onclick: (ev) => {
        ev.stopPropagation();
        toggleReaction(msgId, e);
        closeReactionPicker();
      },
    }, e));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  // Position above the button, clamped to viewport.
  const popW = 280;
  let left = Math.min(window.innerWidth - popW - 8, Math.max(8, r.left + r.width / 2 - popW / 2));
  let top  = r.top - 48;
  if (top < 8) top = r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;
  // Dismiss on outside click / escape.
  setTimeout(() => {
    document.addEventListener("click", _rpDismiss, { once: true, capture: true });
    document.addEventListener("keydown", _rpKey);
  }, 0);
}
function closeReactionPicker() {
  document.querySelectorAll(".reaction-pop").forEach((n) => n.remove());
  document.removeEventListener("keydown", _rpKey);
}
function _rpDismiss() { closeReactionPicker(); }
function _rpKey(e) { if (e.key === "Escape") closeReactionPicker(); }

function updateHeader() {
  const ch = S.channels.get(S.active);
  const title = $("chTitle"), sub = $("chSub"), badge = $("e2eeBadge"), composer = $("msgInput");
  const avSlot = $("chAvatar");
  const callBtn = $("callBtn");
  const videoCallBtn = $("videoCallBtn");
  if (!ch) return;

  if (ch.kind === "dm") {
    const p = dmPeer(ch);
    title.textContent = p ? p.username : "unknown";
    sub.textContent = p ? (p.offline ? "offline" : "online") : "";
    badge.classList.remove("hidden");
    composer.placeholder = "Type a message";
    if (avSlot) {
      avSlot.style.background = p?.color || "var(--brand)";
      avSlot.textContent = p?.avatar || (p?.username?.[0] || "?").toUpperCase();
      avSlot.classList.remove("hidden");
    }
    if (callBtn) callBtn.classList.toggle("hidden", !p);
    if (videoCallBtn) videoCallBtn.classList.toggle("hidden", !p);
  } else {
    title.textContent = "#" + (ch.name || ch.id);
    sub.textContent = ch.kind === "lobby" ? "lobby \u00b7 everyone" : (ch.isPrivate ? "private channel" : "channel");
    badge.classList.add("hidden");
    composer.placeholder = "Type a message";
    if (avSlot) {
      avSlot.style.background = "var(--brand)";
      avSlot.textContent = "#";
      avSlot.classList.remove("hidden");
    }
    if (callBtn) callBtn.classList.add("hidden");
    if (videoCallBtn) videoCallBtn.classList.add("hidden");
  }
}

function renderTyping() {
  const m = S.typing.get(S.active);
  const now = Date.now();
  const names = [];
  if (m) for (const [uid, v] of [...m.entries()]) {
    if (v.until < now) m.delete(uid); else names.push(v.username);
  }
  const row = $("typing");
  row.innerHTML = "";
  if (names.length === 0) return;
  row.append(
    el("span", { class: "dots" }, [el("span"), el("span"), el("span")]),
    document.createTextNode(` ${names.slice(0, 3).join(", ")} ${names.length === 1 ? "is" : "are"} typing…`),
  );
}
setInterval(renderTyping, 1500);

function isAtBottom(box) {
  return box.scrollTop + box.clientHeight > box.scrollHeight - 160;
}

// ── Channel switching ────────────────────────────────────────────────
function switchChannel(id) {
  S.active = id;
  S.unread.set(id, 0);
  renderChannels();
  renderMembers();
  renderTyping();
  if (!S.hasHistory.has(id)) sendOp({ op: "history", channel: id, limit: 50 });
  renderStream();
  scheduleReadReceipt();
  $("msgInput").focus();
  if (window.matchMedia("(max-width: 780px)").matches) $("sidebar").classList.remove("open");
}

function dmPeer(ch) {
  if (!ch || ch.kind !== "dm") return null;
  // First try by member UserId (works while peer is online with current id).
  const otherId = (ch.members || []).find((m) => m !== S.me?.id);
  const byId = otherId != null ? S.users.get(otherId) : null;
  if (byId) return byId;
  // Fall back to username from the channel's dmUsers (stable across reconnects).
  if (ch.dmUsers && S.me) {
    const myName = (S.me.username || "").toLowerCase();
    const peerName = ch.dmUsers.find((n) => n && n.toLowerCase() !== myName);
    if (peerName) {
      // Try to find the live user record by username.
      for (const u of S.users.values()) {
        if (u.username && u.username.toLowerCase() === peerName.toLowerCase()) return u;
      }
      // Peer is offline — return a synthetic record so UI shows the name.
      return {
        id: otherId ?? -1,
        username: peerName,                    // original casing
        color: colorForName(peerName),         // stable color matching server
        avatar: peerName[0]?.toUpperCase() || "?",
        pubkey: null,
        offline: true,
      };
    }
  }
  return null;
}

// ── Sending ──────────────────────────────────────────────────────────
function sendOp(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text) return;
  const ch = S.channels.get(S.active);
  if (!ch) return;

  let payload = text;
  if (ch.kind === "dm") {
    const peer = dmPeer(ch); // may be null if peer is offline
    const peerId = peer?.id ?? (ch.members || []).find((m) => m !== S.me?.id);
    if (peer && peer.pubkey && E2EE.available) {
      try {
        payload = await E2EE.encryptFor(peer.id, peer.pubkey, text);
      } catch (e) {
        toast("Encryption failed: " + e.message);
        return;
      }
    } else {
      // Peer is offline, has no key, or our browser can't do Web Crypto.
      // Send plaintext (server still relays + persists). Warn once per peer.
      const key = peerId ?? "_unknown";
      if (!_warnedNoKey.has(key)) {
        _warnedNoKey.add(key);
        const why = !peer
          ? "Recipient is offline — sending unencrypted"
          : (!E2EE.available
            ? "Encryption unavailable here (use HTTPS or localhost) — sending unencrypted"
            : `${peer.username} has no encryption key — sending unencrypted`);
        toast(why);
      }
    }
  }

  sendOp({ op: "send", channel: S.active, text: payload });
  sendOp({ op: "typing", channel: S.active, typing: false });
}
const _warnedNoKey = new Set();

// Composer
const msgInput = $("msgInput");
msgInput.addEventListener("input", () => {
  autoGrow(msgInput);
  if (S.typingTimer) clearTimeout(S.typingTimer);
  sendOp({ op: "typing", channel: S.active, typing: true });
  S.typingTimer = setTimeout(() => sendOp({ op: "typing", channel: S.active, typing: false }), 2500);
});
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const v = msgInput.value;
    msgInput.value = "";
    autoGrow(msgInput);
    sendMessage(v);
  }
});
$("sendForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = msgInput.value;
  msgInput.value = "";
  autoGrow(msgInput);
  sendMessage(v);
});
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(200, ta.scrollHeight) + "px";
}

// File uploads — note: file content itself travels over HTTP (not WS).
// For group/lobby channels the file lives in /uploads/ and admin CAN see
// it. We do NOT encrypt file bodies for DMs in v1 — that would require a
// much heavier scheme. A non-encrypted file in a DM is flagged in the UI.
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const ch = S.channels.get(S.active);
  if (ch?.kind === "dm") {
    if (!confirm(
      "Files in direct messages are not end-to-end encrypted in this version.\n" +
      "The server (and admin) can see the file contents.\n\nContinue?")) {
      e.target.value = ""; return;
    }
  }
  const form = new FormData(); form.append("file", f);
  try {
    toast(`Uploading ${f.name}…`, 10000);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const info = await res.json();
    sendOp({ op: "file", channel: S.active, file: info });
    toast(`Uploaded ${f.name}`);
  } catch (err) {
    toast("Upload failed: " + err.message, 4000);
  } finally {
    e.target.value = "";
  }
});

// ── Modals ───────────────────────────────────────────────────────────
function openCreateChannel() {
  $("createModal").classList.remove("hidden");
  $("newChName").focus();
}
function closeModal(id) { $(id).classList.add("hidden"); }

// ── Confirm dialog (returns Promise<boolean>) ────────────────────────
let _cfResolve = null;
function confirmDialog({ title = "Confirm", body = "", okText = "Delete", okClass = "btn-danger", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    _cfResolve = resolve;
    $("cfTitle").textContent = title;
    $("cfBody").textContent = body;
    const ok = $("cfOk");
    ok.textContent = okText;
    ok.className = "btn " + okClass;
    $("cfCancel").textContent = cancelText;
    $("confirmModal").classList.remove("hidden");
    setTimeout(() => ok.focus(), 0);
  });
}
function closeConfirm(result) {
  $("confirmModal").classList.add("hidden");
  const r = _cfResolve; _cfResolve = null;
  if (r) r(!!result);
}
Object.assign(window, { closeConfirm });

// ─── Share / pair modal ───────────────────────────────────────────────
async function openShareModal() {
  const m = $("shareModal");
  const host = $("shareGridUser");
  if (!m || !host) return;
  host.innerHTML = `<p class="muted sm">Loading…</p>`;
  m.classList.remove("hidden");
  try {
    const r = await fetch("/api/share").then((r) => r.json());
    const entries = r.entries || [];
    if (!entries.length) { host.innerHTML = `<p class="muted">No reachable addresses detected.</p>`; return; }
    host.innerHTML = entries.map((e) => `
      <div class="share-card">
        <div class="share-qr">${e.qr}</div>
        <div class="share-meta">
          <div class="share-label">${escapeHtml(e.label)}</div>
          <a class="share-url" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.url)}</a>
          <div class="share-actions">
            <button type="button" class="btn btn-ghost" data-act="copy" data-url="${escapeHtml(e.url)}">Copy link</button>
            <button type="button" class="btn btn-ghost" data-act="open" data-url="${escapeHtml(e.url)}">Open</button>
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
  } catch (err) {
    host.innerHTML = `<p class="muted">Failed to load: ${escapeHtml(String(err && err.message || err))}</p>`;
  }
}
function closeShareModal() { $("shareModal").classList.add("hidden"); }
Object.assign(window, { openShareModal, closeShareModal });

function createChannel(e) {
  e.preventDefault();
  const name = $("newChName").value.trim();
  const isPrivate = $("newChPrivate").checked;
  if (!name) return;
  sendOp({ op: "ch_create", name, private: isPrivate });
  closeModal("createModal");
  $("newChName").value = ""; $("newChPrivate").checked = false;
}

function openDmPicker() {
  const list = $("dmPickList"); list.innerHTML = "";
  const users = [...S.users.values()].filter((u) => u.id !== S.me?.id);
  users.sort((a, b) => a.username.localeCompare(b.username));
  if (users.length === 0) {
    list.append(el("li", { class: "muted sm" }, "No one else is online right now."));
  }
  for (const u of users) {
    const canE2ee = !!u.pubkey;
    list.append(el("li", {
      onclick: () => { sendOp({ op: "dm_open", user: u.id }); closeModal("dmModal"); },
    }, [
      el("div", { class: "avatar xs", style: `background:${u.color}` }, u.avatar || "?"),
      el("span", {}, u.username),
      el("span", { class: "e2ee" + (canE2ee ? " ok" : "") }, [
        svg("M6 10V7a6 6 0 0112 0v3M5 10h14v10H5z", 12, 2),
        canE2ee ? "encrypted" : "no key",
      ]),
    ]));
  }
  $("dmModal").classList.remove("hidden");
}

function toggleSidebar() { $("sidebar").classList.toggle("open"); }
// Auto-close mobile sidebar on outside tap / Escape.
document.addEventListener("click", (e) => {
  const sb = $("sidebar");
  if (!sb || !sb.classList.contains("open")) return;
  if (!window.matchMedia("(max-width: 780px)").matches) return;
  if (e.target.closest("#sidebar")) return;
  if (e.target.closest('[onclick*="toggleSidebar"]')) return;
  sb.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("sidebar")?.classList.remove("open");
});
// Re-confirm read state when the tab becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleReadReceipt();
});
window.addEventListener("focus", scheduleReadReceipt);

function signOut() {
  localStorage.removeItem("localchat-username");
  // Close socket cleanly so we don't auto-reconnect.
  if (S.ws) {
    try { S.ws.onclose = null; S.ws.close(); } catch {}
  }
  S.me = null;
  S.ws = null;
  location.reload();
}

// ── Lightbox ─────────────────────────────────────────────────────────
function openLightbox(src, name, downloadUrl) {
  closeLightbox();
  const lb = el("div", { class: "lightbox", id: "lightbox" }, [
    el("button", {
      class: "lb-close", "aria-label": "Close",
      onclick: (e) => { e.stopPropagation(); closeLightbox(); },
      html: `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    }),
    el("img", { src, alt: name, onclick: (e) => e.stopPropagation() }),
    el("div", { class: "lb-bar", onclick: (e) => e.stopPropagation() }, [
      el("span", {}, name),
      el("span", { style: "opacity:.5" }, "·"),
      el("a", { href: downloadUrl, download: name }, "Download"),
    ]),
  ]);
  lb.addEventListener("click", closeLightbox);
  document.body.append(lb);
}
function closeLightbox() {
  document.getElementById("lightbox")?.remove();
}

// ── Emoji picker ─────────────────────────────────────────────────────
const EMOJI = {
  "Smileys": "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖".split(" "),
  "Gestures": "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 🦻 👃 🧠 🦷 🦴 👀 👁️ 👅 👄 💋 🩸".split(" "),
  "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌 💯 💢 💥 💫 💦 💨 🕳️ 💣 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤".split(" "),
  "Animals": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦐 🦀 🐠 🐟 🐬 🐳 🐋 🦈".split(" "),
  "Food": "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍙 🍚 🍘 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🧂 🍩 🍪 ☕ 🫖 🍵 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾".split(" "),
  "Activity": "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩".split(" "),
  "Travel": "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🛕 🕍 ⛩️".split(" "),
  "Objects": "⌚ 📱 📲 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 🗜️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪒 🧽 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🧸 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓".split(" "),
  "Symbols": "❤️ 💔 ✨ 🔥 💯 ✅ ❌ ❓ ❗ ⚠️ 🚫 ✔️ ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 🆗 🆒 🆕 🆙 🆓 🆖 🆘 🆚 🅰️ 🅱️ 🆎 🅾️ 🆔 ⚛️ 🕉️ ✡️ ☸️ ☯️ ✝️ ☦️ ☪️ ☮️ 🕎 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⛎ 🔀 🔁 🔂 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔼 🔽 ⏫ ⏬ ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↩️ ↪️ ⤴️ ⤵️ 🔃 🔄 🔅 🔆 📶 📳 📴 ♀️ ♂️ ⚧️ ⚕️ ♻️ ⚜️ 🔱 📛 🔰 ⭕ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 ◼️ ◻️ ◾ ◽ ▪️ ▫️ 🔶 🔷 🔸 🔹 🔺 🔻 💠 🔘 🔳 🔲".split(" "),
};

let _emojiOpen = false;
let _emojiTab = "Smileys";
let _emojiQuery = "";

function toggleEmoji() {
  _emojiOpen ? closeEmoji() : openEmoji();
}
function openEmoji() {
  closeEmoji();
  _emojiOpen = true;
  // On touch / small screens, dismiss the on-screen keyboard so the
  // popover isn't hidden behind it.
  if (window.matchMedia("(max-width: 780px)").matches) {
    try { document.activeElement?.blur?.(); } catch {}
  }
  const pop = el("div", { class: "emoji-pop", id: "emojiPop" });
  pop.addEventListener("click", (e) => e.stopPropagation());

  // Search
  const search = el("input", {
    type: "text", placeholder: "Search emoji…", autocomplete: "off", spellcheck: "false",
  });
  search.addEventListener("input", () => { _emojiQuery = search.value.trim().toLowerCase(); renderEmojiGrid(); });
  pop.append(el("div", { class: "ep-search" }, search));

  // Tabs
  const tabs = el("div", { class: "ep-tabs" });
  for (const cat of Object.keys(EMOJI)) {
    const b = el("button", {
      type: "button",
      class: cat === _emojiTab ? "active" : "",
      onclick: () => { _emojiTab = cat; renderEmojiGrid(); refreshTabs(); },
    }, cat);
    tabs.append(b);
  }
  pop.append(tabs);

  const grid = el("div", { class: "ep-grid", id: "epGrid" });
  pop.append(grid);

  $("sendForm").append(pop);
  setTimeout(() => search.focus(), 30);
  renderEmojiGrid();
}
function refreshTabs() {
  const tabs = document.querySelectorAll("#emojiPop .ep-tabs button");
  tabs.forEach((b) => b.classList.toggle("active", b.textContent === _emojiTab));
}
function renderEmojiGrid() {
  const grid = $("epGrid"); if (!grid) return;
  grid.innerHTML = "";
  let pool;
  if (_emojiQuery) {
    pool = Object.values(EMOJI).flat();
  } else {
    pool = EMOJI[_emojiTab] || [];
  }
  // De-dup + filter empties
  pool = [...new Set(pool.filter(Boolean))];
  if (pool.length === 0) {
    grid.append(el("div", { class: "ep-empty" }, "No emoji"));
    return;
  }
  for (const e of pool) {
    grid.append(el("button", {
      type: "button", title: e,
      onclick: () => insertEmoji(e),
    }, e));
  }
}
function insertEmoji(e) {
  const ta = $("msgInput");
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + e + ta.value.slice(end);
  ta.focus();
  const pos = start + e.length;
  ta.setSelectionRange(pos, pos);
  autoGrow(ta);
}
function closeEmoji() {
  _emojiOpen = false;
  document.getElementById("emojiPop")?.remove();
}
$("emojiBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleEmoji(); });
document.addEventListener("click", (e) => {
  if (_emojiOpen && !e.target.closest("#emojiPop") && e.target.id !== "emojiBtn") closeEmoji();
});
// Close emoji panel when the user refocuses the textarea (e.g. taps to type again).
$("msgInput").addEventListener("focus", () => { if (_emojiOpen) closeEmoji(); });
// Also close on Escape and when window loses focus (mobile keyboard switching).
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _emojiOpen) closeEmoji(); });
window.addEventListener("blur", () => { if (_emojiOpen) closeEmoji(); });

// ── Paste image / drag-drop ──────────────────────────────────────────
async function uploadFile(f) {
  const ch = S.channels.get(S.active);
  if (ch?.kind === "dm") {
    if (!confirm(
      "Files in direct messages are not end-to-end encrypted in this version.\n" +
      "The server (and admin) can see the file contents.\n\nContinue?")) return;
  }
  const form = new FormData(); form.append("file", f);
  try {
    toast(`Uploading ${f.name}…`, 10000);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const info = await res.json();
    sendOp({ op: "file", channel: S.active, file: info });
    toast(`Uploaded ${f.name}`);
  } catch (err) {
    toast("Upload failed: " + err.message, 4000);
  }
}
$("msgInput").addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();
        // Give pasted screenshots a friendly name.
        const ext = (f.type.split("/")[1] || "png").split(";")[0];
        const named = new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.${ext}`, { type: f.type });
        await uploadFile(named);
        return;
      }
    }
  }
});
const dropTarget = $("messages");
["dragover", "dragenter"].forEach((ev) => dropTarget.addEventListener(ev, (e) => { e.preventDefault(); }));
dropTarget.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files || [];
  for (const f of files) await uploadFile(f);
});

// Keyboard: Esc closes lightbox/emoji/modals.
document.addEventListener("click", (e) => {
  if (e.target.classList?.contains("modal")) e.target.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeLightbox();
    closeEmoji();
    if (_cfResolve) closeConfirm(false);
    for (const m of document.querySelectorAll(".modal:not(.hidden)")) m.classList.add("hidden");
  }
});

// expose for inline onclick handlers
Object.assign(window, { openCreateChannel, openDmPicker, closeModal, createChannel, toggleSidebar, toggleTheme, startCall, acceptCall, declineCall, endCall, toggleMute, toggleSpeaker, toggleCamera });

// ── Theme ────────────────────────────────────────────────────────────
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("localchat-theme", next);
  updateThemeIcon();
}
function updateThemeIcon() {
  const isDark = (document.documentElement.getAttribute("data-theme") || "dark") === "dark";
  const sun  = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const moon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const html = isDark ? sun : moon;
  for (const id of ["themeToggle", "themeToggleJoin"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}
updateThemeIcon();

// ═══════════════════════════════════════════════════════════════════
// Audio call (WebRTC, 1:1 over a DM channel)
// ───────────────────────────────────────────────────────────────────
// Signaling piggybacks on the existing WS DM broadcast bus via the
// `call_signal` op. The server tags relayed frames with
// `username == "__call"` so onWireMsg routes them here.
// ═══════════════════════════════════════════════════════════════════
const Call = {
  pc: null,           // RTCPeerConnection
  localStream: null,  // MediaStream from getUserMedia
  channelId: null,    // DM channel hosting this call
  peerId: null,       // remote user id
  peerName: "",
  state: "idle",      // idle | calling | ringing | active
  muted: false,
  isVideo: false,     // true if this call has video
  camOn: false,       // local video track currently sending
  pendingIce: [],     // ICE arrived before remoteDescription was set
};

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function callSend(kind, payload) {
  if (!Call.channelId) return;
  sendOp({ op: "call_signal", channel: Call.channelId, kind, payload: payload ?? null });
}

async function startCall(video) {
  if (Call.state !== "idle") return;
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "dm") return;
  const peer = dmPeer(ch);
  if (!peer) return;
  const wantVideo = !!video;
  try {
    Call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
  } catch (e) {
    toast((wantVideo ? "Camera/mic" : "Mic") + " permission denied: " + e.message);
    return;
  }
  Call.channelId = ch.id;
  Call.peerId = peer.id;
  Call.peerName = peer.username;
  Call.state = "calling";
  Call.isVideo = wantVideo;
  Call.camOn = wantVideo;
  showCallBar(wantVideo ? "Video calling…" : "Calling…");
  await createPC();
  for (const t of Call.localStream.getTracks()) Call.pc.addTrack(t, Call.localStream);
  if (wantVideo) attachLocalVideo();
  const offer = await Call.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: wantVideo });
  await Call.pc.setLocalDescription(offer);
  callSend("offer", { sdp: Call.pc.localDescription, video: wantVideo });
}

async function createPC() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  Call.pc = pc;
  pc.onicecandidate = (ev) => {
    if (ev.candidate) callSend("ice", { candidate: ev.candidate });
  };
  pc.ontrack = (ev) => {
    const stream = ev.streams && ev.streams[0];
    if (!stream) return;
    const audio = $("remoteAudio");
    if (audio) audio.srcObject = stream;
    if (ev.track.kind === "video") {
      const v = $("remoteVideo");
      if (v) v.srcObject = stream;
      // Only reveal the video stage once the call is actually active
      // (not during the ringing phase — the incoming-call modal owns the UI then).
      if (Call.state === "active") showVideoStage(true);
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      Call.state = "active";
      setCallStatus(Call.isVideo ? "Connected (video)" : "Connected");
      if (Call.isVideo) {
        const rv = $("remoteVideo");
        // Re-attach in case the remote stream was set before "active".
        const audio = $("remoteAudio");
        if (rv && audio && audio.srcObject) rv.srcObject = audio.srcObject;
        showVideoStage(true);
      }
    } else if (s === "failed" || s === "disconnected" || s === "closed") {
      if (Call.state !== "idle") teardownCall(false);
    }
  };
}

async function acceptCall() {
  if (Call.state !== "ringing") return;
  stopRingtone();
  $("incomingCall").classList.add("hidden");
  const wantVideo = !!Call.isVideo;
  try {
    Call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
  } catch (e) {
    toast((wantVideo ? "Camera/mic" : "Mic") + " permission denied: " + e.message);
    callSend("decline", null);
    resetCallState();
    return;
  }
  Call.camOn = wantVideo;
  for (const t of Call.localStream.getTracks()) Call.pc.addTrack(t, Call.localStream);
  if (wantVideo) attachLocalVideo();
  const answer = await Call.pc.createAnswer();
  await Call.pc.setLocalDescription(answer);
  callSend("answer", { sdp: Call.pc.localDescription });
  showCallBar("Connecting…");
  Call.state = "active";
}

function declineCall() {
  if (Call.state !== "ringing") return;
  stopRingtone();
  callSend("decline", null);
  $("incomingCall").classList.add("hidden");
  resetCallState();
}

function endCall() {
  if (Call.state === "idle") return;
  callSend("end", null);
  teardownCall(true);
}

function toggleMute() {
  if (!Call.localStream) return;
  Call.muted = !Call.muted;
  for (const t of Call.localStream.getAudioTracks()) t.enabled = !Call.muted;
  const btn = $("muteBtn");
  if (btn) btn.classList.toggle("active", Call.muted);
  setCallStatus(Call.muted ? "Muted" : (Call.state === "active" ? "Connected" : "Connecting…"));
}

async function toggleSpeaker() {
  const audio = $("remoteAudio");
  if (!audio) return;
  Call._speakerState = !(Call._speakerState ?? false);
  const speakerOn = Call._speakerState;
  // Best-effort: pick a different audio output device when available.
  try {
    if (typeof audio.setSinkId === "function" && navigator.mediaDevices?.enumerateDevices) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs.filter((d) => d.kind === "audiooutput");
      if (outs.length > 1) {
        const target = speakerOn
          ? (outs.find((d) => d.deviceId === "default") || outs[0])
          : (outs.find((d) => d.deviceId !== "default") || outs[outs.length - 1]);
        await audio.setSinkId(target.deviceId);
      }
    }
  } catch {}
  audio.volume = speakerOn ? 1.0 : 0.35;
  const btn = $("speakerBtn");
  if (btn) btn.classList.toggle("active", speakerOn);
  await updateSpeakerIcon();
  toast(speakerOn ? "Speaker on" : "Speaker off");
}

// Swap the speaker button's icon to a headset glyph if a headset/Bluetooth
// audio output device is detected (or currently selected).
const SVG_SPEAKER  = `<path d="M3 10v4a1 1 0 001 1h3l5 4V5L7 9H4a1 1 0 00-1 1z"/><path d="M16 8a5 5 0 010 8M19 5a9 9 0 010 14"/>`;
const SVG_HEADSET  = `<path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/>`;
const SVG_BLUETOOTH= `<path d="M7 7l10 10-5 5V2l5 5L7 17"/>`;

async function updateSpeakerIcon() {
  const icon = document.getElementById("speakerIcon");
  if (!icon) return;
  let kind = "speaker";
  // If user explicitly switched to loudspeaker, always show speaker icon.
  if (Call._speakerState) {
    kind = "speaker";
  } else {
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outs = devs.filter((d) => d.kind === "audiooutput");
        const text = outs.map((d) => (d.label || "").toLowerCase()).join(" | ");
        if (/bluetooth|airpods|buds/.test(text)) kind = "bluetooth";
        else if (/head(set|phone)|earphone|earbud|earpiece/.test(text)) kind = "headset";
      }
    } catch {}
  }
  const svg = kind === "bluetooth" ? SVG_BLUETOOTH : kind === "headset" ? SVG_HEADSET : SVG_SPEAKER;
  if (icon.dataset.kind !== kind) {
    icon.innerHTML = svg;
    icon.dataset.kind = kind;
  }
  const btn = $("speakerBtn");
  if (btn) btn.title = kind === "bluetooth" ? "Bluetooth audio" : kind === "headset" ? "Headset" : "Speaker";
}

async function toggleCamera() {
  if (!Call.localStream || !Call.isVideo) return;
  // If we already have a video track, just enable/disable it.
  let vt = Call.localStream.getVideoTracks()[0];
  if (vt) {
    vt.enabled = !vt.enabled;
    Call.camOn = vt.enabled;
  } else {
    // Add a video track on demand (mid-call upgrade).
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      vt = s.getVideoTracks()[0];
      Call.localStream.addTrack(vt);
      // Replace into the existing PC if a video sender exists, else add.
      const sender = Call.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(vt);
      else Call.pc.addTrack(vt, Call.localStream);
      Call.camOn = true;
    } catch (e) {
      toast("Camera permission denied: " + e.message);
      return;
    }
  }
  attachLocalVideo();
  const btn = $("camBtn");
  if (btn) btn.classList.toggle("active", !Call.camOn);
}

function attachLocalVideo() {
  const v = $("localVideo");
  if (v && Call.localStream) v.srcObject = Call.localStream;
  showVideoStage(true);
  const btn = $("camBtn");
  if (btn) {
    btn.classList.remove("hidden");
    btn.classList.toggle("active", !Call.camOn);
  }
}

function showVideoStage(on) {
  const stage = $("videoStage");
  if (!stage) return;
  stage.classList.toggle("hidden", !on);
  stage.setAttribute("aria-hidden", on ? "false" : "true");
}

function teardownCall(local) {
  stopRingtone();
  try { Call.pc?.close(); } catch {}
  if (Call.localStream) {
    for (const t of Call.localStream.getTracks()) t.stop();
  }
  const audio = $("remoteAudio");
  if (audio) audio.srcObject = null;
  const rv = $("remoteVideo"); if (rv) rv.srcObject = null;
  const lv = $("localVideo");  if (lv) lv.srcObject = null;
  showVideoStage(false);
  $("callPanel").classList.add("hidden");
  $("incomingCall").classList.add("hidden");
  if (local !== true) toast("Call ended");
  resetCallState();
}

function resetCallState() {
  Call.pc = null;
  Call.localStream = null;
  Call.channelId = null;
  Call.peerId = null;
  Call.peerName = "";
  Call.state = "idle";
  Call.muted = false;
  Call.isVideo = false;
  Call.camOn = false;
  Call._speakerState = false;
  Call.pendingIce = [];
  const btn = $("muteBtn");
  if (btn) btn.classList.remove("active");
  const sbtn = $("speakerBtn");
  if (sbtn) sbtn.classList.remove("active");
  const cbtn = $("camBtn");
  if (cbtn) { cbtn.classList.remove("active"); cbtn.classList.add("hidden"); }
  const audio = $("remoteAudio");
  if (audio) audio.volume = 0.35;
}

function showCallBar(status) {
  const bar = $("callPanel");
  $("cbName").textContent = Call.peerName || "Unknown";
  const peer = S.users.get(Call.peerId);
  const av = $("cbAvatar");
  if (av) {
    av.textContent = peer?.avatar || (Call.peerName?.[0] || "?").toUpperCase();
    av.style.background = peer?.color || "var(--brand)";
  }
  setCallStatus(status);
  bar.classList.remove("hidden");
  updateSpeakerIcon();
}

function setCallStatus(s) {
  const el = $("cbStatus");
  if (el) el.textContent = s;
}

async function onCallSignal({ channel, kind, from, fromName, payload }) {
  // Ignore our own echoes from the broadcast bus.
  if (S.me && from === S.me.id) return;

  if (kind === "offer") {
    if (Call.state !== "idle") {
      // Already busy with another call; politely decline.
      sendOp({ op: "call_signal", channel, kind: "busy", payload: null });
      return;
    }
    Call.channelId = channel;
    Call.peerId = from;
    Call.peerName = fromName || (S.users.get(from)?.username || "unknown");
    Call.state = "ringing";
    Call.isVideo = !!payload?.video;
    await createPC();
    try {
      await Call.pc.setRemoteDescription(payload.sdp);
      await drainPendingIce();
    } catch (e) {
      console.warn("setRemoteDescription failed", e);
      resetCallState();
      return;
    }
    // Show the incoming-call modal.
    const peer = S.users.get(from);
    const av = $("icAvatar");
    if (av) {
      av.textContent = peer?.avatar || (Call.peerName?.[0] || "?").toUpperCase();
      av.style.background = peer?.color || "var(--brand)";
    }
    $("icName").textContent = Call.peerName;
    const icSub = $("icSub");
    if (icSub) icSub.textContent = Call.isVideo ? "is video calling…" : "is calling…";
    const icTitle = $("icTitle");
    if (icTitle) icTitle.textContent = Call.isVideo ? "Incoming video call" : "Incoming audio call";
    $("incomingCall").classList.remove("hidden");
    startRingtone();
    return;
  }

  // For all other kinds, must match the active call.
  if (channel !== Call.channelId || from !== Call.peerId) return;

  if (kind === "answer") {
    try {
      await Call.pc.setRemoteDescription(payload.sdp);
      await drainPendingIce();
      Call.state = "active";
      setCallStatus("Connected");
    } catch (e) {
      console.warn("answer setRemoteDescription failed", e);
    }
  } else if (kind === "ice") {
    const cand = payload?.candidate;
    if (!cand) return;
    if (Call.pc?.remoteDescription && Call.pc.remoteDescription.type) {
      try { await Call.pc.addIceCandidate(cand); } catch (e) { console.warn("addIceCandidate", e); }
    } else {
      Call.pendingIce.push(cand);
    }
  } else if (kind === "end" || kind === "decline" || kind === "busy") {
    const why = kind === "busy" ? "Peer is busy" : (kind === "decline" ? "Call declined" : "Call ended");
    teardownCall(false);
    toast(why);
  }
}

async function drainPendingIce() {
  while (Call.pendingIce.length) {
    const c = Call.pendingIce.shift();
    try { await Call.pc.addIceCandidate(c); } catch (e) { console.warn("drain ICE", e); }
  }
}

// ── Ringtone (Web Audio, no asset needed) ────────────────────────────
let _ringCtx = null;
let _ringTimer = null;
let _ringNodes = [];
function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _ringCtx = new Ctx();
    const tone = () => {
      const ctx = _ringCtx;
      if (!ctx) return;
      const now = ctx.currentTime;
      // Two short beeps per ring, like a classic phone bell.
      for (let i = 0; i < 2; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 480 + (i % 2) * 140; // alternating 480/620 Hz
        const t0 = now + i * 0.45;
        const t1 = t0 + 0.32;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.setValueAtTime(0.18, t1 - 0.04);
        gain.gain.linearRampToValueAtTime(0, t1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t1 + 0.05);
        _ringNodes.push(osc, gain);
      }
    };
    tone();
    _ringTimer = setInterval(tone, 2500);
  } catch (e) {
    console.warn("ringtone failed", e);
  }
}
function stopRingtone() {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
  for (const n of _ringNodes) { try { n.disconnect && n.disconnect(); } catch {} }
  _ringNodes = [];
  if (_ringCtx) { try { _ringCtx.close(); } catch {} _ringCtx = null; }
}
