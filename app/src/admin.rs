//! Admin REST API. Token-gated. By default only reachable from 127.0.0.1.

use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::channel::LOBBY_ID;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/stats", get(stats))
        .route("/users", get(users))
        .route("/sessions", get(sessions))
        .route("/channels", get(channels))
        .route("/settings", get(get_settings).post(post_settings))
        .route("/kick/:user_id", post(kick))
        .route("/ban/:user_id", post(ban))
        .route("/unban/:username", post(unban))
        .route("/broadcast", post(broadcast))
        .route("/channel/:id", axum::routing::delete(delete_channel))
        .route("/uploads", get(list_uploads))
        .route("/upload/:filename", axum::routing::delete(delete_upload))
        .route("/share", get(share))
        .route("/logs", get(logs))
        .route("/restart", post(restart))
        .route("/shutdown", post(shutdown))
        .route("/reset", post(reset))
        .route("/reset/users", post(reset_users))
        .route("/reset/channels", post(reset_channels))
        .route("/reset/messages", post(reset_messages))
        .route("/open-path", post(open_path))
}

// ── Authorization ────────────────────────────────────────────────────

/// Admin endpoints are only reachable from the host machine itself.
/// We rely on the client's source IP being a loopback address — there
/// is no token and no way to opt-in to LAN access. Other devices on the
/// network get a flat 403.
async fn authorize(
    _state: &Arc<AppState>,
    _headers: &HeaderMap,
    addr: std::net::SocketAddr,
) -> Result<(), (StatusCode, String)> {
    if addr.ip().is_loopback() {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "admin is host-only".into()))
    }
}

macro_rules! auth {
    ($state:expr, $headers:expr, $addr:expr) => {
        authorize(&$state, &$headers, $addr).await?;
    };
}

// ── Routes ───────────────────────────────────────────────────────────

async fn stats(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let upload_bytes = upload_dir_bytes(&state.uploads_dir).await;
    Ok(Json(json!({
        "metrics": state.metrics.snapshot(),
        "users_online": state.users.len(),
        "channels": state.channels.map.len(),
        "upload_dir_bytes": upload_bytes,
        "data_dir": state.app_root.display().to_string(),
        "uploads_dir": state.uploads_dir.display().to_string(),
        "logs_dir": state.logs_dir.display().to_string(),
        "config_path": state.config_path.display().to_string(),
    })))
}

async fn users(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    // Return *every* user the server has ever seen (not just live ones)
    // so the admin can audit who has connected, when, and from where.
    // Online status is derived from the live `users` map.
    let mut list: Vec<serde_json::Value> = state
        .known_users
        .iter()
        .map(|e| {
            let u = e.value();
            let live = state.users.get(&u.id).map(|l| l.value().clone());
            let online = live.is_some();
            let sockets = state.connections.get(&u.id).map(|n| *n).unwrap_or(0);
            let current_ip = live.as_ref().map(|l| l.ip.to_string()).unwrap_or_default();
            json!({
                "id": u.id,
                "username": u.username,
                "avatar": u.avatar,
                "color": u.color,
                "online": online,
                "sockets": sockets,
                "ip": current_ip,                       // current IP (live)
                "lastIp": u.last_ip,                    // most recent IP (persisted)
                "joinedAt": u.joined_at,                // first ever join
                "lastConnect": u.last_connect,          // most recent connect
                "lastSeen": u.last_seen,                // most recent disconnect (0 if never)
                "totalSessions": u.total_sessions,
                "msgCount": u.msg_count,
                "bytesUploaded": u.bytes_uploaded,
            })
        })
        .collect();
    // Online users first, then most recently active.
    list.sort_by(|a, b| {
        let ao = a.get("online").and_then(|v| v.as_bool()).unwrap_or(false);
        let bo = b.get("online").and_then(|v| v.as_bool()).unwrap_or(false);
        if ao != bo { return bo.cmp(&ao); }
        let at = a.get("lastConnect").and_then(|v| v.as_u64()).unwrap_or(0)
            .max(a.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0));
        let bt = b.get("lastConnect").and_then(|v| v.as_u64()).unwrap_or(0)
            .max(b.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0));
        bt.cmp(&at)
    });
    Ok(Json(json!({"users": list})))
}

#[derive(Deserialize)]
struct SessionsQuery {
    limit: Option<usize>,
    user: Option<u32>,
}

