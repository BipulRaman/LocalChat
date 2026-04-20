//! Central shared state. Wrapped in `Arc<AppState>` and handed everywhere.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use compact_str::ToCompactString;
use dashmap::DashMap;

use crate::channel::{ChannelKind, ChannelRegistry, LOBBY_ID, LOBBY_NAME};
use crate::config::Config;
use crate::db::Db;
use crate::message::ChannelId;
use crate::metrics::Metrics;
use crate::user::{UserId, UserInfo};

pub type ReactionKey = (ChannelId, u64);
pub type EmojiKey = compact_str::CompactString;

/// Live state for an in-progress call. Created when an `offer` is
/// relayed, mutated when the callee `answer`s, and consumed when an
/// `end`/`decline`/`busy` arrives — at which point a system message
/// summarizing the outcome is posted into the DM channel.
#[derive(Debug, Clone)]
#[allow(dead_code)] // callee_name + started_at populated for diagnostics / future audit
pub struct CallSession {
    pub caller_id: UserId,
    pub caller_name: compact_str::CompactString,
    pub callee_id: UserId,
    pub callee_name: compact_str::CompactString,
    pub video: bool,
    pub started_at: u64,
    pub answered_at: Option<u64>,
}

pub struct AppState {
    pub app_root: PathBuf,
    pub uploads_dir: PathBuf,
    pub config_path: PathBuf,
    pub logs_dir: PathBuf,

    pub config: RwLock<Config>,
    pub channels: ChannelRegistry,

    pub users: DashMap<UserId, UserInfo>,
    pub known_users: DashMap<UserId, UserInfo>,
    pub username_to_id: DashMap<compact_str::CompactString, UserId>,
    pub connections: DashMap<UserId, u32>,

    pub metrics: Metrics,

    pub reactions: DashMap<ReactionKey, DashMap<EmojiKey, Vec<UserId>>>,

    /// In-flight calls keyed by DM channel id. Pure runtime state —
    /// not persisted; on restart any in-progress calls are forgotten.
    pub calls: DashMap<ChannelId, CallSession>,

    pub db: Db,

    /// Stable per-database UUID stamped at first DB creation. Returned
    /// in `/api/info` so the browser client can namespace localStorage
    /// per-server (different DB ⇒ different bucket ⇒ no stale settings).
    pub server_id: String,

    /// Per-WS session tokens → user_id. Issued in the WS join op so
    /// HTTP endpoints (uploads) can identify the user without a
    /// separate cookie-based auth layer. Tokens live as long as the
    /// WS connection that created them.
    pub sessions: DashMap<compact_str::CompactString, UserId>,

    pub next_msg_id: AtomicU64,

    pub bound_port: AtomicU16,

    pub kick_tx: tokio::sync::broadcast::Sender<KickSignal>,

    /// Set true while a factory/users reset is in progress so that
    /// the cleanup() path of kicked WS sockets skips writing fresh
    /// `disconnect` rows (and other per-user persistence) that would
    /// otherwise survive the DB flush as ghost audit entries.
    pub resetting: AtomicBool,
}

#[derive(Debug, Clone)]
pub enum KickSignal {
    All,
    User(UserId),
}

