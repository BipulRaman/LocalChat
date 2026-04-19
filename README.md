<div align="center">

# LocalChat

**A private, zero-install team chat that runs on your own Wi-Fi.**

One ~5 MB binary. No accounts. No cloud. No telemetry.
Double-click. Share the LAN URL. Done.

[![Build](../../actions/workflows/build.yml/badge.svg)](../../actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Bipulkr/LocalChat?label=download)](../../releases/latest)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-informational)

<table>
  <tr>
    <td align="center"><img src="LocalChat.png" alt="Chat UI" width="100%"/><br/><sub><b>Chat UI</b> — channels, DMs, replies, reactions</sub></td>
    <td align="center"><img src="LocalChatAdmin.png" alt="Admin dashboard" width="100%"/><br/><sub><b>Admin dashboard</b> — metrics, users, channels, settings</sub></td>
  </tr>
</table>

</div>

---

## Why LocalChat?

Slack and Teams need internet, accounts, and SaaS pricing. IRC needs a server
admin and config files. Discord owns your data.

LocalChat is the missing **fourth option** for offices, classrooms, hackathons,
homelabs, secure facilities, factory floors, ships, planes, and anywhere else
people share a network but not necessarily the internet:

- **One binary, no install.** Drop `LocalChat.exe` on a desktop. Double-click.
  That's the whole setup.
- **Air-gapped friendly.** Zero outbound traffic. Works on a router with no WAN.
- **No accounts.** Pick a name, you're in. Identity is bound to a per-browser
  E2EE keypair so usernames can't be impersonated.
- **End-to-end encrypted DMs.** ECDH P-256 + AES-GCM in the browser. The host
  process literally cannot read direct messages.
- **Persistent.** Channels, members, message history, reactions and uploads
  survive restarts. Refresh the tab — everything is exactly where you left it.
- **Tiny.** ~5 MB on disk, ~5 MB RSS at 200 users / 50 channels.

## Feature tour

| | |
|---|---|
| 💬 **Channels** | Public, private, lobby. Create, rename, invite, join, leave. |
| 🔐 **1:1 DMs** | True end-to-end encryption. Server stores ciphertext only. |
| 📞 **Voice & video calls** | WebRTC peer-to-peer. The server only relays signaling. |
| 📎 **File sharing** | Drag & drop, image previews, lightbox, streaming uploads. |
| ↩️ **Replies & reactions** | Quote any message. React with any emoji. |
| 👋 **Mentions, typing, presence, read receipts** | All the modern niceties. |
| 🛡️ **Admin dashboard** | Live metrics, user kick/ban, broadcast, file & channel cleanup, settings. |
| 🌗 **Light & dark themes** | Polished UI, mobile-friendly, on-screen keyboard aware. |
| 🔁 **Auto-reconnect** | Survives sleep, Wi-Fi roams, brief network blips. |
| 🚫 **No telemetry** | Not a single outbound request. Verify with Wireshark. |

## 60-second quick start

1. Download `LocalChat.exe` from the [latest release](../../releases/latest).
2. Double-click. A tray icon appears; the host's browser opens automatically.
3. Allow it through Windows Firewall (Private network is enough).
4. Read the LAN URL from the tray tooltip — e.g. `https://192.168.1.42:5000` —
   and share it with anyone on the same Wi-Fi.
5. They open the URL, pick a name, and start chatting. No install, no signup.

> 💡 The first visit shows a browser warning because the cert is self-signed.
> Click **Advanced → Proceed**. To get rid of it permanently, see
> [`app/scripts/`](app/scripts/) for issuing a real Let's Encrypt cert via
> DNS-01 (works for LAN-only hosts).

### Admin dashboard

![Admin dashboard](LocalChatAdmin.png)

Tray → **Open admin dashboard** opens `http://localhost:<port>/admin` with the
auto-generated admin token pre-filled. From there:

- See live metrics (users, messages, uploads, uptime).
- Kick or ban users (by username + IP).
- Broadcast announcements to `#general`.
- View and delete channels and uploaded files.
- Change settings (port, max upload, history cap, autostart on boot,
  allow LAN admin access).

The admin API is **localhost-only by default** and gated by a per-install token.

## Where your data lives

