# LocalChat — Design & Architecture

> Deep dive into how LocalChat is built. Read this if you want to hack on the
> code, audit the security model, or borrow ideas for your own LAN apps.

---

## 1. Goals & non-goals

**Goals**
- Single ~5 MB binary, no install, no runtime dependencies (no Node, no Python).
- LAN-only by default. Zero outbound traffic. Auditable with Wireshark.
- "Refresh tab → exactly the state I left" durability.
- True end-to-end encryption for 1:1 DMs (server cannot read them).
- Stable identity without accounts.
- Works on any consumer Wi-Fi router; survives sleep/roam/firewall reset.
- Negligible footprint at hundreds of users.

**Non-goals**
- Federation, cross-LAN sync, mobile-native apps (yet).
- Group E2EE — public/private group messages are server-readable by design
  (the host is the trust boundary).
- High availability / replication — one process, one box.

---

## 2. High-level architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (any device on the LAN)                                    │
│                                                                    │
│   index.html ─ app.js ─ Web Crypto (ECDH P-256 + AES-GCM)          │
│        │                                                           │
│        │  WebSocket  (TLS, wss://)                                 │
│        ▼                                                           │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ LocalChat.exe  (single Tokio process, axum + rustls)           │ │
│ │                                                                │ │
│ │  ┌──────────┐ ┌────────┐ ┌────────┐ ┌────────────┐ ┌────────┐  │ │
│ │  │ http.rs  │ │ ws.rs  │ │admin.rs│ │  tray.rs   │ │net.rs  │  │ │
│ │  │ axum     │ │WebSock │ │tok-gate│ │tray-icon   │ │banner  │  │ │
│ │  └────┬─────┘ └───┬────┘ └────┬───┘ └─────┬──────┘ └────────┘  │ │
│ │       │           │            │          │                    │ │
│ │       ▼           ▼            ▼          ▼                    │ │
│ │  ┌──────────────────────────────────────────────────────────┐  │ │
│ │  │              AppState  (Arc, lock-free)                  │  │ │
│ │  │  DashMap<UserId, UserInfo>           (online roster)     │  │ │
│ │  │  DashMap<UserId, UserInfo>           (known users)       │  │ │
│ │  │  DashMap<usernameLower, UserId>      (identity map)      │  │ │
│ │  │  DashMap<UserId, u32>                (socket refcount)   │  │ │
│ │  │  ChannelRegistry (DashMap + per-channel broadcast bus)   │  │ │
│ │  │  HistoryStore   (append-only JSONL per channel)          │  │ │
│ │  │  ReactionLog    (append-only JSONL global)               │  │ │
│ │  │  JsonSnapshot   (atomic users.json + channels.json)      │  │ │
│ │  │  Metrics        (atomic counters)                        │  │ │
│ │  └──────────────────────────────────────────────────────────┘  │ │
│ │                                                                │ │
│ │  Disk: %APPDATA%\LocalChat\ ─ config + users + channels +      │ │
│ │                                history + reactions + uploads   │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

One Tokio runtime. One axum router. One process for HTTP, WS, static assets,
admin API, file uploads, and TLS termination.

---

## 3. Process layout

| File | Responsibility |
|---|---|
| `main.rs` | Tokio runtime; bootstraps `AppState`; spawns the axum server task; runs the tray event loop on the main thread (Windows requires it). |
| `state.rs` | `AppState` — the single `Arc`-wrapped struct passed everywhere. Bootstrap loads config + persisted snapshots, hydrates channels, replays reactions, warms history. |
| `config.rs` | `Config` — JSON-on-disk settings (port, admin token, max upload, history cap, banlist, autostart, allow-LAN-admin). Atomic save via tmp+rename. |
| `user.rs` | `UserInfo`, `UserId` (u32). Includes pubkey, avatar, color, joined_at. |
| `message.rs` | `WireMsg` — the one envelope used for everything (text, file, system, reactions, presence, typing, calls). `MsgKind`, `FileInfo`, `replyTo`. |
| `channel.rs` | `Channel`, `ChannelRegistry`. Per-channel `tokio::broadcast::Sender`. Lobby + groups + DMs. DM ids are FNV-1a 64 of sorted lowercased usernames. |
| `ws.rs` | The WebSocket handler. Owns per-socket subscription tasks, decodes ops, fans messages out via per-channel broadcast buses, persists to history. |
| `http.rs` | axum routes: static assets (rust-embed), `/api/info`, file upload/download streaming, the WS upgrade. TLS via `rustls`. |
| `admin.rs` | `/api/admin/*` — token-gated. Live metrics, ban/kick, broadcast, channel/file delete, settings GET/PATCH. |
| `metrics.rs` | Atomic counters (messages, bytes uploaded, current connections, peak). |
| `persist.rs` | `HistoryStore` (per-channel JSONL append + tail), `ReactionLog` (global JSONL), `JsonSnapshot` (atomic JSON write via tmp+rename). |
| `net.rs` | Port picker (tries `5000, 5050, 5555, 8080, …` then OS-assigned), LAN IP enumerator, console banner. |
| `tray.rs` | `tray-icon` + `muda` integration; menu items: Open chat, Open admin, Quit. |
| `applog.rs` | Tiny in-process log buffer + file writer (`logs/localchat.log`). |
| `web/` | Embedded with `rust-embed`. Vanilla JS, no build step, ships as-is in the binary. |

No background workers, no thread pool tuning — Tokio's default scheduler handles
everything.

---

## 4. Concurrency model

LocalChat uses **shared-nothing-where-possible** plus `DashMap` for the few
genuinely shared maps. There are **no `Mutex<HashMap>`** in hot paths.

### Shared mutable state

| Structure | Why DashMap | Notes |
|---|---|---|
| `users` | Insert/remove on every connect/disconnect; reads on every fan-out. | Sharded by hash → near-zero contention at hundreds of sockets. |
| `known_users` | Same shape, larger superset. Mirrored into `users.json`. | |
| `username_to_id` | Lookup on every join. | Lowercased keys. |
| `connections` | Ref-counted on every socket open/close. | Critical for multi-tab safety. |
| `channels.map` | Read-mostly, occasional create/delete. | |
| `channels.user_channels` | Per-user smallvec of channel IDs. | `SmallVec<[ChannelId; 8]>` keeps the common case stack-allocated. |
| `reactions` | (channel, msgId) → emoji → users. | |

### Per-channel fan-out

Each `Channel` owns a `tokio::sync::broadcast::Sender<Arc<WireMsg>>` with a
buffer of 256. Every WebSocket task subscribes to the channels it cares about
and reads from those receivers. Senders just `tx.send(Arc::clone(&msg))` — O(1)
fan-out regardless of subscriber count, with backpressure absorbed by the ring
buffer.

`Arc<WireMsg>` is the wire message wrapped once and shared across N receivers
without re-encoding.

### Atomic counters

`AtomicU64` for `next_msg_id`, `AtomicU32` for `next_user_id`, `AtomicU16` for
`bound_port`. No locks on the hot path of "send a message".

---

## 5. Identity & sessions

### UserId allocation

- On first join, the server allocates a fresh `UserId` (u32) via
  `state.next_user_id()` and persists `(usernameLower → UserId)` in
  `users.json`.
- On subsequent joins by the same lowercased username, the **same UserId is
  reused** — across page refresh **and** across server restart.

### Username ownership (anti-impersonation)

The browser generates an ECDH P-256 keypair on first visit and stores the
private key in `localStorage` (`localchat-e2ee-kp`). The pubkey travels in the
`{op:"join", pubkey: …}` op.

Server logic, in `ws.rs`, runs **before** allocating a UserId:

```text
if username_to_id has this name AND known_users[id].pubkey is non-empty
   AND supplied pubkey != stored pubkey:
   reject with { ev: "error", code: "username_taken", text: "…" }
```

This means:
- A new browser cannot steal a name once another browser has claimed it.
- Clearing localStorage = losing your name (deliberate — it's the proof of
  ownership). The admin can reset by deleting the `users.json` row.

### Connection ref-counting

Refresh = open new socket *before* the old one closes. Naive cleanup on
`onclose` would briefly mark the user offline and (in the original code) wipe
their channel memberships.

Fix: `state.connections: DashMap<UserId, u32>`. Every `welcome` increments,
every cleanup decrements. Only when the count hits 0 do we:
- Broadcast "X left" presence.
- Remove from `state.users` (online roster).
- Trim from the lobby's `members` set.

We **never** strip `members` from groups or DMs on disconnect — that's
membership, not presence.

---

## 6. Channel model

Three kinds, one struct.

| Kind | ID format | Lifetime | E2EE? |
|---|---|---|---|
| Lobby | `pub:general` | Recreated on every boot | No |
| Group | `grp:<12-hex>` | Persisted in `channels.json` | No |
| DM | `dm:<16-hex>` (FNV-1a 64 of sorted lowercased usernames) | Persisted | **Yes** (text field) |

### DM id derivation

```rust
pub fn dm_id_for_names(a: &str, b: &str) -> ChannelId {
    let (mut x, mut y) = (a.to_lowercase(), b.to_lowercase());
    if x > y { std::mem::swap(&mut x, &mut y); }
    // FNV-1a 64 over "x|y"
    let mut h: u64 = 0xcbf29ce484222325;
    for byte in x.bytes().chain(b"|".iter().copied()).chain(y.bytes()) {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("dm:{:016x}", h).to_compact_string()
}
```

DM ids are **derived from usernames, not UserIds**, so they survive the
ephemeral nature of UserIds. (Today UserIds are stable, but historically they
weren't — and renames will revisit this.)

### Membership operations

| Op | Effect | Persisted? |
|---|---|---|
| `ch_create` | Insert channel, add creator to `members`. | Yes |
| `ch_join` | Public group only. Add caller to `members`. | Yes |
| `ch_leave` | Remove from `members`. Last-member-leaves does **not** auto-delete (yet). | Yes |
| `ch_invite` | Member invites others. Per-invitee push of `__ch_invited` (control message). | Yes |
| `ch_delete` | Creator only. Detach all members, drop channel + history. | Yes |
| `dm_open` | Open-or-reuse a DM with a target user. | Yes |
| `dm_delete` | Drop DM channel + history file. | Yes |

Every mutation calls `state.save_channels().await` to atomically rewrite
`channels.json`.

---

## 7. Message flow

```
client ──[op:"send"]─► ws.rs
                         │
                         ├─ assign next_msg_id (atomic)
                         ├─ build WireMsg (Arc'd)
                         ├─ channel.tx.send(msg)        ── broadcast bus
                         ├─ channel.push_history(msg)   ── in-RAM ring (cap N)
                         └─ history.append(msg).await   ── disk JSONL append
                                  │
                                  └─ (rotates at rotate_mb MB)

every subscribed ws task ───► serialize WireMsg ───► socket.send(json)
```

- Message IDs are monotonic u64. Allocated by `AtomicU64::fetch_add(1)`.
- Reply IDs (`replyTo`) are just the parent's `id`. Server doesn't dereference;
  client renders the quote by looking up the parent in its in-memory list.
- File messages are sent as a separate op (`op:"file"`) **after** the upload
  completes via HTTP POST — see §10.

### Synthetic events on the same bus

Presence, typing, reactions, read receipts, call signaling, channel-deleted,
DM-deleted, and channel-invited events all ride the per-channel broadcast bus
as `WireMsg` with sentinel usernames. The client filters them in `app.js`:

| Sentinel | Semantics |
|---|---|
| `__presence` | `{type: "join"\|"leave", userId}` in the text field |
| `__typing` | `{userId, typing: bool}` |
| `__react` | `{msgId, emoji, userId, on}` |
| `__read` | `{userId, msgId}` |
| `__call` | WebRTC SDP/ICE blobs for DM call signaling |
| `__ch_deleted` / `__dm_deleted` | Notify subscribers to drop the channel |
| `__ch_invited` | Per-invitee control: subscribe + render |

This keeps the wire schema and fan-out logic uniform — there is exactly **one**
event type on the bus.

---

## 8. Persistence model

Everything lives under `%APPDATA%\LocalChat\` (overridable via
`LOCALCHAT_HOME`):

```
LocalChat/
├─ config.json          # settings, banlist, admin token
├─ users.json           # { next_id, users: [UserInfo] }   (atomic snapshot)
├─ channels.json        # [ChannelMeta]                    (atomic snapshot)
├─ reactions.jsonl      # append-only per-event log
├─ uploads/             # raw uploaded blobs (sha-prefixed names)
└─ history/
   ├─ pub-general.jsonl
   ├─ grp-<id>.jsonl
   └─ dm-<16hex>.jsonl  # ciphertext (e2e:v1:…) for DMs
```

### `JsonSnapshot` (atomic JSON files)

```rust
pub async fn save<T: Serialize>(&self, value: &T) {
    let _g = self.write_lock.lock().await;        // serialize writers
    let tmp = self.path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?).await?;
    fs::rename(&tmp, &self.path).await?;          // atomic on Windows + POSIX
}
```

No partial files even if the host loses power mid-write.

### `HistoryStore` (per-channel JSONL)

- One line = one `WireMsg` JSON. No framing, no headers.
- Append-only. `tail(channel, limit)` reads the last N lines for warming.
- Rotation: when a file exceeds `rotate_mb` MB, it's renamed to `*.1.jsonl`
  and a fresh file starts.

### `ReactionLog`

Reactions are stored as **events**, not state, because a reaction is
toggle-on / toggle-off. Each line:

```json
{"c":"grp:abcd","m":42,"e":"🎉","u":7,"on":true,"ts":1700000000}
```

On boot, the entire log is replayed into `state.reactions` (a nested DashMap
of `(channel, msgId) → emoji → Vec<UserId>`). Late writes are fine — the
in-RAM map is the source of truth at runtime.

### Bootstrap order

```
1. mkdir app_root + subdirs
2. migrate_legacy_layout    (move pre-v2 files next to exe → app_root)
3. Config::load_or_init     (creates config.json on first run)
4. applog::init             (start logging to logs/localchat.log)
5. ReactionLog::load_all    (parse reactions.jsonl)
6. JsonSnapshot::load users + channels
7. Build AppState           (DashMaps populated from snapshots)
8. ChannelRegistry::hydrate (recreate Channel + members + broadcast bus)
9. Replay reactions into state.reactions
10. Warm history for every channel (read tail(N) into Channel.history)
11. Compute next_msg_id from max id seen + 1
```

After that, the server is ready to bind.

---

## 9. End-to-end encryption (DMs only)

LocalChat uses **per-pair AES-GCM keys derived from ECDH P-256**. Implemented
entirely in the browser using Web Crypto. The server never sees plaintext.

### Keys

- Each browser generates one ECDH P-256 keypair on first visit.
- Private key: `localStorage["localchat-e2ee-kp"]` (JWK).
- Public key: sent in `op:"join"` and stored on the server in `UserInfo.pubkey`
  for distribution to peers.

### Per-pair derivation

For users A and B:
1. A imports B's public key.
2. `sharedSecret = ECDH(privA, pubB)` (256 bits).
3. `aesKey = HKDF-SHA256(sharedSecret, info="localchat-dm-v1")` → AES-256-GCM key.
4. Cache `aesKey` per peerId in memory.

### Wire format

Plaintext message body is encrypted with AES-GCM:

```
ciphertext = AES-GCM(aesKey, iv, plaintext)
sent = "e2e:v1:" + base64(iv || ciphertext)
```

The server stores this as the `text` field verbatim — both in the broadcast and
in `history/dm-<id>.jsonl`. On receive, the client checks for the `e2e:v1:`
prefix and decrypts. If decryption fails (peer changed pubkey, you cleared
localStorage, etc.), the UI shows `🔒 (cannot decrypt — missing key)` instead
of the bytes.

### Caveats (known)

- **No forward secrecy.** A stolen long-term keypair can decrypt all past DMs.
- **No formal key verification UI.** Pubkeys are TOFU. A safety-numbers UI is
  on the roadmap.
- **Group chats are not E2EE.** Public/private group messages are plaintext on
  the wire to the server. Implementing group E2EE would require MLS or Sender
  Keys; not in scope today.

---

## 10. File transfer

```
client                                         server
  │                                              │
  │  POST /api/upload  (multipart, streamed)     │
  ├────────────────────────────────────────────►│
  │                                              ├─ stream to uploads/<sha>
  │                                              ├─ build FileInfo
  │  ◄── 200 { id, filename, size, mime, url } ──┤
  │                                              │
  │  WS  op:"file"  channel + FileInfo           │
  ├────────────────────────────────────────────►│
  │                                              ├─ build WireMsg(kind=File)
  │                                              ├─ broadcast + persist
  │                                              │
  │  ◄────────  ev:"msg" m:{ ... file: {...} } ──┤  (back to all subscribers)
```

- Uploads are streamed (not buffered) so 100 MB files don't blow up memory.
- Filenames on disk are content-addressable to dedupe identical uploads.
- Downloads are served via `GET /api/download/<filename>?name=<original>` with
  `Content-Disposition: attachment` to force the rename. Inline previews use
  `/uploads/<filename>` directly.
- The admin can delete any uploaded file from the dashboard.

---

## 11. Voice & video calls

Pure WebRTC peer-to-peer. The server only **relays signaling**.

- Caller and callee exchange SDP offers/answers and ICE candidates as JSON
  blobs in the body of `__call` messages on the DM channel's broadcast bus.
- Once ICE finishes, the media stream is direct between the two browsers — the
  server sees zero media bytes.
- STUN: not needed on a LAN. Browsers find each other via host candidates.
- TURN: not implemented (cross-LAN is out of scope).
- Codecs negotiated by the browser (typically Opus + VP8/VP9).

---

## 12. Admin surface

- `/admin` is a separate static page (`web/admin.html` + `admin.js`).
- All admin APIs live under `/api/admin/*` and require an
  `Authorization: Bearer <token>` header.
- The token is auto-generated on first run, stored in `config.json`, and
  pre-filled when you launch the dashboard from the tray menu (the URL
  includes `?token=…` for one-click access on `localhost`).
- By default the admin API is bound to **localhost only**. Setting
  `allow_lan_admin = true` opens it to LAN clients (still token-gated).

---

## 13. Network & TLS

- TLS terminated in-process via `rustls` + `tokio-rustls`.
- On first run, `rcgen` generates a self-signed cert for `localhost` plus all
  detected LAN IPs. Browsers will warn (expected). Click through once per
  device.
- `app/scripts/` includes a Lego-based DNS-01 helper for issuing a real
  Let's Encrypt cert against a public DNS name pointed at your LAN IP.
- Port selection: tries the preferred list `5000, 5050, 5555, 8080, 8000,
  8888, 3000, 4000, 7000, 9000` (most users have at least one free), then
  falls back to OS-assigned. Override with `PORT=xxxx` env or `--port=xxxx`.

---

## 14. Wire protocol (full spec)

### Client → server (op)

```jsonc
// session
{ "op": "join",     "username": "alice", "avatar": "A", "color": "#6366f1", "pubkey": "<jwk-b64>" }
{ "op": "ping" }

// messaging
{ "op": "send",     "channel": "pub:general", "text": "hi", "replyTo": 123 }
{ "op": "file",     "channel": "pub:general", "file": { /* FileInfo */ }, "text": "caption" }
{ "op": "react",    "channel": "...", "msgId": 42, "emoji": "🎉", "on": true }
{ "op": "typing",   "channel": "pub:general", "typing": true }
{ "op": "read",     "channel": "...", "msgId": 99 }

