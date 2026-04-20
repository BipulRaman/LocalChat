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

// ── Per-server localStorage namespace ────────────────────────────────
// Every LocalChat database stamps a stable `server_id` (UUID) at first
// creation and returns it from /api/info. We keep ONE localStorage
// entry per server, keyed by that id, whose value is a JSON blob of
// every client-side setting. This means:
//   - different LocalChat networks never see each other's state
//   - wiping a server's data folder gives clients a clean bucket
//     (the new DB stamps a fresh id → a new, empty key)
//   - settings are trivially inspectable / removable per network
//
// Wire format in window.localStorage:
//   "localchat:<server_id>" -> JSON.stringify({
//       "username": "...",
//       "e2ee-kp":  "...",
//       "outbox:v1": "[...]",
//       ...
//   })
//
// Reads before bootServerId() resolves use a transient in-memory bucket
// so nothing is ever written to the wrong namespace.
const _STORE_PREFIX = "localchat:";
let _storeReady = false;
let _storeKey = null;           // full localStorage key for current server
const _pendingStore = {};       // pre-boot writes, replayed once known
let _bucketCache = null;        // last-read bucket for the current server

function _readBucket() {
  if (!_storeReady) return _pendingStore;
  if (_bucketCache) return _bucketCache;
  try {
    _bucketCache = JSON.parse(localStorage.getItem(_storeKey) || "{}") || {};
  } catch {
    _bucketCache = {};
  }
  return _bucketCache;
}
function _writeBucket() {
  if (!_storeReady || !_bucketCache) return;
  try { localStorage.setItem(_storeKey, JSON.stringify(_bucketCache)); } catch {}
}
const lstore = {
  get(key) {
    const b = _readBucket();
    return Object.prototype.hasOwnProperty.call(b, key) ? b[key] : null;
  },
  set(key, value) {
    if (!_storeReady) { _pendingStore[key] = String(value); return; }
    const b = _readBucket();
    b[key] = String(value);
    _writeBucket();
  },
  remove(key) {
    if (!_storeReady) { delete _pendingStore[key]; return; }
    const b = _readBucket();
    if (!(key in b)) return;
    delete b[key];
    _writeBucket();
  },
  // Remove every other LocalChat server bucket from this device. Useful
  // for a "forget other networks" admin button later; not called
  // automatically.
  pruneOthers() {
    if (!_storeReady) return;
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_STORE_PREFIX) && k !== _storeKey) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  },
};
function bindServerId(id) {
  if (!id) return;
  _storeKey = _STORE_PREFIX + String(id);
  _storeReady = true;
  _bucketCache = null;
  // Replay any writes that happened before /api/info responded.
  if (Object.keys(_pendingStore).length) {
    const b = _readBucket();
    Object.assign(b, _pendingStore);
    _writeBucket();
    for (const k of Object.keys(_pendingStore)) delete _pendingStore[k];
  }
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
    const stored = lstore.get("e2ee-kp");
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
    lstore.set("e2ee-kp", JSON.stringify({ privJwk, pubJwk }));
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

  // Encrypt arbitrary bytes for a DM peer. Returns { iv, ct } as Uint8Arrays.
  // Used for end-to-end encrypting file bodies before they hit /api/upload.
  async encryptBytesFor(peerId, peerPubStr, bytes) {
    if (!this.available) throw new Error("E2EE unavailable in this context");
    const key = await this._derive(peerId, peerPubStr);
    if (!key) throw new Error("peer has no E2EE key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, bytes,
    ));
    return { iv, ct };
  },

  // Decrypt previously-encrypted bytes from a DM peer.
  async decryptBytesFrom(peerId, peerPubStr, iv, ct) {
    if (!this.available) return null;
    try {
      const key = await this._derive(peerId, peerPubStr);
      if (!key) return null;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new Uint8Array(pt);
    } catch {
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

// ── E2EE file body decrypt cache ─────────────────────────────────────
// Keyed by the storage filename (which is unique per upload). Returns a
// blob: URL pointing at the decrypted bytes so <img>/<video>/<audio>/<a>
// can use them transparently. Misses fetch+decrypt once and memoize.
const _e2eeBlobUrlCache = new Map();
const _e2eeBlobUrlPending = new Map();
// Replace an attachment node's contents with a "Media deleted" placeholder.
// Used when the underlying file on disk is gone (HTTP 404 from /uploads/...)
// or when E2EE decrypt can't run because the ciphertext has been wiped.
function showMediaDeleted(att, realName) {
  if (!att || att.dataset.deleted === "1") return;
  att.dataset.deleted = "1";
  att.classList.add("att-deleted");
  att.replaceChildren(el("div", { class: "file deleted-file", title: "The original file is no longer on the server." }, [
    el("div", { class: "file-icon" }, "✕"),
    el("div", { class: "file-meta" }, [
      el("div", { class: "file-name" }, realName || "Media"),
      el("div", { class: "file-sub" }, "Media deleted"),
    ]),
  ]));
}

async function getDecryptedBlobUrl(storageName, fetchUrl, envelope, peer) {
  if (_e2eeBlobUrlCache.has(storageName)) return _e2eeBlobUrlCache.get(storageName);
  if (_e2eeBlobUrlPending.has(storageName)) return _e2eeBlobUrlPending.get(storageName);
  if (!peer || !peer.pubkey || !envelope?.iv) return null;
  const promise = (async () => {
    const res = await fetch(fetchUrl, { cache: "force-cache" });
    if (!res.ok) throw new Error(`fetch ${storageName} failed: ${res.status}`);
    const ct = new Uint8Array(await res.arrayBuffer());
    const iv = unb64(envelope.iv);
    const pt = await E2EE.decryptBytesFrom(peer.id, peer.pubkey, iv, ct);
    if (!pt) throw new Error("decrypt failed");
    const blob = new Blob([pt], { type: envelope.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    _e2eeBlobUrlCache.set(storageName, url);
    return url;
  })();
  _e2eeBlobUrlPending.set(storageName, promise);
  try { return await promise; }
  finally { _e2eeBlobUrlPending.delete(storageName); }
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
  replyTo: null,           // { channelId, msgId, username, preview }
};

// ── Boot ─────────────────────────────────────────────────────────────
(async function boot() {
  // Resolve which server we're talking to BEFORE touching localStorage,
  // so every read/write lands in the per-server bucket. Falls back to
  // a synthetic id derived from the page origin if /api/info fails —
  // still better than collapsing every server into one global bucket.
  try {
    const info = await fetch("/api/info").then((r) => r.json());
    bindServerId(info && info.server_id ? info.server_id : `origin:${location.host}`);
    S.hostname = (info && info.hostname) || "";
  } catch {
    bindServerId(`origin:${location.host}`);
  }

  try { await E2EE.init(); } catch (e) { console.warn("E2EE init failed", e); }

  // Refresh speaker/headset icon when audio devices change (plug/unplug).
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => updateSpeakerIcon().catch(() => {}));
  }

  // Mobile keyboard handling is delegated to CSS `100dvh` (dynamic
  // viewport units), which Chrome 108+ / Safari 15.4+ resize correctly
  // when the soft keyboard opens. We used to override with a
  // visualViewport-driven `--vv-h`, but that fought Android Chrome's
  // own scroll-into-view behaviour and left the composer stranded mid-
  // viewport. `dvh` is simpler and more reliable.

  // Pre-fill the saved username, but never auto-connect: every join now
  // requires a password supplied by the user.
  const saved = lstore.get("username");
  if (saved) {
    $("username").value = saved;
    const pw = $("password");
    if (pw) pw.focus();
  }
})();

// ── Join flow ────────────────────────────────────────────────────────
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,23}$/.test(username)) {
    const status = $("joinStatus");
    if (status) {
      status.textContent = "Username must be 3-24 chars: letters, digits, underscore, hyphen, or dot. No spaces.";
      status.classList.add("err");
    }
    const input = $("username");
    if (input) { input.classList.add("err"); input.focus(); }
    return;
  }
  if (!password || password.length < 4) {
    const status = $("joinStatus");
    if (status) {
      status.textContent = "Password must be at least 4 characters.";
      status.classList.add("err");
    }
    const pw = $("password");
    if (pw) { pw.classList.add("err"); pw.focus(); }
    return;
  }
  lstore.set("username", username);
  connect(username, password);
});