Everything sits in `%APPDATA%\LocalChat\` (or `$XDG_DATA_HOME/LocalChat`):

```
LocalChat/
├─ LocalChat-config.json   # port, admin token, settings, banlist
├─ users.json              # username ↔ stable UserId, pubkeys
├─ channels.json           # channel metadata + memberships
├─ reactions.jsonl         # append-only reaction log
├─ uploads/                # shared files (originals)
└─ history/
   ├─ pub-general.jsonl
   ├─ grp-<id>.jsonl
   └─ dm-<id>.jsonl        # ciphertext only, never readable by the host
```

Want a clean slate? Stop the app, delete the folder, restart. To wipe just one
thing, delete the matching file or folder.

Override the location with `LOCALCHAT_HOME=D:\path\to\folder`.

## Built for developers too

All source lives under [`app/`](app/). One Rust crate, ~6 k LoC, ~30 dependencies.

```bash
cd app
cargo run --release                          # tray + browser auto-open
cargo run --release --no-default-features    # headless (CI / servers)
PORT=4000 cargo run --release                # pin a port
LOCALCHAT_HOME=./scratch cargo run --release # ephemeral data dir
```

Ports are auto-picked from `5000, 5050, 5555, 8080, 8000, 8888, 3000, 4000,
7000, 9000`. If they're all busy, the OS hands out any free one.

### Stack

- **axum 0.7** + **tokio** — async HTTP/WS server.
- **DashMap** + `tokio::broadcast` — lock-free fan-out to subscribers.
- **rust-embed** — the entire web UI is baked into the binary.
- **rustls** — TLS terminated in-process; no nginx, no Caddy.
- **rcgen** — self-signed certs on first run; replace via `app/scripts/`.
- **tray-icon** + **muda** — native Windows tray menu, no console window.
- **Vanilla JS + Web Crypto** — no client framework, no build step.

### Layout

```
LocalChat/
├─ README.md
├─ LICENSE
├─ .github/workflows/build.yml   # CI (Windows x64)
└─ app/
   ├─ Cargo.toml
   ├─ src/
   │  ├─ main.rs        # entry: tokio runtime + tray event loop
   │  ├─ state.rs       # AppState (users, channels, metrics, persisted snapshots)
   │  ├─ config.rs      # Config (loaded from LocalChat-config.json)
   │  ├─ user.rs        # UserInfo, stable UserId, pubkey-gated identity
   │  ├─ message.rs     # WireMsg, MsgKind, FileInfo, replyTo
   │  ├─ channel.rs     # Channel (group / DM / lobby), members, broadcast bus
   │  ├─ ws.rs          # WebSocket handler (op/ev protocol, ref-counted sockets)
   │  ├─ http.rs        # axum routes + embedded asset server
   │  ├─ admin.rs       # /api/admin/* — token-gated
   │  ├─ metrics.rs     # lock-free atomic counters
   │  ├─ persist.rs     # atomic JSON snapshots + append-only JSONL
   │  ├─ applog.rs      # lightweight in-process log buffer
   │  ├─ net.rs         # port picker + LAN IP enumeration + console banner
   │  └─ tray.rs        # tray icon + menu + event loop
   ├─ web/              # embedded into the binary via rust-embed
   │  ├─ index.html
   │  ├─ admin.html
   │  ├─ app.js         # chat client + E2EE
   │  ├─ admin.js
   │  └─ style.css
   └─ scripts/          # optional: TLS cert issue/renew, autostart, run helpers
