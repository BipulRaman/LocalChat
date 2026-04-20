//! HTTP routes: embedded static assets, uploads, downloads, WS upgrade,
//! plus admin-API mount.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Response, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use compact_str::ToCompactString;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use crate::admin;
use crate::message::{FileInfo, MsgKind, WireMsg, now_secs};
use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "web/"]
struct WebAssets;

pub async fn serve(
    state: Arc<AppState>,
    ready: oneshot::Sender<u16>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port = {
        let cfg = state.config.read().unwrap();
        let requested = if cfg.port > 0 { Some(cfg.port) } else { None };
        crate::net::pick_port(requested)?
    };
    state
        .bound_port
        .store(port, std::sync::atomic::Ordering::Relaxed);

    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api/info", get(info))
        .route("/api/share", get(share))
        .route(
            "/api/upload",
            // Disable Axum's default 2 MiB body cap; we enforce
            // `max_upload_mb` ourselves while streaming the multipart
            // body, so videos and large files don't trip the parser
            // with a generic "Error parsing multipart/form-data".
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/download/:filename", get(download))
        .route("/uploads/:filename", get(serve_upload))
        .nest("/api/admin", admin::router())
        .fallback(serve_asset)
        .with_state(Arc::clone(&state));

    let _ = ready.send(port);

    // Serve everything over HTTPS on the chosen port (443 preferred, else
    // first free port in the preferred list) so browsers grant getUserMedia / Web Crypto on LAN. A self-signed cert
    // is auto-generated under <app_root>/tls/ on first run.
    serve_tls(state, app, port).await
}

async fn serve_tls(
    state: Arc<AppState>,
    app: Router,
    port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum_server::tls_rustls::RustlsConfig;

    // Initialize the rustls crypto provider once (idempotent).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let tls_dir = state.app_root.join("tls");
    let cert_path = tls_dir.join("cert.pem");
    let key_path = tls_dir.join("key.pem");

    if !cert_path.exists() || !key_path.exists() {
        std::fs::create_dir_all(&tls_dir)?;
        let san = build_cert_sans();
        let cert = rcgen::generate_simple_self_signed(san)?;
        std::fs::write(&cert_path, cert.cert.pem())?;
        std::fs::write(&key_path, cert.key_pair.serialize_pem())?;
        crate::applog::log(format_args!(
            "tls: generated self-signed cert at {}", tls_dir.display()
        ));
    }

    let cfg = RustlsConfig::from_pem_file(cert_path, key_path).await?;
    let addr: std::net::SocketAddr = ([0, 0, 0, 0], port).into();
    axum_server::bind_rustls(addr, cfg)
        .serve(app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await?;
    Ok(())
}

/// Subject-Alternative-Names that the cert should cover. Includes
/// localhost, 127.0.0.1, and every detected LAN address so browsers
/// don't yell about a hostname mismatch on first visit.
fn build_cert_sans() -> Vec<String> {
    let mut sans: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
    for ip in crate::net::lan_addresses() {
        sans.push(ip);
    }
    sans
}

// ── WS ───────────────────────────────────────────────────────────────

async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ip = addr.ip().to_string();
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(256)
        .collect::<String>();
    ws.on_upgrade(move |socket: WebSocket| crate::ws::handle(socket, state, ip, ua))
}

// ── Info ─────────────────────────────────────────────────────────────

async fn info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // CI stamps the release tag (e.g. "1.0.6") into LOCALCHAT_VERSION at
    // build time via env! so the binary's reported version matches the
    // GitHub release that produced it. Cargo.toml stays at "1.0.0" for
    // local dev where the tag is unknown — in that case we fall back to
    // CARGO_PKG_VERSION. Strip a leading "v" so the value compares cleanly
    // against GitHub tag_names like "v1.0.6".
    let version = option_env!("LOCALCHAT_VERSION")
        .map(|v| v.trim_start_matches('v'))
        .filter(|v| !v.is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    Json(json!({
        "addresses": crate::net::lan_addresses(),
        "hostname": hostname(),
        "version": version,
        "server_id": state.server_id,
        "data_dir": state.app_root.display().to_string(),
        "uploads_dir": state.uploads_dir.display().to_string(),
        "logs_dir": state.logs_dir.display().to_string(),
    }))
}

/// Public share info: the URLs this server is reachable at, plus
/// pre-rendered SVG QR codes. No auth — these are addresses any joined
/// user already knows (they're connected to one of them).
async fn share(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
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
    let mut seen = std::collections::HashSet::<String>::new();
    let mut push = |label: &str, url: String| -> Option<serde_json::Value> {
        if !seen.insert(url.clone()) { return None; }
        Some(json!({ "label": label, "url": url.clone(), "qr": render_qr_svg(&url) }))
    };

    // Only expose true LAN addresses (192.168.x.x). Skips localhost and
    // virtual adapters like 172.x (Hyper-V / WSL) that other phones can't
    // route to anyway.
    for ip in crate::net::lan_addresses() {
        if ip.starts_with("192.168.") {
            if let Some(v) = push("LAN", format!("https://{ip}:{port}")) { entries.push(v); }
        }
    }

    Json(json!({ "entries": entries }))
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

fn hostname() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "localhost".into())
    }
}