function connect(username, password) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  $("joinStatus").textContent = "Connecting…";

  ws.onopen = () => {
    ws.send(JSON.stringify({
      op: "join",
      username,
      password: password || "",
      userId: lstore.get("userId") || "",
      pubkey: E2EE.myPubStr(),
    }));
    // Drain anything that was queued while the socket was down.
    flushOutbox();
  };
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus("off", "disconnected");
    if (S.me) {
      S.reconnectTries += 1;
      setStatus("warn", "reconnecting…");
      setTimeout(() => connect(S.me.username, password), Math.min(6000, 400 * S.reconnectTries));
    } else {
      const status = $("joinStatus");
      // If the server already pushed a specific error (e.g. username taken),
      // don't clobber it with a generic "Connection closed" line.
      if (status && !status.classList.contains("err")) {
        status.textContent = "Connection closed. Try again.";
      }
    }
  };
  ws.onerror = () => {
    const status = $("joinStatus");
    if (status && !status.classList.contains("err")) {
      status.textContent = "Cannot reach server.";
    }
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
    case "ch_invited":   return onChannelInvited(e);
    case "ch_deleted":   return onChannelDeleted(e.channel);
    case "kicked":       return onKicked(e);
    case "error":        return onError(e);
    case "pong":         return;
    case "password_changed": return onPasswordChanged();
    default:             console.debug("[ev]", e);
  }
}

// The server tells us we've been disconnected by an admin (kick, ban,
// or a flush/reset). Drop our identity, show a one-shot notice, and let
// the natural reconnect loop bring up the join screen.
function onKicked(e) {
  const reason = (e && e.text) || (e && e.reason) || "removed by administrator";
  try { lstore.remove("username"); } catch {}
  S.me = null;
  setStatus("warn", "Kicked");
  if (typeof toast === "function") toast("Disconnected: " + reason);
  // Force a clean reconnect so the join screen reappears.
  try { S.ws && S.ws.close(); } catch {}
  setTimeout(() => location.reload(), 1500);
}

