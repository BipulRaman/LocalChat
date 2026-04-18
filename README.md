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