// ── Upload / Download ────────────────────────────────────────────────

async fn upload(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let max_bytes = {
        let cfg = state.config.read().unwrap();
        cfg.max_upload_mb.saturating_mul(1024 * 1024)
    };

    // Fail fast on obviously oversized requests — 1 MiB slack for
    // multipart framing overhead. Streaming check below is still the
    // authoritative limit.
    if let Some(len) = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if len > max_bytes.saturating_add(1024 * 1024) {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "file too big".into()));
        }
    }

    // Atomically: stream the file body to disk, then (if non-file
    // metadata fields are also present) insert a `file` message into
    // the channel and broadcast it. This collapses the previous
    // two-step "POST + WS announce" flow into a single request, so
    // the upload either fully succeeds (file on disk + chat message
    // in DB + broadcast to peers) or fails as a unit.
    //
    // Expected multipart fields (in any order, but `file` must be
    // last so we have all the metadata when we insert):
    //   session  – token from the WS welcome envelope (auth)
    //   channel  – channel id to post into
    //   text     – optional message text (E2EE envelope for DM files)
    //   client_id – optional client-supplied dedupe id
    //   file     – the bytes
    let mut session: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut text: String = String::new();
    let mut client_id: Option<String> = None;

    let mut file_info: Option<FileInfo> = None;
    let mut file_size: u64 = 0;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session" => {
                session = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "channel" => {
                channel = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "text" => {
                text = field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            }
            "client_id" => {
                client_id = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "file" => {
                let original = field.file_name().unwrap_or("upload.bin").to_string();
                let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
                let ext = std::path::Path::new(&original)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| format!(".{s}"))
                    .unwrap_or_default();
                let id = uuid::Uuid::new_v4().simple().to_string();
                let stored = format!("{id}{ext}");
                let path = state.uploads_dir.join(&stored);

                let mut f = tokio::fs::File::create(&path)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

                let mut total: u64 = 0;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
                {
                    total += chunk.len() as u64;
                    if total > max_bytes {
                        drop(f);
                        let _ = tokio::fs::remove_file(&path).await;
                        return Err((StatusCode::PAYLOAD_TOO_LARGE, "file too big".into()));
                    }
                    f.write_all(&chunk)
                        .await
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                }
                f.flush()
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

                state.metrics.inc_upload(total);
                file_size = total;
                file_info = Some(FileInfo {
                    id: id.to_compact_string(),
                    original_name: original,
                    filename: stored.to_compact_string(),
                    size: total,
                    mime_type: mime.to_compact_string(),
                    url: format!("/uploads/{stored}").to_compact_string(),
                });
            }
            _ => {
                // Drain unknown fields so the parser can advance.
                let _ = field.bytes().await;
            }
        }
    }

    let info = file_info
        .ok_or((StatusCode::BAD_REQUEST, "no 'file' field".into()))?;

    // Resolve user from session token. Without a valid token the
    // file is still saved but no message is created (legacy behaviour
    // for any non-WS caller). The WS client always supplies one now.
    let user_id = session
        .as_deref()
        .and_then(|t| state.sessions.get(t).map(|e| e.value().clone()));

    // Always record the upload in the durable index for the admin
    // dashboard, regardless of whether a message was created.
    let uploaded_by_name = user_id
        .as_ref()
        .and_then(|uid| state.users.get(uid).map(|u| u.username.to_string()))
        .unwrap_or_default();
    let _ = state.db.insert_upload(
        &info.filename,
        &info.original_name,
        info.mime_type.as_str(),
        file_size,
        user_id.clone(),
        &uploaded_by_name,
        now_secs(),
    ).await;

    // No session / no channel → return file info without posting
    // (kept for the unauthenticated drop-in test path; production
    // clients always pass session+channel).
    let (Some(uid), Some(ch_id)) = (user_id, channel.clone()) else {
        // If the client tried to post (i.e. supplied a `session` or
        // `channel` field) but auth failed, fail loudly so the user
        // gets a toast instead of a silently-orphaned file.
        if session.is_some() || channel.is_some() {
            return Err((StatusCode::UNAUTHORIZED, "session expired — refresh and try again".into()));
        }
        return Ok(Json(serde_json::to_value(&info).unwrap_or(json!({}))));
    };

    // Idempotency: if the client retries the same logical upload
    // (the JS outbox replays after a refresh), we'd see a fresh
    // file_id but the same client_id. Use that to avoid posting
    // duplicate messages. A cold replay (different client_id) would
    // post twice — clients are responsible for stable client_ids.
    if let Some(cid) = client_id.as_deref() {
        if let Ok(Some(_existing)) = state.db.message_id_for_client_id(cid).await {
            return Ok(Json(json!({
                "file": info,
                "deduped": true,
            })));
        }
    }

    let ch = state.channels.get(&ch_id)
        .ok_or((StatusCode::BAD_REQUEST, "no such channel".into()))?;
    if !matches!(ch.kind, crate::channel::ChannelKind::Lobby) && !ch.members.contains(&uid) {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let user = state.users.get(&uid)
        .ok_or((StatusCode::UNAUTHORIZED, "user gone".into()))?
        .clone();

    let msg = Arc::new(WireMsg {
        id: state.next_msg_id(),
        channel: ch_id.to_compact_string(),
        kind: MsgKind::File,
        user_id: uid.clone(),
        username: user.username.clone(),
        avatar: user.avatar.clone(),
        color: user.color.clone(),
        ts: now_secs(),
        text,
        file: Some(info.clone()),
        reply_to: None,
        edited_at: None,
        deleted: false,
    });
    ch.push_history(msg.clone()).await;
    if let Err(e) = state.db.insert_message(&msg).await {
        crate::applog::log(format_args!("db.insert_message FAILED (upload): {e}"));
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("db write failed: {e}")));
    }
    if let Some(cid) = client_id.as_deref() {
        let _ = state.db.set_message_client_id(msg.id, cid).await;
    }
    if file_size > 0 {
        let _ = state.db.bump_user_uploaded(uid, file_size).await;
    }
    state.metrics.inc_messages();
    let _ = ch.tx.send(msg.clone());

    Ok(Json(json!({
        "file": info,
        "messageId": msg.id,
    })))
}

