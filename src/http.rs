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
use compact_str::{CompactString, ToCompactString};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
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

    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api/info", get(info))
        .route("/api/upload", post(upload))
        .route("/api/download/:filename", get(download))
        .route("/uploads/:filename", get(serve_upload))
        .nest("/api/admin", admin::router())
        .fallback(serve_asset)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    let _ = ready.send(port);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
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
    mut multipart: Multipart,
) -> Result<Json<FileInfo>, (StatusCode, String)> {
    let max_bytes = {
        let cfg = state.config.read().unwrap();
        cfg.max_upload_mb.saturating_mul(1024 * 1024)
    };

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

async fn serve_asset(uri: Uri) -> impl IntoResponse {
    let mut p = uri.path().trim_start_matches('/').to_string();
    if p.is_empty() {
        p = "index.html".into();
    }
    // Admin path convenience: /admin → admin.html
    if p == "admin" || p == "admin/" {
        p = "admin.html".into();
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

// Re-export for admin module.
#[derive(Serialize)]
pub struct AssetMeta {
    pub name: CompactString,
    pub bytes: u64,
}