impl AppState {
    pub async fn bootstrap() -> std::io::Result<Arc<Self>> {
        let app_root = resolve_app_root();
        let uploads_dir = app_root.join("uploads");
        let logs_dir    = app_root.join("logs");
        let config_path = app_root.join("config.json");

        // Probe for writability BEFORE touching SQLite / TLS / config.
        // If Windows Defender "Controlled Folder Access" or ordinary
        // NTFS ACLs block writes here, every later operation would
        // silently fail — so we fail loudly right now with a copy-
        // pasteable remediation command.
        if let Err(e) = verify_writable(&app_root) {
            eprintln!();
            eprintln!("  ❌  LocalChat cannot write to its data folder:");
            eprintln!("        {}", app_root.display());
            eprintln!("        error: {e}");
            eprintln!();
            eprintln!("  Likely cause: Windows Defender 'Controlled Folder");
            eprintln!("  Access' (ransomware protection) is blocking this exe.");
            eprintln!();
            eprintln!("  Fix (run PowerShell as Administrator):");
            if let Ok(exe) = std::env::current_exe() {
                eprintln!("    Add-MpPreference -ControlledFolderAccessAllowedApplications '{}'", exe.display());
            }
            eprintln!();
            eprintln!("  Or pick a different folder by deleting the app config");
            eprintln!("  (%APPDATA%\\LocalChat\\config.json on Windows, or");
            eprintln!("  ~/.config/localchat/config.json elsewhere) and restarting,");
            eprintln!("  or set the LOCALCHAT_HOME environment variable.");
            eprintln!();
            return Err(e);
        }

        let _ = std::fs::create_dir_all(&uploads_dir);
        let _ = std::fs::create_dir_all(&logs_dir);

        let mut config = Config::load_or_init(&config_path)?;
        let history_cap = config.history_ram;

        crate::applog::init(&logs_dir);
        crate::applog::log(format_args!("bootstrap: app_root={}", app_root.display()));

        let (db, server_id) = Db::open(&app_root)
            .await
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        crate::applog::log(format_args!("bootstrap: db ready at {} (server_id={})", db.path.display(), server_id));

        let known: Vec<UserInfo> = db.list_users().await.unwrap_or_default();
        let username_to_id: DashMap<compact_str::CompactString, UserId> = DashMap::new();
        let known_users: DashMap<UserId, UserInfo> = DashMap::new();
        for u in &known {
            username_to_id.insert(u.username.to_lowercase().to_compact_string(), u.id.clone());
            known_users.insert(u.id.clone(), u.clone());
        }

        let channels = ChannelRegistry::new(history_cap);
        let prior_channels = db.list_channels().await.unwrap_or_default();
        channels.hydrate(prior_channels);
        if !channels.map.contains_key(LOBBY_ID) {
            let lobby = crate::channel::Channel::new(
                compact_str::CompactString::const_new(LOBBY_ID),
                ChannelKind::Lobby,
                compact_str::CompactString::const_new(LOBBY_NAME),
                false,
                compact_str::CompactString::const_new(""),
                channels.history_cap,
            );
            channels.map.insert(lobby.id.clone(), Arc::new(lobby));
        }
        if let Some(lobby) = channels.get(LOBBY_ID) {
            let _ = db.upsert_channel(&lobby.meta()).await;
        }

        let reactions: DashMap<ReactionKey, DashMap<EmojiKey, Vec<UserId>>> = DashMap::new();
        for r in db.all_reactions().await.unwrap_or_default() {
            let key = (r.channel_id.clone(), r.message_id);
            let entry = reactions.entry(key).or_default();
            entry.entry(r.emoji).or_default().push(r.user_id);
        }

        let max_msg = db.max_message_id().await.unwrap_or(0);
        let next_msg = max_msg.saturating_add(1).max(1);

        for entry in channels.map.iter() {
            let ch = entry.value();
            let tail = db.tail_messages(&ch.id, channels.history_cap)
                .await
                .unwrap_or_default();
            let mut ring = ch.history.write().await;
            for m in tail {
                ring.push_back(Arc::new(m));
            }
        }

        if let Ok((users, ips)) = db.list_bans().await {
            config.banned_users = users;
            config.banned_ips = ips;
        }

        Ok(Arc::new(Self {
            app_root,
            uploads_dir,
            config_path,
            logs_dir,
            config: RwLock::new(config),
            channels,
            users: DashMap::new(),
            known_users,
            username_to_id,
            connections: DashMap::new(),
            metrics: Metrics::default(),
            reactions,
            calls: DashMap::new(),
            db,
            server_id,
            sessions: DashMap::new(),
            next_msg_id: AtomicU64::new(next_msg),
            bound_port: AtomicU16::new(0),
            kick_tx: tokio::sync::broadcast::channel(16).0,
            resetting: AtomicBool::new(false),
        }))
    }

    pub fn next_msg_id(&self) -> u64 {
        self.next_msg_id.fetch_add(1, Ordering::Relaxed)
    }

    #[allow(dead_code)] // helper used by future admin endpoints
    pub async fn save_channel(&self, channel_id: &str) {
        if let Some(ch) = self.channels.get(channel_id) {
            let _ = self.db.upsert_channel(&ch.meta()).await;
        }
    }
}