function onError(e) {
  if (!S.me) {
    // Server rejected our auto-join (banned, bad name, name taken, etc.).
    // Drop the saved name so the user can pick a different one, surface
    // the message in the join screen, and stop the reconnect loop.
    // Wrong-password and password-required errors leave the username
    // alone so the user can just retype their password.
    if (e.code !== "bad_password" && e.code !== "password_required" && e.code !== "password_weak") {
      lstore.remove("username");
    }
    const status = $("joinStatus");
    if (status) {
      status.textContent = e.text || "Could not join.";
      status.classList.add("err");
    }
    if (e.code === "username_taken") {
      const input = $("username");
      if (input) {
        input.value = "";
        input.focus();
        input.classList.add("err");
        input.addEventListener("input", () => {
          input.classList.remove("err");
          if (status) { status.textContent = ""; status.classList.remove("err"); }
        }, { once: true });
      }
    } else if (e.code === "bad_password" || e.code === "password_required" || e.code === "password_weak") {
      const pw = $("password");
      if (pw) {
        pw.value = "";
        pw.focus();
        pw.classList.add("err");
        pw.addEventListener("input", () => {
          pw.classList.remove("err");
          if (status) { status.textContent = ""; status.classList.remove("err"); }
        }, { once: true });
      }
    }
    // Close the socket so the onclose handler doesn't try to reconnect
    // with the same rejected name.
    try { S.ws && S.ws.close(); } catch {}
    return;
  }
  // If the change-password modal is open, surface the error inline
  // instead of as a generic toast.
  const cpwModal = $("changePwModal");
  if (cpwModal && !cpwModal.classList.contains("hidden") &&
      (e.code === "bad_password" || e.code === "password_weak")) {
    const status = $("cpwStatus");
    if (status) {
      status.textContent = e.text || "Password change failed.";
      status.classList.add("err");
      status.classList.remove("ok");
    }
    return;
  }
  toast(e.text || "Server error");
}

function onWelcome(e) {
  S.me = e.user;
  S.session = e.session || null;
  S.reconnectTries = 0;
  // Persist the server-issued UserId so a future reconnect (or a brand
  // new browser, after the user re-enters their password) can echo it
  // back and reclaim the same identity.
  try { if (S.me && S.me.id) lstore.set("userId", S.me.id); } catch {}
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
    ]),
    el("button", {
      id: "themeToggle",
      class: "icon-btn", title: "Toggle theme", "aria-label": "Toggle theme",
      onclick: toggleTheme,
    }),
    el("button", {
      class: "icon-btn", title: "Change password", "aria-label": "Change password",
      onclick: () => openChangePasswordModal({ forced: false }),
      html: `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2a5 5 0 00-5 5v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 016 0v3H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
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
  if (e.mustChangePassword) {
    setTimeout(() => openChangePasswordModal({ forced: true }), 200);
  }
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
  if (m.username === "__media_deleted") {
    try {
      const { channel, ids } = JSON.parse(m.text);
      onMediaDeleted(channel || m.channel, Array.isArray(ids) ? ids : []);
    } catch {}
    return;
  }
  // Suppress noisy join/leave system messages.
  if (m.kind === "system" && /\b(joined|left) the chat\b/.test(m.text || "")) {
    return;
  }
  // If this is the server echoing back a file we just queued, drop the
  // queued copy so we don't replay it on the next reload.
  if (m.kind === "file" && m.file?.id) ackOutboxFile(m.file.id);
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
  // Drop any queued file ops that the server already accepted (their
  // resulting WireMsg is now visible in history).
  for (const m of filtered) {
    if (m.kind === "file" && m.file?.id) ackOutboxFile(m.file.id);
  }
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

function onChannelInvited({ channel, channelName, inviter }) {
  // Server already sent ch_created right before this, so the channel is
  // in S.channels. Just surface a friendly toast — don't auto-switch
  // (could be jarring mid-conversation).
  const name = channelName || (S.channels.get(channel)?.name || channel);
  const who = inviter ? `${inviter} added you to` : "You were added to";
  toast(`${who} #${name}`);
  renderChannels();
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

// Admin deleted a media file. Patch every cached message in the given
// channel that referenced it: drop the file payload and flip it to a
// system-style "media deleted" marker, matching what the server now
// stores in the DB. If the channel is open we re-render so the change
// is visible immediately, no reload required.
function onMediaDeleted(channel, ids) {
  if (!channel || !ids || !ids.length) return;
  const arr = S.msgs.get(channel);
  if (!arr || !arr.length) return;
  const idSet = new Set(ids.map(Number));
  let touched = false;
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    if (!idSet.has(Number(m.id))) continue;
    arr[i] = {
      ...m,
      kind: "system",
      text: "🗑️ Media deleted by admin",
      file: null,
      deleted: true,
    };
    touched = true;
  }
  if (touched && channel === S.active) {
    $("messages").dataset.activeChannel = "__force";
    renderStream();
  }
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
// Key bumped to v2 so any previously-collapsed groups reopen on first
// load after the upgrade — sections start fully expanded by default.
const SB_COLLAPSE_KEY = "sb-collapsed-v2";
const _sbCollapsed = (() => {
  try { return new Set(JSON.parse(lstore.get(SB_COLLAPSE_KEY) || "[]")); }
  catch { return new Set(); }
})();
function _sbToggle(key, open) {
  if (open) _sbCollapsed.delete(key); else _sbCollapsed.add(key);
  lstore.set(SB_COLLAPSE_KEY, JSON.stringify([..._sbCollapsed]));
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
  const isMember = !!(S.me && (c.members || []).includes(S.me.id));
  const canDelete = c.kind === "group" && S.me && c.createdBy === S.me.id;
  // Creators delete (which removes for everyone). Other members can leave.
  // Lobby can't be left or deleted.
  const canLeave = c.kind === "group" && isMember && !canDelete;
  const askDelete = canDelete ? (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Delete channel",
      body: `Delete channel #${c.name || c.id}?\n\nThis removes the channel and its history for everyone. This cannot be undone.`,
      okText: "Delete",
    }).then((ok) => { if (ok) deleteChannel(c.id); });
  } : null;
  const askLeave = canLeave ? (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Leave channel",
      body: c.isPrivate
        ? `Leave private channel #${c.name || c.id}?\n\nYou'll need to be added back by a member to rejoin.`
        : `Leave #${c.name || c.id}?\n\nYou can rejoin any time from the Channels list.`,
      okText: "Leave",
    }).then((ok) => { if (ok) leaveChannel(c.id); });
  } : null;
  return el("li", {
    class: "chat-item " + active,
    onclick: () => switchChannel(c.id),
    oncontextmenu: askDelete || askLeave || undefined,
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
    canLeave ? el("button", {
      class: "chat-del",
      title: `Leave #${c.name || c.id}`,
      "aria-label": "Leave channel",
      onclick: askLeave,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
    }) : null,
  ]);
}