async fn sessions(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<SessionsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);
    let mut events = state.db.tail_session_events(limit).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(uid) = q.user {
        events.retain(|e| e.user_id == uid);
    }
    // Newest first for display.
    events.reverse();
    Ok(Json(json!({
        "events": events,
        "path": state.db.path.display().to_string(),
    })))
}

async fn channels(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let list: Vec<_> = state
        .channels
        .map
        .iter()
        .map(|e| e.value().meta())
        .collect();
    Ok(Json(json!({"channels": list})))
}

async fn get_settings(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let cfg = state.config.read().unwrap().clone();
    Ok(Json(json!({
        "port": cfg.port,
        "maxUploadMb": cfg.max_upload_mb,
        "historyRam": cfg.history_ram,
        "rotateMb": cfg.rotate_mb,
        "bannedUsers": cfg.banned_users,
        "bannedIps": cfg.banned_ips,
        "autostart": cfg.autostart,
    })))
}

#[derive(Deserialize)]
struct SettingsPatch {
    port: Option<u16>,
    #[serde(rename = "maxUploadMb")]
    max_upload_mb: Option<u64>,
    #[serde(rename = "historyRam")]
    history_ram: Option<usize>,
    #[serde(rename = "rotateMb")]
    rotate_mb: Option<u64>,
    autostart: Option<bool>,
}

async fn post_settings(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(patch): Json<SettingsPatch>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let mut cfg = state.config.write().unwrap();
    if let Some(v) = patch.port {
        cfg.port = v;
    }
    if let Some(v) = patch.max_upload_mb {
        cfg.max_upload_mb = v;
    }
    if let Some(v) = patch.history_ram {
        cfg.history_ram = v.clamp(16, 1000);
    }
    if let Some(v) = patch.rotate_mb {
        cfg.rotate_mb = v.clamp(1, 1000);
    }
    if let Some(v) = patch.autostart {
        cfg.autostart = v;
        #[cfg(windows)]
        {
            let _ = apply_autostart(v);
        }
    }
    cfg.save(&state.config_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({"ok": true, "restart_required": patch.port.is_some()})))
}

async fn kick(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(user_id): Path<u32>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let existed = state.users.remove(&user_id).is_some();
    // Drop the persisted identity too so /users no longer lists them.
    state.known_users.remove(&user_id);
    if let Some(key) = state
        .username_to_id
        .iter()
        .find(|e| *e.value() == user_id)
        .map(|e| e.key().clone())
    {
        state.username_to_id.remove(&key);
    }
    state.connections.remove(&user_id);
    // Actively disconnect every live socket for this user.
    let _ = state.kick_tx.send(crate::state::KickSignal::User(user_id));
    let _ = state.db.delete_user(user_id).await;
    let _ = state.db.log_admin("kick", &addr.ip().to_string(), &user_id.to_string(), "").await;
    Ok(Json(json!({"ok": existed})))
}

async fn ban(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(user_id): Path<u32>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let to_ban = state.users.get(&user_id).map(|u| (u.username.to_string(), u.ip.to_string()));
    let Some((username, ip)) = to_ban else {
        return Err((StatusCode::NOT_FOUND, "no such user".into()));
    };
    {
        let mut cfg = state.config.write().unwrap();
        if !cfg.banned_users.contains(&username) {
            cfg.banned_users.push(username.clone());
        }
        if !cfg.banned_ips.contains(&ip) && !ip.is_empty() {
            cfg.banned_ips.push(ip.clone());
        }
    }
    let now = crate::message::now_secs();
    let _ = state.db.add_ban("user", &username, "admin ban", now).await;
    if !ip.is_empty() {
        let _ = state.db.add_ban("ip", &ip, "admin ban", now).await;
    }
    let _ = state.db.log_admin("ban", &addr.ip().to_string(), &user_id.to_string(), &username).await;
    state.users.remove(&user_id);
    // Actively boot the banned user's open sockets.
    let _ = state.kick_tx.send(crate::state::KickSignal::User(user_id));
    Ok(Json(json!({"ok": true})))
}