fn resolve_app_root() -> PathBuf {
    // 1. Explicit override (used by installers, tests, renames).
    if let Ok(p) = std::env::var("LOCALCHAT_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }

    // 2. App config in the OS-standard per-user location
    //    (`%APPDATA%\LocalChat\config.json` on Windows,
    //    `~/.config/localchat/config.json` on Unix). This survives
    //    moving / replacing / re-installing the exe — the data folder
    //    is remembered system-wide, not per-binary.
    if let Some(dir) = read_app_config_data_dir() {
        return dir;
    }

    // 3. No config yet — first-run setup via the user's web browser.
    //    Spins up a tiny localhost HTTP server on an ephemeral port,
    //    opens the default browser, and waits for the user to submit
    //    the folder picker form. The chosen path is persisted to the
    //    AppData config above so we never ask again.
    let chosen = prompt_via_browser(&default_data_dir());
    let _ = write_app_config_data_dir(&chosen);
    chosen
}

/// Per-user app config path. Lives outside the data folder so it
/// survives wipes of the data folder, AND outside the exe folder so
/// it survives replacing/moving the binary.
fn app_config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // %APPDATA% = C:\Users\<u>\AppData\Roaming
        if let Ok(roaming) = std::env::var("APPDATA") {
            if !roaming.is_empty() {
                return Some(PathBuf::from(roaming).join("LocalChat").join("config.json"));
            }
        }
        if let Some(d) = dirs::config_dir() {
            return Some(d.join("LocalChat").join("config.json"));
        }
        None
    }
    #[cfg(not(windows))]
    {
        if let Some(d) = dirs::config_dir() {
            return Some(d.join("localchat").join("config.json"));
        }
        if let Some(home) = dirs::home_dir() {
            return Some(home.join(".config").join("localchat").join("config.json"));
        }
        None
    }
}

fn read_app_config_data_dir() -> Option<PathBuf> {
    let path = app_config_path()?;
    let txt = std::fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let dir = val.get("data_dir")?.as_str()?.trim().to_string();
    if dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(dir))
}

fn write_app_config_data_dir(dir: &std::path::Path) -> std::io::Result<()> {
    let path = match app_config_path() {
        Some(p) => p,
        None => return Ok(()),
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::json!({ "data_dir": dir.to_string_lossy() });
    std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap_or_default())?;
    Ok(())
}

fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        // C:\LocalChat — not protected by Controlled Folder Access,
        // writable by the current user after `mkdir`, and easy to
        // find/back-up/wipe.
        PathBuf::from(r"C:\LocalChat")
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            home.join("LocalChat")
        } else {
            PathBuf::from("./LocalChat")
        }
    }
}

/// First-run setup via a localhost web page. Binds an ephemeral port,
/// opens the user's default browser, and serves a simple form. Returns
/// the path the user picks (or `default` if the browser flow fails for
/// any reason — e.g. headless / no browser / port bind error). Blocks
/// until the form is submitted, so the rest of bootstrap waits.
fn prompt_via_browser(default: &std::path::Path) -> PathBuf {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("first-run setup: cannot bind localhost setup port ({e}); using default {}", default.display());
            return default.to_path_buf();
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let url = format!("http://127.0.0.1:{port}/");

    eprintln!();
    eprintln!("  ┌───────────────────────────────────────────────────────────┐");
    eprintln!("  │  LocalChat — first-run setup                              │");
    eprintln!("  └───────────────────────────────────────────────────────────┘");
    eprintln!();
    eprintln!("  Opening your browser to choose a data folder…");
    eprintln!("  If it doesn't open, visit:  {url}");
    eprintln!();

    // Try to launch the user's default browser. Failure is non-fatal —
    // the URL is printed above so they can paste it manually.
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }

    let default_attr = html_escape(&default.to_string_lossy());
    let form_html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>LocalChat — first-run setup</title>