function deleteChannel(channelId) {
  sendOp({ op: "ch_delete", channel: channelId });
}

function leaveChannel(channelId) {
  const ch = S.channels.get(channelId);
  sendOp({ op: "ch_leave", channel: channelId });
  // Optimistically remove ourselves locally so the sidebar updates and
  // the active view falls back to lobby if needed.
  if (ch && S.me) {
    ch.members = (ch.members || []).filter((id) => id !== S.me.id);
  }
  if (S.active === channelId) {
    const fallback = S.lobby || [...S.channels.keys()][0];
    if (fallback) switchChannel(fallback);
  }
  if (ch) S.channels.delete(channelId);
  S.msgs.delete(channelId);
  S.unread.delete(channelId);
  renderChannels();
  toast(`Left #${ch?.name || channelId}`);
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

// Click an author name / avatar in any channel to open (or jump into)
// a DM with that user. Falls back to looking the user up by username
// when we don't have a live id.
function openDmWithUserId(userId, username) {
  if (S.me && (userId === S.me.id || username === S.me.username)) return;
  // If a DM channel with this user already exists locally, just switch.
  const existing = [...S.channels.values()].find((c) => {
    if (c.kind !== "dm") return null;
    if (userId != null && (c.members || []).includes(userId)) return c;
    if (username && c.dmUsers) {
      const ln = (username || "").toLowerCase();
      return c.dmUsers.some((n) => (n || "").toLowerCase() === ln) ? c : null;
    }
    return null;
  });
  if (existing) { switchChannel(existing.id); return; }
  // Otherwise ask the server to open a fresh DM. Prefer userId; fall back
  // to a username lookup against current presence.
  let id = userId;
  if (id == null && username) {
    const ln = username.toLowerCase();
    const u = [...S.users.values()].find((x) => (x.username || "").toLowerCase() === ln);
    id = u?.id;
  }
  if (id == null) { toast(`${username || "user"} is offline`); return; }
  sendOp({ op: "dm_open", user: id });
}
Object.assign(window, { openDmWithUserId });

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
  if (tab === "all") tab = "mine";
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
  let fileRealName = null;
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
    avatar = el("button", {
      type: "button",
      class: "avatar avatar-link",
      style: `background:${m.color || "#6366f1"}`,
      title: `Message ${m.username}`,
      onclick: (ev) => {
        ev.stopPropagation();
        openDmWithUserId(m.userId, m.username);
      },
    }, m.avatar || "?");
  }

  const bubble = el("div", { class: "bubble" });

  // Replied-to quote: render at top of the bubble. Click jumps to original.
  if (m.replyTo) {
    const orig = (S.msgs.get(m.channel) || []).find((x) => x.id === m.replyTo);
    let quoteText = "(original message unavailable)";
    let quoteName = "message";
    let quoteColor = "var(--brand)";
    if (orig) {
      quoteName = orig.username || quoteName;
      quoteColor = orig.color || quoteColor;
      let t = orig.text || "";
      if (peer && t.startsWith("e2e:v1:")) {
        const pt = await E2EE.tryDecrypt(peer.id, peer.pubkey, t);
        t = pt != null ? pt : "🔒 (encrypted)";
      }
      if (orig.kind === "file") {
        // Prefer the E2EE envelope's real name when present.
        let fileName = orig.file?.originalName;
        if (peer && t && t.startsWith("{")) {
          try {
            const env = JSON.parse(t);
            if (env && env.v === 1 && env.kind === "file" && env.name) fileName = env.name;
          } catch {}
        }
        t = fileName ? `📎 ${fileName}` : "📎 attachment";
      }
      quoteText = t.length > 160 ? t.slice(0, 160) + "…" : (t || "(empty)");
    }
    const quote = el("button", {
      type: "button",
      class: "reply-quote",
      style: `border-left-color:${quoteColor}`,
      title: `Jump to ${quoteName}'s message`,
      onclick: (ev) => { ev.stopPropagation(); jumpToMessage(m.channel, m.replyTo); },
    }, [
      el("div", { class: "reply-quote-name", style: `color:${quoteColor}` }, quoteName),
      el("div", { class: "reply-quote-text" }, quoteText),
    ]);
    bubble.append(quote);
  }

  // Header row above the bubble (Teams-style):
  //  - incoming first-of-group: "Author • Time"
  //  - own first-of-group: "Time" right-aligned
  //  - DM first-of-group: "Time"
  //  - follow-up bubbles: no header
  let header = null;
  const showAuthor = !follow && !isOwn && !isDm;
  if (!follow) {
    if (showAuthor) {
      const authorIsMe = m.userId === S.me?.id;
      header = el("div", { class: "msg-header" }, [
        el(authorIsMe ? "span" : "button", {
          type: authorIsMe ? undefined : "button",
          class: "author" + (authorIsMe ? "" : " author-link"),
          style: `color:${m.color || "var(--brand)"}`,
          title: authorIsMe ? m.username : `Message ${m.username}`,
          onclick: authorIsMe ? undefined : (ev) => {
            ev.stopPropagation();
            openDmWithUserId(m.userId, m.username);
          },
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
    // Detect a DM E2EE envelope. When present, displayText is the JSON
    // metadata that tells us the real name/mime + the AES-GCM IV used
    // to encrypt the body.
    let envelope = null;
    if (peer && displayText && displayText.startsWith("{")) {
      try {
        const parsed = JSON.parse(displayText);
        if (parsed && parsed.v === 1 && parsed.kind === "file" && parsed.iv) {
          envelope = parsed;
          // Don't render the JSON as a caption.
          displayText = "";
        }
      } catch {}
    }

    const realName = envelope?.name || f.originalName;
    fileRealName = realName;
    const realMime = envelope?.mime || f.mimeType || "";
    const isImg   = realMime.startsWith("image/");
    const isVideo = realMime.startsWith("video/");
    const isAudio = realMime.startsWith("audio/");
    const dlUrl   = `/api/download/${encodeURIComponent(f.filename)}?name=${encodeURIComponent(realName)}`;
    const viewUrl = `/uploads/${encodeURIComponent(f.filename)}`;
    const att = el("div", { class: "attachment" });

    // For E2EE attachments, swap viewUrl/dlUrl for blob URLs after
    // decrypt completes. We start with a placeholder src and patch it
    // in once the bytes are ready. If the source file has been deleted
    // from the data folder, swap the attachment for a "Media deleted"
    // placeholder instead.
    const finalize = async (mediaEl, downloadAnchors) => {
      if (!envelope) return;
      try {
        const url = await getDecryptedBlobUrl(f.filename, viewUrl, envelope, peer);
        if (!url) return;
        if (mediaEl) mediaEl.src = url;
        for (const a of downloadAnchors) {
          a.href = url;
          a.setAttribute("download", realName);
        }
      } catch (err) {
        console.warn("e2ee file decrypt failed", err);
        showMediaDeleted(att, realName);
      }
    };

    if (isImg) {
      const img = el("img", {
        src: envelope ? "" : viewUrl,
        alt: realName,
        loading: "lazy",
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      const wrap = el("div", { class: "image-att", title: "Click to expand" }, [
        img,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]);
      wrap.addEventListener("click", async () => {
        if (att.dataset.deleted === "1") return;
        if (envelope) {
          const url = await getDecryptedBlobUrl(f.filename, viewUrl, envelope, peer);
          if (url) openLightbox(url, realName, url);
        } else {
          openLightbox(viewUrl, realName, dlUrl);
        }
      });
      att.append(wrap);
      finalize(img, [dlA]);
    } else if (isVideo) {
      const video = el("video", {
        src: envelope ? "" : viewUrl,
        controls: "",
        preload: "metadata",
        playsinline: "",
        onclick: (e) => e.stopPropagation(),
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      att.append(el("div", { class: "video-att" }, [
        video,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]));
      finalize(video, [dlA]);
    } else if (isAudio) {
      const audio = el("audio", {
        src: envelope ? "" : viewUrl,
        controls: "",
        preload: "metadata",
        onclick: (e) => e.stopPropagation(),
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      att.append(el("div", { class: "audio-att" }, [
        audio,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]));
      finalize(audio, [dlA]);
    } else {
      const dlA = el("a", {
        class: "file", href: envelope ? "" : dlUrl,
        target: envelope ? undefined : "_blank",
        rel: "noopener",
        onclick: async (e) => {
          if (att.dataset.deleted === "1") { e.preventDefault(); return; }
          if (envelope) return; // blob URL is ready or finalize handled errors
          // Probe the source so we can show "Media deleted" if it's gone.
          try {
            const res = await fetch(viewUrl, { method: "HEAD" });
            if (!res.ok) {
              e.preventDefault();
              showMediaDeleted(att, realName);
            }
          } catch {
            e.preventDefault();
            showMediaDeleted(att, realName);
          }
        },
      }, [
        el("div", { class: "file-icon" }, fileExt(realName)),
        el("div", { class: "file-meta" }, [
          el("div", { class: "file-name" }, realName),
          el("div", { class: "file-sub" }, fmtSize(envelope?.size || f.size)),
        ]),
        el("div", { class: "file-dl", html: `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` }),
      ]);
      att.append(dlA);
      finalize(null, [dlA]);
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
      onclick: (ev) => { ev.stopPropagation(); startReplyTo(m, displayText, fileRealName); },
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

  return el("div", { class: classes.join(" "), id: `m-${m.channel}-${m.id}` }, [avatar, stack]);
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
  const joinBtn = $("joinBtn");
  const addPeopleBtn = $("addPeopleBtn");
  if (!ch) return;

  // "Join" appears for public groups the current user isn't already a member of.
  const isMember = !!(S.me && (ch.members || []).includes(S.me.id));
  if (joinBtn) joinBtn.classList.toggle("hidden", !(ch.kind === "group" && !ch.isPrivate && !isMember));
  // "Add people" appears for any group channel you're already a member of.
  // For private channels this is the ONLY way for new people to get in.
  if (addPeopleBtn) addPeopleBtn.classList.toggle("hidden", !(ch.kind === "group" && isMember));

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
  if (S.replyTo && S.replyTo.channelId !== id) clearReplyTo();
  else renderReplyPreview();
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

// Outbox for ops that MUST reach the server. Anything queued here is
// flushed once the WS reconnects + re-joins. Use for user-visible work
// the user thinks already "happened" (sending a chat message,
// announcing an uploaded file). Transient ops (typing, history,
// presence) intentionally use plain sendOp and are dropped if the
// socket is down.
//
// Persisted to localStorage so a page refresh during an in-flight
// upload still posts the file message once we reconnect.
const _OUTBOX_KEY = "outbox:v1";
function _loadOutbox() {
  try { return JSON.parse(lstore.get(_OUTBOX_KEY) || "[]"); }
  catch { return []; }
}
function _saveOutbox() {
  try { lstore.set(_OUTBOX_KEY, JSON.stringify(_outbox)); } catch {}
}
const _outbox = _loadOutbox();
function sendOpReliable(obj) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  _outbox.push(obj);
  _saveOutbox();
  toast("Offline — will send when reconnected…", 3000);
  return false;
}
// Stronger guarantee for ops where losing the message is unacceptable
// (file uploads): always queue first, send, and only drop the entry
// when the server echoes the resulting WireMsg back. The server
// dedupes by file_id so replays after a refresh are safe.
function queueAndSend(obj) {
  _outbox.push(obj);
  _saveOutbox();
  if (S.ws && S.ws.readyState === 1) {
    try { S.ws.send(JSON.stringify(obj)); } catch {}
  }
}
function ackOutboxFile(fileId) {
  if (!fileId) return;
  const before = _outbox.length;
  for (let i = _outbox.length - 1; i >= 0; i--) {
    const o = _outbox[i];
    if (o && o.op === "file" && o.file && o.file.id === fileId) {
      _outbox.splice(i, 1);
    }
  }
  if (_outbox.length !== before) _saveOutbox();
}
function flushOutbox() {
  // Re-send everything currently queued. Items remain queued until
  // explicitly acked (file ops) or until the WS frame is flushed for
  // fire-and-forget items (text sends).
  if (!S.ws || S.ws.readyState !== 1) return;
  // Snapshot to avoid mutation during send.
  const items = _outbox.slice();
  let nonFileDrained = false;
  for (const obj of items) {
    try { S.ws.send(JSON.stringify(obj)); }
    catch { return; }
    // Text ops auto-drop after send (they're idempotent enough; the
    // user sees the optimistic UI). File ops stay until echo.
    if (obj.op !== "file") {
      const idx = _outbox.indexOf(obj);
      if (idx >= 0) { _outbox.splice(idx, 1); nonFileDrained = true; }
    }
  }
  if (nonFileDrained) _saveOutbox();
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

  const op = { op: "send", channel: S.active, text: payload };
  if (S.replyTo && S.replyTo.channelId === S.active) op.replyTo = S.replyTo.msgId;
  sendOpReliable(op);
  sendOp({ op: "typing", channel: S.active, typing: false });
  clearReplyTo();
}

// ── Reply-to ──────────────────────────────────────────────────────────
function startReplyTo(m, plainText, fileRealName) {
  if (!m || m.kind === "system") return;
  const txt = (plainText != null ? plainText : (m.text || "")).toString();
  const fileName = fileRealName || m.file?.originalName;
  const preview = m.kind === "file"
    ? (fileName ? `📎 ${fileName}` : "📎 attachment")
    : (txt.length > 140 ? txt.slice(0, 140) + "…" : txt);
  S.replyTo = {
    channelId: m.channel,
    msgId: m.id,
    username: m.username || "",
    preview,
  };
  renderReplyPreview();
  $("msgInput").focus();
}
function clearReplyTo() {
  if (!S.replyTo) return;
  S.replyTo = null;
  renderReplyPreview();
}
function renderReplyPreview() {
  const box = $("replyPreview");
  if (!box) return;
  if (!S.replyTo || S.replyTo.channelId !== S.active) {
    box.classList.add("hidden");
    return;
  }
  $("replyPreviewName").textContent = S.replyTo.username || "message";
  $("replyPreviewText").textContent = S.replyTo.preview || "";
  box.classList.remove("hidden");
}
Object.assign(window, { startReplyTo, clearReplyTo });

function jumpToMessage(channelId, msgId) {
  if (channelId !== S.active) switchChannel(channelId);
  const tryScroll = (tries) => {
    const node = document.getElementById(`m-${channelId}-${msgId}`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("msg-flash");
      setTimeout(() => node.classList.remove("msg-flash"), 1600);
    } else if (tries > 0) {
      setTimeout(() => tryScroll(tries - 1), 80);
    }
  };
  tryScroll(8);
}
Object.assign(window, { jumpToMessage });
const _warnedNoKey = new Set();

// Composer
const msgInput = $("msgInput");
$("replyPreviewClose")?.addEventListener("click", () => clearReplyTo());
msgInput.addEventListener("input", () => {
  autoGrow(msgInput);
  if (S.typingTimer) clearTimeout(S.typingTimer);
  sendOp({ op: "typing", channel: S.active, typing: true });
  S.typingTimer = setTimeout(() => sendOp({ op: "typing", channel: S.active, typing: false }), 2500);
});
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.replyTo) {
    e.preventDefault();
    clearReplyTo();
    return;
  }
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
// it. For DMs we encrypt the bytes client-side with the same ECDH-derived
// AES-GCM key used for text, so the server only stores opaque ciphertext.
// The original filename + mime travel inside an E2EE envelope in `text`.
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  await uploadFile(f);
  e.target.value = "";
});

// ── Modals ───────────────────────────────────────────────────────────
function openCreateChannel() {
  $("createModal").classList.remove("hidden");
  $("newChName").focus();
}
function closeModal(id) { $(id).classList.add("hidden"); }
function openModal(id) { const m = $(id); if (m) m.classList.remove("hidden"); }

// ── Sidebar "+" menu (new channel / new DM) ─────────────────────────
function toggleNewMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = $("sbNewMenu");
  const btn = $("sbNewBtn");
  if (!menu || !btn) return;
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) {
    document.addEventListener("click", _newMenuOutside, true);
    document.addEventListener("keydown", _newMenuKey, true);
  } else {
    closeNewMenu();
  }
}
function closeNewMenu() {
  const menu = $("sbNewMenu");
  const btn = $("sbNewBtn");
  if (menu) menu.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", _newMenuOutside, true);
  document.removeEventListener("keydown", _newMenuKey, true);
}
function _newMenuOutside(e) {
  const menu = $("sbNewMenu"); const btn = $("sbNewBtn");
  if (!menu || menu.classList.contains("hidden")) return;
  if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeNewMenu();
}
function _newMenuKey(e) { if (e.key === "Escape") closeNewMenu(); }
Object.assign(window, { toggleNewMenu, closeNewMenu });

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

// ── Self-join a public group channel ────────────────────────────────
function joinCurrentChannel() {
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "group" || ch.isPrivate) return;
  if (S.me && (ch.members || []).includes(S.me.id)) return;
  sendOp({ op: "ch_join", channel: ch.id });
  // Optimistically reflect membership so the Join button hides immediately.
  if (S.me) {
    ch.members = ch.members || [];
    if (!ch.members.includes(S.me.id)) ch.members.push(S.me.id);
  }
  toast(`Joined #${ch.name || ch.id}`);
  updateHeader();
  renderMembers();
}

Object.assign(window, { joinCurrentChannel });

// ── Add people to a group channel (works for public + private) ──────
const _inv = { selected: new Set() };
function openInviteModal() {
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "group") return;
  if (!S.me || !(ch.members || []).includes(S.me.id)) return;
  _inv.selected.clear();
  const sub = $("invSub");
  if (sub) sub.textContent = ch.isPrivate
    ? `Add people to private channel #${ch.name || ch.id}. Only members can see it.`
    : `Add people to #${ch.name || ch.id}.`;
  $("invSearch").value = "";
  renderInviteList();
  $("inviteModal").classList.remove("hidden");
  setTimeout(() => $("invSearch").focus(), 0);
}

function renderInviteList() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  const list = $("invList");
  const q = ($("invSearch").value || "").trim().toLowerCase();
  const members = new Set(ch.members || []);
  const candidates = [...S.users.values()]
    .filter((u) => u.id !== S.me?.id && !members.has(u.id))
    .filter((u) => !q || (u.username || "").toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username));
  list.innerHTML = "";
  if (!candidates.length) {
    list.append(el("li", { class: "muted sm" },
      q ? "No one matches your search." : "Everyone online is already a member."));
  }
  for (const u of candidates) {
    const checked = _inv.selected.has(u.id);
    const li = el("li", {
      class: "inv-item" + (checked ? " checked" : ""),
      onclick: () => {
        if (_inv.selected.has(u.id)) _inv.selected.delete(u.id);
        else _inv.selected.add(u.id);
        renderInviteList();
      },
    }, [
      el("div", { class: "avatar xs", style: `background:${u.color}` },
        u.avatar || (u.username?.[0] || "?").toUpperCase()),
      el("span", { class: "inv-name" }, u.username),
      el("span", { class: "inv-check", "aria-hidden": "true" }, checked ? "✓" : ""),
    ]);
    list.append(li);
  }
  const n = _inv.selected.size;
  $("invCount").textContent = `${n} selected`;
  $("invSendBtn").disabled = n === 0;
  $("invSendBtn").textContent = n > 0 ? `Add ${n}` : "Add";
}

function sendInvites() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  const ids = [..._inv.selected];
  if (!ids.length) return;
  sendOp({ op: "ch_invite", channel: ch.id, users: ids });
  // Optimistically reflect new members so the picker / list updates.
  ch.members = ch.members || [];
  for (const id of ids) if (!ch.members.includes(id)) ch.members.push(id);
  toast(`Added ${ids.length} to #${ch.name || ch.id}`);
  closeModal("inviteModal");
  updateHeader();
  renderMembers();
}

Object.assign(window, { openInviteModal, renderInviteList, sendInvites });

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
  lstore.remove("username");
  // Close socket cleanly so we don't auto-reconnect.
  if (S.ws) {
    try { S.ws.onclose = null; S.ws.close(); } catch {}
  }
  S.me = null;
  S.ws = null;
  location.reload();
}

// ── Change password ─────────────────────────────────────────────────
let _cpwForced = false;
function openChangePasswordModal({ forced } = {}) {
  _cpwForced = !!forced;
  const intro = $("cpwIntro");
  const closeBtn = $("cpwClose");
  const cancelBtn = $("cpwCancel");
  if (intro) {
    intro.textContent = forced
      ? "An administrator has reset your password. Enter the temporary password and choose a new one to continue."
      : "Update the password you use to log in from any browser.";
  }
  if (closeBtn) closeBtn.style.display = forced ? "none" : "";
  if (cancelBtn) cancelBtn.style.display = forced ? "none" : "";
  $("cpwCurrent").value = "";
  $("cpwNew").value = "";
  $("cpwConfirm").value = "";
  $("cpwStatus").textContent = "";
  $("cpwStatus").classList.remove("err", "ok");
  openModal("changePwModal");
  setTimeout(() => $("cpwCurrent").focus(), 30);
}

function submitChangePassword(ev) {
  ev.preventDefault();
  const cur = $("cpwCurrent").value;
  const next = $("cpwNew").value;
  const conf = $("cpwConfirm").value;
  const status = $("cpwStatus");
  status.classList.remove("err", "ok");
  if (next.length < 4) {
    status.textContent = "New password must be at least 4 characters.";
    status.classList.add("err"); return;
  }
  if (next !== conf) {
    status.textContent = "New passwords do not match.";
    status.classList.add("err"); return;
  }
  if (next === cur) {
    status.textContent = "New password must differ from the current one.";
    status.classList.add("err"); return;
  }
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    status.textContent = "Not connected. Try again in a moment.";
    status.classList.add("err"); return;
  }
  status.textContent = "Saving…";
  try { S.ws.send(JSON.stringify({ op: "change_password", current: cur, new: next })); }
  catch { status.textContent = "Failed to send."; status.classList.add("err"); }
}

