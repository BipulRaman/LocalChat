//! HTTP routes: embedded static assets, uploads, downloads, WS upgrade,
//! plus admin-API mount.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        ConnectInfo, Multipart, Path, Query, State,
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
use crate::message::FileInfo;
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
        .route("/api/upload", post(upload))
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
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ip = addr.ip().to_string();
    ws.on_upgrade(move |socket: WebSocket| crate::ws::handle(socket, state, ip))
}

// ── Info ─────────────────────────────────────────────────────────────

async fn info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "addresses": crate::net::lan_addresses(),
        "hostname": hostname(),
        "version": env!("CARGO_PKG_VERSION"),
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
) -> Result<Json<FileInfo>, (StatusCode, String)> {
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

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name != "file" {
            continue;
        }
        let original = field
            .file_name()
            .unwrap_or("upload.bin")
            .to_string();
        let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
        let ext = std::path::Path::new(&original)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| format!(".{s}"))
            .unwrap_or_default();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let stored = format!("{id}{ext}");
        let path = state.uploads_dir.join(&stored);

        let mut file = tokio::fs::File::create(&path)
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
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "file too big".into()));
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
        file.flush()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        state.metrics.inc_upload(total);

        return Ok(Json(FileInfo {
            id: id.to_compact_string(),
            original_name: original,
            filename: stored.to_compact_string(),
            size: total,
            mime_type: mime.to_compact_string(),
            url: format!("/uploads/{stored}").to_compact_string(),
        }));
    }
    Err((StatusCode::BAD_REQUEST, "no 'file' field".into()))
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
                HeaderValue::from_static("public, max-age=86400"),
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