<style>
  body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:580px;margin:60px auto;padding:0 24px;color:#1f2937;background:#f9fafb;}}
  h1{{font-size:22px;margin:0 0 4px;}}
  p{{color:#4b5563;line-height:1.55;}}
  label{{display:block;margin-top:18px;font-weight:600;font-size:14px;}}
  input[type=text]{{width:100%;padding:11px 12px;font:inherit;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;background:#fff;}}
  input[type=text]:focus{{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18);}}
  button{{margin-top:16px;padding:11px 22px;font:inherit;font-weight:600;background:#2563eb;color:#fff;border:0;border-radius:8px;cursor:pointer;}}
  button:hover{{background:#1d4ed8;}}
  .note{{font-size:13px;color:#6b7280;margin-top:6px;}}
  .warn{{font-size:13px;color:#92400e;background:#fef3c7;padding:10px 12px;border-radius:8px;margin-top:18px;}}
</style></head><body>
<h1>LocalChat — first-run setup</h1>
<p>Pick a folder where LocalChat will keep its database, uploads, logs, and TLS certificate. You can change this later by editing <code>%APPDATA%\LocalChat\config.json</code> (Windows) or <code>~/.config/localchat/config.json</code>.</p>
<form method="POST" action="/setup">
  <label for="path">Data folder</label>
  <input id="path" name="path" type="text" value="{default_attr}" autofocus spellcheck="false">
  <p class="note">Press <b>Continue</b> to use this folder, or edit the path first.</p>
  <div class="warn">⚠ Avoid OneDrive, Documents, Desktop, and <code>%APPDATA%</code>. Windows Defender's "Controlled Folder Access" can silently block writes there.</div>
  <button type="submit">Continue</button>
</form>
</body></html>"#
    );

    loop {
        let (mut stream, _) = match listener.accept() {
            Ok(x) => x,
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));

        // Read request headers (and any body bytes that came with them).
        let mut buf = Vec::with_capacity(2048);
        let mut tmp = [0u8; 2048];
        let mut header_end = None;
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        break;
                    }
                    if buf.len() > 64 * 1024 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let header_end = match header_end {
            Some(p) => p,
            None => {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
        };

        let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut header_lines = header_str.split("\r\n");
        let request_line = header_lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let path_part = parts.next().unwrap_or("");

        if method == "GET" && (path_part == "/" || path_part.starts_with("/?") || path_part == "/index.html") {
            let body = form_html.as_bytes();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.write_all(body);
            continue;
        }

        if method == "POST" && path_part == "/setup" {
            // Pull Content-Length from headers.
            let mut content_length: usize = 0;
            for line in header_lines {
                let lower = line.to_ascii_lowercase();
                if let Some(rest) = lower.strip_prefix("content-length:") {
                    content_length = rest.trim().parse().unwrap_or(0);
                    break;
                }
            }

            // Body bytes already read with headers.
            let mut body: Vec<u8> = buf[header_end..].to_vec();
            while body.len() < content_length && body.len() < 64 * 1024 {
                let mut more = [0u8; 2048];
                match stream.read(&mut more) {
                    Ok(0) => break,
                    Ok(n) => body.extend_from_slice(&more[..n]),
                    Err(_) => break,
                }
            }
            let body_str = String::from_utf8_lossy(&body).to_string();

            let mut chosen = default.to_path_buf();
            for kv in body_str.split('&') {
                let mut it = kv.splitn(2, '=');
                let k = it.next().unwrap_or("");
                let v = it.next().unwrap_or("");
                if k == "path" {
                    let decoded = url_decode(v);
                    let trimmed = decoded.trim();
                    if !trimmed.is_empty() {
                        chosen = PathBuf::from(trimmed);
                    }
                    break;
                }
            }

            let chosen_disp = html_escape(&chosen.to_string_lossy());
            let ok_html = format!(
                r#"<!doctype html><html><head><meta charset="utf-8"><title>LocalChat ready</title>
<style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:580px;margin:60px auto;padding:0 24px;color:#1f2937;background:#f9fafb;}}
h1{{font-size:22px;}} pre{{background:#fff;border:1px solid #e5e7eb;padding:12px 14px;border-radius:8px;overflow:auto;}}
p{{color:#4b5563;line-height:1.55;}}</style></head><body>
<h1>✅ Setup complete</h1>
<p>LocalChat will store its data in:</p>
<pre>{chosen_disp}</pre>
<p>You can close this tab. The server is starting on <code>https://localhost</code>.</p>
</body></html>"#
            );
            let body_b = ok_html.as_bytes();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body_b.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.write_all(body_b);
            let _ = stream.flush();
            // Give the browser a beat to actually receive the response
            // before the listener is dropped.
            std::thread::sleep(std::time::Duration::from_millis(150));
            return chosen;
        }

        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                } else {
                    out.push(b'%');
                }
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Make sure the chosen data directory is actually writable before we
/// start touching SQLite / TLS / uploads. Prints a clear, actionable
/// error on failure (including the exact Defender whitelist command)
/// and exits. This turns an invisible permission-denied into a loud
/// boot error instead of silent write failures at runtime.
pub fn verify_writable(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(".localchat-write-probe");
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)?;
    Ok(())
}