```

### Building a release

```bash
cd app
cargo build --release --features tray
# → app/target/release/localchat.exe (~5 MB, statically linked)
```

CI builds and publishes a single `LocalChat.exe` when you push a tag:

```bash
git tag v2.0.0 && git push origin v2.0.0
```

## Wire protocol (WebSocket, JSON text frames)

### Client → server

```jsonc
{ "op": "join",      "username": "alice", "avatar": "A", "color": "#6366f1", "pubkey": "..." }
{ "op": "send",      "channel": "pub:general", "text": "hi", "replyTo": 123 }
{ "op": "file",      "channel": "pub:general", "file": { /* FileInfo */ }, "text": "caption" }
{ "op": "react",     "channel": "...", "msgId": 42, "emoji": "🎉" }
{ "op": "typing",    "channel": "pub:general", "typing": true }
{ "op": "ch_create", "name": "dev-team", "private": false }
{ "op": "ch_join",   "channel": "grp:abcd" }
{ "op": "ch_leave",  "channel": "grp:abcd" }
{ "op": "ch_invite", "channel": "grp:abcd", "users": [7, 12] }
{ "op": "ch_delete", "channel": "grp:abcd" }
{ "op": "dm_open",   "user": 42 }
{ "op": "dm_delete", "channel": "dm:..." }
{ "op": "history",   "channel": "pub:general", "limit": 50 }
{ "op": "ping" }
```

### Server → client

```jsonc
{ "ev": "welcome",    "user": { /* me */ }, "channels": [ /* meta[] */ ], "users": [ /* roster */ ], "lobby": "pub:general" }
{ "ev": "msg",        "m": { /* WireMsg */ } }
{ "ev": "history",    "channel": "...", "messages": [ /* WireMsg[] */ ] }
{ "ev": "ch_created", "channel": { /* meta */ } }
{ "ev": "ch_invited", "channel": "grp:...", "channelName": "leadership", "inviter": "Bipul" }
{ "ev": "error",      "text": "...", "code": "username_taken" }
{ "ev": "pong" }
```

Presence, typing, reactions, read receipts, call signaling, and channel-deleted
events ride as synthetic messages on a channel with username sentinels
(`__presence`, `__typing`, `__react`, `__read`, `__call`, `__ch_deleted`,
`__dm_deleted`, `__ch_invited`) so every subscriber receives them through the
same broadcast bus as regular messages.

## Security model in one minute

- **Transport**: TLS terminated in-process by `rustls` with a self-signed cert
  on first run. Replace via [`app/scripts/`](app/scripts/) for a public-CA cert.
- **DM E2EE**: Each browser generates an ECDH P-256 keypair on first visit and
  keeps the private key in `localStorage`. Senders derive a per-pair AES-GCM key
  (HKDF over the shared secret), encrypt the body, and send `e2e:v1:<b64>`. The
  server stores it verbatim and has no way to decrypt.
- **Identity**: Usernames map to stable `UserId`s on disk. Re-using a name is
  rejected unless your browser presents the original pubkey, so impersonation is
  blocked even after the original user disconnects.
- **Admin**: Token-gated. Localhost-only by default. The token is auto-generated
  on first run and pre-filled when you launch from the tray.
- **Network**: LAN-only by intent. No outbound calls, no analytics, no auto-update.

## Roadmap (community PRs welcome)

- [ ] macOS & Linux tray builds
- [ ] Mobile-native client (LAN-only, serverless)
- [ ] Group voice/video rooms (mesh, no SFU)
- [ ] Slash commands & bots
- [ ] Per-channel notification preferences
- [ ] Searchable history

## License

[MIT](LICENSE) — do anything you want; attribution appreciated.

---

<div align="center">

Built with Rust 🦀 because boring infrastructure should be fast and tiny.

</div>
# LocalChat

A self-contained LAN instant messenger. One native binary. No installer.
No Node.js. No Python. No config. Double-click to run; share the printed
LAN URL with anyone on the same Wi-Fi.

- **~5 MB** native binary (Rust + embedded web UI)
- **Tray icon** on the host — no console window, right-click for menu
- **Channels** (public, private) + **1:1 direct messages** + lobby
- **File sharing** (drag-and-drop, image previews, streaming uploads)
- **Admin dashboard** at `/admin` — users, channels, uploads, settings
- **Memory negligible** (~5 MB RSS at 200 users / 50 channels)
- **Private by default** — LAN only, no internet, no accounts, no telemetry

## Screenshots

![LocalChat](LocalChat.png)

## For end users (hosting the chat)

1. Download `LocalChat.exe` from [Releases](../../releases).
2. Double-click it.
3. A tray icon appears. Right-click → "Open chat in browser" (or wait —
   it auto-opens the host's browser). The LAN URL is shown in the tray
   tooltip and menu.
4. Share the LAN URL with anyone on the same network. They open it in a
   browser — no install, no account.
5. Quit from the tray when you're done.

Allow it through Windows Firewall the first time (Private network only is
fine).

### Admin dashboard

Tray → "Open admin dashboard" opens `http://localhost:<port>/admin` with
the auto-generated admin token pre-filled. From there you can:

- See live metrics (users, messages, uploads, uptime)
- Kick or ban users (by username + IP)
- Broadcast an announcement to `#general`
- View & delete channels and uploaded files
- Change settings (port, max upload, history cap, autostart on boot,
  allow LAN admin access)