#[derive(Deserialize)]
struct DownloadQuery {
    name: Option<String>,
}

async fn download(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
    Query(q): Query<DownloadQuery>,
) -> impl IntoResponse {
    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let path = state.uploads_dir.join(safe);
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let disp_name = q.name.unwrap_or_else(|| safe.to_string());
            let mime = mime_guess::from_path(&path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            let mut headers = HeaderMap::new();
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                disp_name.replace('"', "'")
            )) {
                headers.insert(header::CONTENT_DISPOSITION, v);
            }
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn serve_upload(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let path = state.uploads_dir.join(safe);
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            let mut headers = HeaderMap::new();
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ── Embedded static assets (the web/ folder) ─────────────────────────

async fn serve_asset(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    uri: Uri,
) -> impl IntoResponse {
    let mut p = uri.path().trim_start_matches('/').to_string();
    if p.is_empty() {
        p = "index.html".into();
    }
    // Admin path convenience: /admin → admin.html
    if p == "admin" || p == "admin/" {
        p = "admin.html".into();
    }
    // The admin dashboard is host-only. Treat as 404 from any non-loopback
    // address so its existence is not advertised on the LAN.
    if (p == "admin.html" || p == "admin.js") && !addr.ip().is_loopback() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match WebAssets::get(&p) {
        Some(content) => {
            let mime = mime_guess::from_path(&p)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(content.data.into_owned()))
                .unwrap()
        }
        None => {
            // SPA fallback → index.html
            if let Some(content) = WebAssets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(content.data.into_owned()))
                    .unwrap()
            } else {
                (StatusCode::NOT_FOUND, "not found").into_response()
            }
        }
    }
}
