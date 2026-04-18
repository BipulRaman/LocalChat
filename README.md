# LanChat

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

## For end users (hosting the chat)

1. Download the binary for your OS from [Releases](../../releases).
2. Double-click it.
3. A tray icon appears. Right-click → "Open chat in browser" (or wait —
   it auto-opens the host's browser). The LAN URL is shown in the tray
   tooltip and menu.
4. Share the LAN URL with anyone on the same network. They open it in a
   browser — no install, no account.
5. Quit from the tray when you're done.

Allow it through Windows Firewall the first time (Private network only is
fine). macOS will ask the first time; click "Allow."

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

```bash
cargo run --release                  # run locally; web UI at http://localhost:5000
cargo run --release --no-default-features   # headless (no tray, console banner)
```

Ports are auto-picked. Preferred list: `5000, 5050, 5555, 8080, 8000,
8888, 3000, 4000, 7000, 9000`. If all are busy, the OS assigns any free
port. Override with `PORT=xxxx` env or `--port=xxxx`.

### Layout

```
LanChat/
├─ Cargo.toml
├─ src/
│  ├─ main.rs         # entry: tokio runtime + tray event loop
│  ├─ state.rs        # AppState (users, channels, metrics, config)
│  ├─ config.rs       # Config (loaded from lanchat-config.json)
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
├─ web/               # embedded into the binary via rust-embed
│  ├─ index.html      # chat UI
│  ├─ admin.html      # admin dashboard
│  ├─ app.js          # chat client (vanilla JS)
│  ├─ admin.js        # admin client
│  └─ style.css
└─ .github/workflows/build.yml
```

### Building cross-platform binaries locally

```bash
# Windows (from Windows host)
cargo build --release --features tray

# Linux headless (no tray)
cargo build --release --no-default-features

# macOS Intel / Apple Silicon (from a Mac)
cargo build --release --target x86_64-apple-darwin  --features tray
cargo build --release --target aarch64-apple-darwin --features tray
```

CI (see [`.github/workflows/build.yml`](.github/workflows/build.yml))
builds all 5 targets in parallel on push/PR, and publishes a Release
when you push a `v*` tag:

```bash
git tag v2.0.0 && git push origin v2.0.0
```

## Runtime files

Next to the binary:

```
lanchat(.exe)
lanchat-config.json         # port, admin token, settings, banlist
uploads/                    # shared files
history/                    # append-only JSONL per channel
  pub-general.jsonl
  grp-<id>.jsonl
  dm-<a>-<b>.jsonl
```

Delete `history/` to wipe messages. Delete `uploads/` to wipe files.
Delete `lanchat-config.json` to reset settings and regenerate the admin
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
# LanChat

A production-grade LAN instant messaging system with file transfer.

Ships as a **single self-contained `lanchat.exe`** so a non-technical
user can host a chat server by double-clicking it. Everyone else on the
same Wi-Fi / LAN just opens the printed link in their browser — no
install required.

## Features

- **Single-file `.exe`** — no Node.js, no npm, no install on the host
- **Auto port pick** — prefers memorable ports (5000, 5050, 5555, 8080, …), falls back to any free port
- **Auto-opens** the host's browser to `http://localhost:<port>`
- **Real-time messaging** via WebSockets (Socket.IO)
- **File sharing** with drag & drop, progress, image/video previews
- **User presence**, **typing indicators**, **message history** (last 200)
- **LAN-only** — private by default, no internet required

## For end users (host the chat)

1. Download `lanchat.exe`.
2. Double-click it. A console window opens and prints something like:
   ```
   💻  This computer:   http://localhost:5000
   📡  LAN access:     http://192.168.1.42:5000
   ```
3. Your browser opens automatically. Pick a username and start chatting.
4. Share the **LAN access** link with anyone on the same network.
5. To stop the server, close the console window.

Allow it through Windows Firewall the first time (Private network is enough).

## For developers

```bash
# Install all dependencies (server + client)
npm install

# Run both server and client in development mode
npm run dev
```

Dev client: **http://localhost:3000**, dev server: **http://localhost:5000**.

### Build the standalone executable

```bash
# Windows .exe (run on any OS thanks to pkg cross-compile)
npm run package:win
# → dist/lanchat.exe

# macOS / Linux equivalents
npm run package:mac
npm run package:linux
```

The resulting binary embeds Node.js, the server code, **and** the built
React client. It writes uploaded files to an `uploads/` folder created
next to the executable.

## Production (without packaging)

```bash
npm run build      # build the React client
npm start          # start the server (serves the built client too)
```

## Tech Stack

| Layer    | Technology              |
|----------|------------------------|
| Backend  | Node.js, Express, Socket.IO |
| Frontend | React 18, Vite         |
| Styling  | Custom CSS (no frameworks) |
| Files    | Multer (upload), streaming (download) |

## Project Structure

```
LanChat/
├── server/
│   └── index.js          # Express + Socket.IO server
├── client/
│   ├── src/
│   │   ├── App.jsx       # Main app component
│   │   ├── index.css     # Global styles
│   │   └── components/
│   │       ├── JoinScreen.jsx
│   │       ├── ChatWindow.jsx
│   │       ├── MessageBubble.jsx
│   │       ├── FileUpload.jsx
│   │       └── Sidebar.jsx
│   ├── index.html
│   └── vite.config.js
├── uploads/              # Uploaded files (auto-created)
└── package.json
```

## Configuration

| Variable / flag      | Default                              | Description                                                       |
|----------------------|--------------------------------------|-------------------------------------------------------------------|
| `PORT` env / `--port=N` | auto-pick from 5000, 5050, 5555, 8080, 8000, 8888, 3000, 4000, 7000, 9000 → then any free port | Force a specific port. Fails if it's taken. |
| `NO_BROWSER=1` / `--no-browser` | off (auto-opens when running the .exe) | Don't auto-open the host's browser.                       |

## License

MIT