async fn unban(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    {
        let mut cfg = state.config.write().unwrap();
        cfg.banned_users.retain(|u| u != &username);
    }
    let _ = state.db.remove_ban("user", &username).await;
    let _ = state.db.log_admin("unban", &addr.ip().to_string(), &username, "").await;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct BroadcastReq {
    text: String,
    channel: Option<String>,
}

async fn broadcast(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<BroadcastReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let ch_id = req.channel.unwrap_or_else(|| LOBBY_ID.to_string());
    let Some(ch) = state.channels.get(&ch_id) else {
        return Err((StatusCode::NOT_FOUND, "no such channel".into()));
    };
    use crate::message::{now_secs, MsgKind, WireMsg};
    use compact_str::CompactString;
    let msg = Arc::new(WireMsg {
        id: state.next_msg_id(),
        channel: ch.id.clone(),
        kind: MsgKind::System,
        user_id: 0,
        username: CompactString::const_new("admin"),
        avatar: CompactString::const_new(""),
        color: CompactString::const_new("#ef4444"),
        ts: now_secs(),
        text: format!("📢 {}", req.text),
        file: None,
        reply_to: None,
        edited_at: None,
        deleted: false,
    });
    ch.push_history(msg.clone()).await;
    let _ = state.db.insert_message(&msg).await;
    let _ = ch.tx.send(msg);
    let _ = state.db.log_admin("broadcast", &addr.ip().to_string(), &ch_id, &req.text).await;
    Ok(Json(json!({"ok": true})))
}

async fn delete_channel(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    if id == LOBBY_ID {
        return Err((StatusCode::BAD_REQUEST, "cannot delete lobby".into()));
    }
    let cid = compact_str::CompactString::from(id.clone());
    // Notify subscribers before tearing down so live clients drop the channel.
    if let Some(ch) = state.channels.get(&id) {
        use crate::message::{now_secs, MsgKind, WireMsg};
        use compact_str::CompactString;
        let marker = if matches!(ch.kind, crate::channel::ChannelKind::Dm) {
            "__dm_deleted"
        } else {
            "__ch_deleted"
        };
        let _ = ch.tx.send(Arc::new(WireMsg {
            id: 0,
            channel: cid.clone(),
            kind: MsgKind::System,
            user_id: 0,
            username: CompactString::from(marker),
            avatar: CompactString::const_new(""),
            color: CompactString::const_new(""),
            ts: now_secs(),
            text: json!({"channel": cid}).to_string(),
            file: None,
            reply_to: None,
            edited_at: None,
            deleted: true,
        }));
    }
    state.channels.delete_any(&id);
    let _ = state.db.delete_channel(&id).await;
    state.reactions.retain(|(c, _), _| c != &cid);
    let _ = state.db.log_admin("delete_channel", &addr.ip().to_string(), &id, "").await;
    Ok(Json(json!({"ok": true})))
}

async fn list_uploads(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    // Index lives in the DB; the bytes live on disk. We list from the DB
    // so we get original filename, mime, uploader, etc. — then enrich
    // with the on-disk size/mtime for any orphans not in the index.
    let mut rows = state.db.list_uploads().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut indexed: std::collections::HashSet<String> = rows.iter()
        .map(|r| r.storage_name.clone()).collect();
    if let Ok(mut rd) = tokio::fs::read_dir(&state.uploads_dir).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            if let Ok(m) = ent.metadata().await {
                if !m.is_file() { continue; }
                let name = ent.file_name().to_string_lossy().to_string();
                if indexed.insert(name.clone()) {
                    let modified = m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    rows.push(crate::db::UploadRow {
                        storage_name: name.clone(),
                        original_name: name,
                        mime: String::new(),
                        size: m.len(),
                        uploaded_by: None,
                        uploaded_by_name: String::new(),
                        uploaded_at: modified,
                    });
                }
            }
        }
    }
    Ok(Json(json!({"files": rows})))
}

async fn delete_upload(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let path = state.uploads_dir.join(safe);
    tokio::fs::remove_file(path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let _ = state.db.delete_upload(safe).await;
    let _ = state.db.log_admin("delete_upload", &addr.ip().to_string(), safe, "").await;
    Ok(Json(json!({"ok": true})))
}

async fn upload_dir_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            if let Ok(m) = ent.metadata().await {
                if m.is_file() {
                    total += m.len();
                }
            }
        }
    }
    total
}