// channels
{ "op": "ch_create","name": "dev-team", "private": false }
{ "op": "ch_join",  "channel": "grp:abcd" }
{ "op": "ch_leave", "channel": "grp:abcd" }
{ "op": "ch_invite","channel": "grp:abcd", "users": [7, 12] }
{ "op": "ch_delete","channel": "grp:abcd" }

// dm
{ "op": "dm_open",  "user": 42 }
{ "op": "dm_delete","channel": "dm:..." }

// history
{ "op": "history",  "channel": "pub:general", "limit": 50 }

// calls
{ "op": "call",     "channel": "dm:...", "kind": "offer"|"answer"|"ice"|"end", "data": {...} }
```

### Server → client (ev)

```jsonc
{ "ev": "welcome",     "user": {...}, "channels": [...], "users": [...], "lobby": "pub:general" }
{ "ev": "msg",         "m": { /* WireMsg */ } }
{ "ev": "history",     "channel": "...", "messages": [ /* WireMsg[] */ ] }
{ "ev": "ch_created",  "channel": { /* meta */ } }
{ "ev": "ch_invited",  "channel": "grp:...", "channelName": "leadership", "inviter": "Bipul" }
{ "ev": "error",       "text": "...", "code": "username_taken" }
{ "ev": "pong" }
```

`WireMsg` schema (`message.rs`):

```jsonc
{
  "id": 12345,                         // monotonic u64
  "channel": "pub:general",
  "kind": "text" | "file" | "system",
  "userId": 7,
  "username": "alice",                 // also: "__presence" | "__typing" | "__react" | "__read" | "__call" | "__ch_deleted" | "__dm_deleted" | "__ch_invited"
  "avatar": "A",
  "color": "#6366f1",
  "ts": 1700000000,
  "text": "...",                       // for DMs: "e2e:v1:<base64>"
  "file": { "id":"...", "originalName":"...", "filename":"...", "size":1234, "mimeType":"...", "url":"/uploads/..." },
  "replyTo": 12340,                    // optional parent msg id
  "edited_at": 1700000050,             // optional
  "deleted": false                     // optional
}
```

---

## 15. Performance characteristics

Measured on a Ryzen 5 5600X, 16 GB RAM, Windows 11, release build:

| Metric | Value |
|---|---|
| Cold start to "ready to accept" | ~80 ms |
| Memory (200 users, 50 channels, 50 K cached msgs) | ~5 MB RSS |
| Single-channel fan-out throughput (in-process) | > 1 M msgs/s |
| WS message latency (LAN, sender → receiver) | < 5 ms p99 |
| File upload (1 GB) | line-rate (NIC limited) |

Bottlenecks expected: TLS handshake CPU at hundreds of cold reconnects (rustls
does ~5k handshakes/s on this box, so we'd need thousands of users hammering
reconnect to feel it).

---

## 16. Security model

**In scope**
- Network sniffing: defeated by TLS.
- Admin spoofing: defeated by token + localhost-only default.
- Username impersonation: defeated by pubkey ownership check.
- DM eavesdropping by the host: defeated by E2EE.

**Out of scope (today)**
- A malicious host modifying the binary (you're running their code).
- Group chat E2EE.
- Forward secrecy for DMs (no double-ratchet, no key rotation).
- File E2EE (uploaded blobs are server-readable).
- Web client supply-chain (everything is bundled into the binary, but a
  modified binary can serve modified JS).

**Threat model assumption**: the host running `LocalChat.exe` is trusted by all
participants. If you don't trust the host, don't connect.

---

## 17. Build & release

- Single Rust crate under `app/`. ~6 k LoC, ~30 dependencies.
- `cargo build --release --features tray` → `target/release/localchat.exe`.
- The web UI is embedded via `rust-embed` at compile time — no runtime asset
  resolution, no separate static directory to ship.
- CI (`.github/workflows/build.yml`) builds Windows x64 on every push and
  publishes a GitHub Release whenever a `v*` tag is pushed.
- Static linking (`+crt-static`) keeps the binary portable across Windows
  versions without VC++ runtime installs.

---

## 18. Where to look in the code

| You want to… | Read this |
|---|---|
| Understand the bootstrap sequence | `state.rs::AppState::bootstrap` |
| Add a new client→server op | `ws.rs` — match arm in the recv loop |
| Add a new client-side event | `app.js::handleEvent` |
| Change persistence format | `persist.rs` |
| Change DM id derivation | `channel.rs::dm_id_for_names` |
| Touch the admin UI | `web/admin.html` + `web/admin.js` + `admin.rs` |
| Tune fan-out buffer | `channel.rs::Channel::new` (`broadcast::channel(256)`) |
| Tune history rotation | `config.json` → `rotate_mb`, `history_ram` |

---

## 19. Future work

- **Search**: full-text index over history (likely `tantivy`, lazily built).
- **Mobile-native client**: separate repo; reuse the wire protocol.
- **Group voice/video**: mesh first, SFU later if it ever leaves the LAN.
- **Forward-secret DMs**: double-ratchet (Signal protocol) or MLS.
- **Edit / delete / pin messages**: schema is already there (`edited_at`,
  `deleted`); UI is not.
- **Per-channel notification preferences**: trivial client work, no protocol
  change.
- **macOS & Linux tray**: `tray-icon` already supports both; needs CI matrices
  and platform-specific autostart helpers.

---

*Document last updated: 2026-04-19.*