The admin API is **localhost-only by default**. Enable "Allow LAN admin
access" in Settings to access it from other devices (still token-gated).

## For developers

All source lives under [`app/`](app/). Run from the repo root:

```bash
cd app
cargo run --release                         # run locally; web UI at https://localhost:<port>
cargo run --release --no-default-features   # headless (no tray, console banner)
```

Ports are auto-picked. Preferred list: `5000, 5050, 5555, 8080, 8000,
8888, 3000, 4000, 7000, 9000`. If all are busy, the OS assigns any free
port. Override with `PORT=xxxx` env or `--port=xxxx`.

### Layout

```
LocalChat/
├─ README.md
├─ .github/workflows/build.yml   # CI (Windows x64/x86/arm64)
└─ app/                          # all application code
   ├─ .gitignore
   ├─ Cargo.toml
   ├─ Cargo.lock
   ├─ src/
   │  ├─ main.rs         # entry: tokio runtime + tray event loop
   │  ├─ state.rs        # AppState (users, channels, metrics, config)
   │  ├─ config.rs       # Config (loaded from LocalChat-config.json)
   │  ├─ user.rs         # UserInfo
   │  ├─ message.rs      # WireMsg, MsgKind, FileInfo
   │  ├─ channel.rs      # Channel, DM/group/lobby, broadcast bus
   │  ├─ ws.rs           # WebSocket handler (op/ev protocol)
   │  ├─ http.rs         # axum routes + embedded asset server
   │  ├─ admin.rs        # /api/admin/* — token-gated
   │  ├─ metrics.rs      # lock-free atomic counters
   │  ├─ persist.rs      # append-only JSONL per channel
   │  ├─ net.rs          # port picker + LAN IP enum + banner
   │  └─ tray.rs         # tray-icon + menu + event loop
   ├─ web/              # embedded into the binary via rust-embed
   │  ├─ index.html      # chat UI
   │  ├─ admin.html      # admin dashboard
   │  ├─ app.js          # chat client (vanilla JS)
   │  ├─ admin.js        # admin client
   │  └─ style.css
   └─ scripts/          # optional: TLS cert issue/renew, autostart
```

### Building the Windows binary locally

From the `app/` folder:

```bash
cargo build --release --features tray
# → app/target/release/localchat.exe
```

CI (see [.github/workflows/build.yml](.github/workflows/build.yml))
builds a single `LocalChat.exe` (Windows x64) and publishes a Release
when you push a `v*` tag:

```bash
git tag v2.0.0 && git push origin v2.0.0
```

## Runtime files

Next to the binary:

```
LocalChat(.exe)
LocalChat-config.json         # port, admin token, settings, banlist
uploads/                    # shared files
history/                    # append-only JSONL per channel
  pub-general.jsonl
  grp-<id>.jsonl
  dm-<a>-<b>.jsonl
```

Delete `history/` to wipe messages. Delete `uploads/` to wipe files.
Delete `LocalChat-config.json` to reset settings and regenerate the admin
token on next start.

## Wire protocol (WebSocket, text frames, JSON)

### Client → server

```json
{"op":"join",      "username":"alice", "avatar":"A", "color":"#6366f1"}
{"op":"send",      "channel":"pub:general", "text":"hi",  "replyTo": 123}
{"op":"file",      "channel":"pub:general", "file":{...}, "text":"caption"}
{"op":"typing",    "channel":"pub:general", "typing": true}
{"op":"ch_create", "name":"dev-team", "private": false}
{"op":"ch_join",   "channel":"grp:abcd"}
{"op":"ch_leave",  "channel":"grp:abcd"}
{"op":"ch_invite", "channel":"grp:abcd", "users":[7, 12]}
{"op":"dm_open",   "user": 42}
{"op":"history",   "channel":"pub:general", "limit": 50}
{"op":"ping"}
```

### Server → client

```json
{"ev":"welcome", "user":{...}, "channels":[...], "users":[...], "lobby":"pub:general"}
{"ev":"msg",       "m":{...}}
{"ev":"history",   "channel":"...", "messages":[...]}
{"ev":"ch_created","channel":{...}}
{"ev":"error",     "text":"..."}
{"ev":"pong"}
```

Presence and typing events are emitted as synthetic messages on the
channel with username sentinels `__presence` and `__typing` so every
subscriber receives them via the same broadcast channel.

## License

MIT