/// Returns the LAN URLs the server is reachable at, plus a pre-rendered
/// SVG QR code for each. Lets the admin page show a "scan to join from
/// your phone" panel without bundling a JS QR library.
async fn share(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);

    // Port the admin themselves connected to (Host header). Falls back
    // to the actually-bound port, then the configured port, then 443.
    let port = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.rsplit(':').next())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or_else(|| {
            let p = state.bound_port.load(std::sync::atomic::Ordering::Relaxed);
            if p > 0 { p } else {
                let cfg = state.config.read().unwrap();
                if cfg.port > 0 { cfg.port } else { 443 }
            }
        });

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push = |label: &str, url: String, entries: &mut Vec<serde_json::Value>, seen: &mut std::collections::HashSet<String>| {
        if !seen.insert(url.clone()) { return; }
        let qr = render_qr_svg(&url);
        entries.push(json!({ "label": label, "url": url, "qr": qr }));
    };

    push("This computer", format!("https://localhost:{port}"), &mut entries, &mut seen);
    for ip in crate::net::lan_addresses() {
        if !ip.starts_with("192.168.") { continue; }
        push("LAN", format!("https://{ip}:{port}"), &mut entries, &mut seen);
    }

    Ok(Json(json!({ "entries": entries })))
}

fn render_qr_svg(data: &str) -> String {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    match QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color<'_>>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#0f172a"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

#[derive(Deserialize)]
struct LogsQuery {
    lines: Option<usize>,
}

/// Tail the application log file. Returns the last `lines` lines (default
/// 200, capped at 5000) so the admin page can show recent activity.
async fn logs(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<LogsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let limit = q.lines.unwrap_or(200).clamp(1, 5000);
    let path = match crate::applog::path() {
        Some(p) => p,
        None => {
            return Ok(Json(json!({
                "lines": Vec::<String>::new(),
                "path": serde_json::Value::Null,
                "total": 0
            })));
        }
    };
    let body = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let lines_vec: Vec<&str> = body.lines().collect();
    let start = lines_vec.len().saturating_sub(limit);
    let tail: Vec<&str> = lines_vec[start..].to_vec();
    Ok(Json(json!({
        "lines": tail,
        "path": path.display().to_string(),
        "total": lines_vec.len(),
    })))
}

#[cfg(windows)]
fn apply_autostart(enable: bool) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")?;
    if enable {
        let exe = std::env::current_exe()?
            .to_string_lossy()
            .to_string();
        run.set_value("LocalChat", &exe)?;
    } else {
        let _ = run.delete_value("LocalChat");
    }
    Ok(())
}

/// Re-launch the current executable, then exit this process. Lets the
/// admin apply settings (especially port changes) without manual restart.
async fn restart(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    spawn_self_and_exit(false);
    Ok(Json(json!({ "ok": true })))
}

/// Stop the server. No respawn.
async fn shutdown(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    spawn_self_and_exit(true);
    Ok(Json(json!({ "ok": true })))
}

/// Master "factory reset": wipes every user, channel, message, reaction,
/// upload, and session-audit record from both memory and disk. The lobby
/// is recreated empty. Active WebSockets are notified and will fail their
/// next op (their user/channel is gone), causing the clients to reconnect
/// fresh. Configuration (port, banned lists, etc.) is preserved.
#[derive(Deserialize, Default)]
struct ResetReq {
    /// Must be the literal string "RESET" to proceed. Cheap server-side
    /// guard against accidental POSTs from confused tooling.
    #[serde(default)]
    confirm: String,
}

