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
        .route("/channels", get(channels))
        .route("/settings", get(get_settings).post(post_settings))
        .route("/kick/:user_id", post(kick))
        .route("/ban/:user_id", post(ban))
        .route("/unban/:username", post(unban))
        .route("/broadcast", post(broadcast))
        .route("/channel/:id", axum::routing::delete(delete_channel))
        .route("/uploads", get(list_uploads))
        .route("/upload/:filename", axum::routing::delete(delete_upload))
}

// ── Authorization ────────────────────────────────────────────────────

async fn authorize(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    addr: std::net::SocketAddr,
) -> Result<(), (StatusCode, String)> {
    let cfg = state.config.read().unwrap();
    if !cfg.allow_lan_admin && !addr.ip().is_loopback() {
        return Err((StatusCode::FORBIDDEN, "admin API is localhost-only".into()));
    }
    let tok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| headers.get("x-token").and_then(|v| v.to_str().ok()));
    match tok {
        Some(t) if t == cfg.admin_token => Ok(()),
        _ => Err((StatusCode::UNAUTHORIZED, "bad token".into())),
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
    let list: Vec<_> = state
        .users
        .iter()
        .map(|e| {
            let u = e.value();
            json!({
                "id": u.id,
                "username": u.username,
                "ip": u.ip,
                "joinedAt": u.joined_at,
                "msgCount": u.msg_count,
                "bytesUploaded": u.bytes_uploaded,
            })
        })
        .collect();
    Ok(Json(json!({"users": list})))
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
        "allowLanAdmin": cfg.allow_lan_admin,
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
    #[serde(rename = "allowLanAdmin")]
    allow_lan_admin: Option<bool>,
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
    if let Some(v) = patch.allow_lan_admin {
        cfg.allow_lan_admin = v;
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
    // We mark the user as "removed" — the WS loop will notice next round.
    // Simplest path: remove from users map; subsequent sends fail and
    // the socket closes. Proper kick would signal via an mpsc per-socket.
    let existed = state.users.remove(&user_id).is_some();
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
    let mut cfg = state.config.write().unwrap();
    if !cfg.banned_users.contains(&username) {
        cfg.banned_users.push(username.clone());
    }
    if !cfg.banned_ips.contains(&ip) && !ip.is_empty() {
        cfg.banned_ips.push(ip);
    }
    let _ = cfg.save(&state.config_path);
    drop(cfg);
    state.users.remove(&user_id);
    Ok(Json(json!({"ok": true})))
}

async fn unban(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let mut cfg = state.config.write().unwrap();
    cfg.banned_users.retain(|u| u != &username);
    cfg.save(&state.config_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    state.history.append(&msg).await;
    let _ = ch.tx.send(msg);
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
    state.channels.map.remove(&compact_str::CompactString::from(id.clone()));
    state.history.delete_channel(&id).await;
    Ok(Json(json!({"ok": true})))
}

async fn list_uploads(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth!(state, headers, addr);
    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(&state.uploads_dir).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            if let Ok(m) = ent.metadata().await {
                if m.is_file() {
                    out.push(json!({
                        "name": ent.file_name().to_string_lossy(),
                        "size": m.len(),
                    }));
                }
            }
        }
    }
    Ok(Json(json!({"files": out})))
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