function onPasswordChanged() {
  const status = $("cpwStatus");
  if (status) {
    status.textContent = "Password updated.";
    status.classList.remove("err");
    status.classList.add("ok");
  }
  toast("Password changed.");
  setTimeout(() => closeModal("changePwModal"), 700);
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
  // The atomic /api/upload handler authenticates via the per-WS
  // session token from the welcome envelope. If we haven't received
  // it yet (page just loaded, WS still connecting), wait briefly so
  // the upload doesn't silently land as an orphan with no message.
  if (!S.session) {
    toast("Connecting…", 1500);
    const start = Date.now();
    while (!S.session && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!S.session) {
      toast("Not connected — try again in a moment", 4000);
      return;
    }
  }
  const ch = S.channels.get(S.active);
  const peer = ch ? dmPeer(ch) : null;
  const isDmEncrypted = ch?.kind === "dm" && peer?.pubkey && E2EE.available;

  let blobToUpload = f;
  let uploadName = f.name;
  let uploadType = f.type || "application/octet-stream";
  let envelopeWire = "";

  if (isDmEncrypted) {
    try {
      toast(`Encrypting ${f.name}…`, 10000);
      const buf = await f.arrayBuffer();
      const { iv, ct } = await E2EE.encryptBytesFor(peer.id, peer.pubkey, buf);
      // Upload pure ciphertext as opaque bytes. The server (and admin)
      // sees only "encrypted.bin" of mime application/octet-stream.
      blobToUpload = new Blob([ct], { type: "application/octet-stream" });
      uploadName = "encrypted.bin";
      uploadType = "application/octet-stream";
      // Wrap real metadata + IV in an envelope and E2EE-encrypt it as
      // the message text. Receivers parse this to learn how to decrypt
      // the file body and what it actually is.
      const env = JSON.stringify({
        v: 1, kind: "file",
        iv: b64(iv),
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
      });
      envelopeWire = await E2EE.encryptFor(peer.id, peer.pubkey, env);
    } catch (err) {
      toast("Encrypt failed: " + err.message, 4000);
      return;
    }
  } else if (ch?.kind === "dm") {
    // DM but no peer pubkey / insecure context — warn before sending in clear.
    if (!confirm(
      "Direct-message files normally travel end-to-end encrypted, but the peer's\n" +
      "encryption key isn't available right now (peer offline or insecure context).\n\n" +
      "Send this file in plaintext anyway? The server admin will be able to read it.")) {
      return;
    }
  }

  // Atomic upload+post. We package channel, the (encrypted) text
  // envelope, and a stable client_id alongside the file bytes. The
  // server saves the file, inserts the message, and broadcasts in
  // a single request — there is no separate WS announce step that
  // could be lost on refresh. The client_id makes retries idempotent.
  const form = new FormData();
  form.append("file", blobToUpload, uploadName);
  form.append("channel", S.active);
  if (envelopeWire) form.append("text", envelopeWire);
  if (S.session) form.append("session", S.session);
  const clientId = (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));
  form.append("client_id", clientId);
  try {
    toast(`Uploading ${f.name}…`, 10000);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    // Server already broadcast the message via the channel bus;
    // our own onWireMsg will render it. Nothing else to do.
    toast(isDmEncrypted ? `Sent (encrypted) ${f.name}` : `Uploaded ${f.name}`);
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
Object.assign(window, { openCreateChannel, openDmPicker, closeModal, openModal, createChannel, toggleSidebar, toggleTheme, startCall, acceptCall, declineCall, endCall, toggleMute, toggleSpeaker, toggleCamera, openChangePasswordModal, submitChangePassword });

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
    // Classic phone ring: two 440+480 Hz dual-tone bursts (~0.4s each
    // with a short gap), then a long silence — roughly the cadence of
    // a desk phone but mellower thanks to soft envelopes and a low
    // master gain. Repeats every 3.2 s.
    const tone = () => {
      const ctx = _ringCtx;
      if (!ctx) return;
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      _ringNodes.push(master);

      // Two bursts per ring.
      for (let i = 0; i < 2; i++) {
        const t0 = now + i * 0.55;
        const dur = 0.42;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(1, t0 + 0.04);
        env.gain.setValueAtTime(1, t0 + dur - 0.08);
        env.gain.linearRampToValueAtTime(0, t0 + dur);
        env.connect(master);
        _ringNodes.push(env);

        for (const f of [440, 480]) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = f;
          osc.connect(env);
          osc.start(t0);
          osc.stop(t0 + dur + 0.02);
          _ringNodes.push(osc);
        }
      }
    };
    tone();
    _ringTimer = setInterval(tone, 3200);
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