async fn reset(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ResetReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    if req.confirm != "RESET" {
        return Err((StatusCode::BAD_REQUEST, "missing confirm=\"RESET\"".into()));
    }

    use crate::channel::{Channel, ChannelKind, LOBBY_ID, LOBBY_NAME};
    use crate::message::{now_secs, MsgKind, WireMsg};
    use compact_str::CompactString;
    use std::sync::atomic::Ordering;

    crate::applog::log(format_args!(
        "admin: factory reset triggered from {}", addr.ip()
    ));

    // Engage the reset guard so any in-flight WS cleanup() paths skip
    // their per-user audit/identity writes (which would otherwise race
    // the DB flush below and leave ghost rows behind).
    state.resetting.store(true, Ordering::Relaxed);

    // 1. Best-effort notice to anyone currently connected.
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        let _ = lobby.tx.send(Arc::new(WireMsg {
            id: 0,
            channel: lobby.id.clone(),
            kind: MsgKind::System,
            user_id: 0,
            username: CompactString::const_new("admin"),
            avatar: CompactString::const_new(""),
            color: CompactString::const_new("#ef4444"),
            ts: now_secs(),
            text: "⚠️ Server data was wiped by the administrator. Please refresh.".to_string(),
            file: None,
            reply_to: None,
            edited_at: None,
            deleted: false,
        }));
    }

    // 2. Wipe in-memory state.
    state.users.clear();
    state.known_users.clear();
    state.username_to_id.clear();
    state.connections.clear();
    state.reactions.clear();
    state.channels.map.clear();
    state.channels.user_channels.clear();
    state.calls.clear();

    // 3. Recreate the lobby (in-memory) so the next user to join has
    //    something to land on, and reset id counters.
    let lobby = Channel::new(
        CompactString::const_new(LOBBY_ID),
        ChannelKind::Lobby,
        CompactString::const_new(LOBBY_NAME),
        false,
        0,
        state.channels.history_cap,
    );
    state.channels.map.insert(lobby.id.clone(), Arc::new(lobby));
    state.next_user_id.store(1, Ordering::Relaxed);
    state.next_msg_id.store(1, Ordering::Relaxed);

    // 4. Force every live socket to close so clients reconnect against
    //    the freshly-empty server. The cleanup() path is gated by
    //    `state.resetting`, so no fresh `disconnect` rows are written.
    let _ = state.kick_tx.send(crate::state::KickSignal::All);
    // Give cleanup tasks a tick to run before we flush.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // 5. Wipe all SQLite-backed state in one transaction. Bans and the
    //    admin-event audit are preserved on purpose.
    let flush_result = state.db.flush_all().await;
    // Re-insert the lobby so the next user to join doesn't trip an FK
    // violation when posting their first message.
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        let _ = state.db.upsert_channel(&lobby.meta()).await;
    }

    // Release the reset guard so future disconnects audit normally.
    state.resetting.store(false, Ordering::Relaxed);

    flush_result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // 6. Wipe upload bytes too. The DB index has already been cleared
    //    above by flush_all().
    wipe_dir_files(&state.uploads_dir).await;
    let _ = state.db.log_admin("reset_all", &addr.ip().to_string(), "", "").await;

    Ok(Json(json!({ "ok": true })))
}

/// Delete every regular file directly inside `dir`. Subdirectories are
/// left alone (none of our data dirs use them today).
async fn wipe_dir_files(dir: &std::path::Path) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else { return };
    while let Ok(Some(ent)) = rd.next_entry().await {
        if let Ok(m) = ent.metadata().await {
            if m.is_file() {
                let _ = tokio::fs::remove_file(ent.path()).await;
            }
        }
    }
}

// ── Granular reset endpoints ────────────────────────────────────────
//
// Each one wipes a single category. They share the "confirm=RESET" gate
// of the master reset so accidental POSTs can't take effect. Settings
// (port, banned lists, autostart) are always preserved.

/// Wipe every known user (live and historical), channel-membership
/// entries, and the session audit log. Channels themselves are kept,
/// but their member lists are cleared. Active sockets are forced off
/// because the next op they send will fail (their user is gone).
async fn reset_users(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ResetReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    if req.confirm != "RESET" {
        return Err((StatusCode::BAD_REQUEST, "missing confirm=\"RESET\"".into()));
    }
    use std::sync::atomic::Ordering;
    crate::applog::log(format_args!(
        "admin: reset users triggered from {}", addr.ip()
    ));

    state.resetting.store(true, Ordering::Relaxed);

    state.users.clear();
    state.known_users.clear();
    state.username_to_id.clear();
    state.connections.clear();

    // Strip every channel's member list so orphan UserIds don't linger.
    for entry in state.channels.map.iter() {
        entry.value().members.clear();
    }
    state.channels.user_channels.clear();

    state.next_user_id.store(1, Ordering::Relaxed);

    // Boot every live socket first so users get logged out immediately.
    // The cleanup() path is gated by `state.resetting`, so no fresh
    // disconnect rows are written into session_events.
    let _ = state.kick_tx.send(crate::state::KickSignal::All);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // Wipe users + cascade memberships, plus the session audit log.
    let flush_result = state.db.flush_users().await;
    let _ = state.db.flush_session_events().await;
    let _ = state.db.log_admin("reset_users", &addr.ip().to_string(), "", "").await;

    state.resetting.store(false, Ordering::Relaxed);

    flush_result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({ "ok": true })))
}

/// Wipe every channel except the lobby, plus all message history and
/// reactions. Users are kept (their identity, IDs, avatar/color, and
/// session history all survive).
async fn reset_channels(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ResetReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    if req.confirm != "RESET" {
        return Err((StatusCode::BAD_REQUEST, "missing confirm=\"RESET\"".into()));
    }
    use crate::channel::{Channel, ChannelKind, LOBBY_ID, LOBBY_NAME};
    use compact_str::CompactString;
    crate::applog::log(format_args!(
        "admin: reset channels triggered from {}", addr.ip()
    ));

    // Notify before tear-down so live clients drop their channel UI.
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        use crate::message::{now_secs, MsgKind, WireMsg};
        let _ = lobby.tx.send(Arc::new(WireMsg {
            id: 0,
            channel: lobby.id.clone(),
            kind: MsgKind::System,
            user_id: 0,
            username: CompactString::const_new("admin"),
            avatar: CompactString::const_new(""),
            color: CompactString::const_new("#ef4444"),
            ts: now_secs(),
            text: "⚠️ All channels were cleared by the administrator. Please refresh.".to_string(),
            file: None,
            reply_to: None,
            edited_at: None,
            deleted: false,
        }));
    }

    state.channels.map.clear();
    state.channels.user_channels.clear();
    state.reactions.clear();

    // Boot live sockets so clients reconnect against the fresh lobby.
    let _ = state.kick_tx.send(crate::state::KickSignal::All);

    // Recreate a fresh, empty lobby.
    let lobby = Channel::new(
        CompactString::const_new(LOBBY_ID),
        ChannelKind::Lobby,
        CompactString::const_new(LOBBY_NAME),
        false,
        0,
        state.channels.history_cap,
    );
    state.channels.map.insert(lobby.id.clone(), Arc::new(lobby));

    let _ = state.channels.get(LOBBY_ID).map(|l| l.id.clone());
    state.db.flush_channels().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        let _ = state.db.upsert_channel(&lobby.meta()).await;
    }
    let _ = state.db.log_admin("reset_channels", &addr.ip().to_string(), "", "").await;

    Ok(Json(json!({ "ok": true })))
}

/// Wipe message history and reactions for every channel, but keep the
/// channels themselves (and their members). Useful for clearing chatter
/// without losing the chat structure.
async fn reset_messages(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ResetReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    if req.confirm != "RESET" {
        return Err((StatusCode::BAD_REQUEST, "missing confirm=\"RESET\"".into()));
    }
    use std::sync::atomic::Ordering;
    crate::applog::log(format_args!(
        "admin: reset messages triggered from {}", addr.ip()
    ));

    // Drain every channel's in-memory history ring.
    for entry in state.channels.map.iter() {
        let mut h = entry.value().history.write().await;
        h.clear();
    }
    state.reactions.clear();
    state.next_msg_id.store(1, Ordering::Relaxed);

    state.db.flush_messages().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = state.db.log_admin("reset_messages", &addr.ip().to_string(), "", "").await;

    Ok(Json(json!({ "ok": true })))
}

/// Open one of the server's well-known directories in the host's file
/// manager. Restricted to whitelisted keys so we never reveal an
/// arbitrary filesystem path to the caller.
async fn open_path(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<OpenPathReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let path = match req.key.as_str() {
        "data"    => state.app_root.clone(),
        "uploads" => state.uploads_dir.clone(),
        "logs"    => state.logs_dir.clone(),
        "config"  => state.config_path.clone(),
        _ => return Err((StatusCode::BAD_REQUEST, "unknown path key".into())),
    };
    opener::open(&path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("open failed: {e}")))?;
    Ok(Json(json!({ "ok": true, "path": path.display().to_string() })))
}

#[derive(Deserialize)]
struct OpenPathReq { key: String }

fn spawn_self_and_exit(shutdown_only: bool) {
    // Defer so the HTTP response has time to flush back to the browser.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if !shutdown_only {
            if let Ok(exe) = std::env::current_exe() {
                let cwd = std::env::current_dir().ok();
                let mut cmd = std::process::Command::new(exe);
                if let Some(d) = cwd { cmd.current_dir(d); }
                // Detach so the child outlives us.
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const DETACHED_PROCESS: u32 = 0x00000008;
                    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
                    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                }
                let _ = cmd.spawn();
            }
        }
        std::process::exit(0);
    });
}
