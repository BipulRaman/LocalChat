//! Central shared state. Wrapped in `Arc<AppState>` and handed everywhere.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use dashmap::DashMap;

use crate::channel::ChannelRegistry;
use crate::config::Config;
use crate::message::ChannelId;
use crate::metrics::Metrics;
use crate::persist::{HistoryStore, ReactionLog};
use crate::user::{UserId, UserInfo};

pub type ReactionKey = (ChannelId, u64);
pub type EmojiKey = compact_str::CompactString;

pub struct AppState {
    pub app_root: PathBuf,   // OS app-data dir (e.g. %APPDATA%\LocalChat)
    pub uploads_dir: PathBuf,
    pub config_path: PathBuf,
    pub history_dir: PathBuf,
    pub logs_dir: PathBuf,

    pub config: RwLock<Config>,
    pub channels: ChannelRegistry,
    pub users: DashMap<UserId, UserInfo>,
    /// Maps username → user_id so reloading the page reuses the same ID
    /// (rather than incrementing the counter on every WS reconnect).
    /// Lives for the life of the process.
    pub username_to_id: DashMap<compact_str::CompactString, UserId>,
    pub history: HistoryStore,
    pub metrics: Metrics,

    /// Per-message reactions: (channel, msgId) -> emoji -> users that reacted.
    /// Backed by `reaction_log` (append-only JSONL), replayed on startup.
    pub reactions: DashMap<ReactionKey, DashMap<EmojiKey, Vec<UserId>>>,
    pub reaction_log: ReactionLog,

    pub next_user_id: AtomicU32,
    pub next_msg_id: AtomicU64,

    /// Actual port the server is listening on (set once after bind).
    pub bound_port: AtomicU16,
}

impl AppState {
    pub async fn bootstrap() -> std::io::Result<Arc<Self>> {
        let app_root = resolve_app_root();
        let uploads_dir = app_root.join("uploads");
        let history_dir = app_root.join("history");
        let logs_dir    = app_root.join("logs");
        let config_path = app_root.join("config.json");

        let _ = std::fs::create_dir_all(&app_root);
        let _ = std::fs::create_dir_all(&uploads_dir);
        let _ = std::fs::create_dir_all(&history_dir);
        let _ = std::fs::create_dir_all(&logs_dir);

        // Backward compatibility: migrate old layout (next-to-exe) into
        // the new app-data folder on first run.
        migrate_legacy_layout(&app_root, &config_path, &uploads_dir, &history_dir);

        let config = Config::load_or_init(&config_path)?;
        let history_cap = config.history_ram;
        let rotate_mb = config.rotate_mb;

        crate::applog::init(&logs_dir);
        crate::applog::log(format_args!(
            "bootstrap: app_root={}",
            app_root.display()
        ));

        let reaction_log = ReactionLog::new(&app_root);
        let prior_reactions = reaction_log.load_all().await;

        let state = Arc::new(Self {
            app_root,
            uploads_dir,
            config_path,
            history_dir: history_dir.clone(),
            logs_dir,
            config: RwLock::new(config),
            channels: ChannelRegistry::new(history_cap),
            users: DashMap::new(),
            username_to_id: DashMap::new(),
            history: HistoryStore::new(history_dir, rotate_mb),
            metrics: Metrics::default(),
            reactions: DashMap::new(),
            reaction_log,
            next_user_id: AtomicU32::new(1),
            next_msg_id: AtomicU64::new(1),
            bound_port: AtomicU16::new(0),
        });

        // Replay reaction events into the in-memory map.
        for ev in prior_reactions {
            let key = (
                compact_str::CompactString::from(ev.c.as_str()),
                ev.m,
            );
            let entry = state.reactions.entry(key.clone()).or_default();
            let mut users = entry.entry(
                compact_str::CompactString::from(ev.e.as_str()),
            ).or_default();
            let pos = users.iter().position(|u| *u == ev.u);
            if ev.on {
                if pos.is_none() { users.push(ev.u); }
            } else if let Some(p) = pos {
                users.swap_remove(p);
            }
            let emoji_empty = users.is_empty();
            drop(users);
            if emoji_empty {
                entry.remove(&compact_str::CompactString::from(ev.e.as_str()));
            }
            let entry_empty = entry.is_empty();
            drop(entry);
            if entry_empty {
                state.reactions.remove(&key);
            }
        }

        // Warm lobby history from disk so rejoins see prior messages.
        if let Some(lobby) = state.channels.get(crate::channel::LOBBY_ID) {
            let tail = state
                .history
                .tail(&lobby.id, state.channels.history_cap)
                .await;
            // Seed the in-RAM ring and bump next_msg_id past the max we saw.
            let mut max_id = 0;
            let mut ring = lobby.history.write().await;
            for m in tail {
                max_id = max_id.max(m.id);
                ring.push_back(m);
            }
            drop(ring);
            if max_id > 0 {
                state.next_msg_id.store(max_id + 1, Ordering::Relaxed);
            }
        }

        Ok(state)
    }

    pub fn next_msg_id(&self) -> u64 {
        self.next_msg_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn next_user_id(&self) -> UserId {
        self.next_user_id.fetch_add(1, Ordering::Relaxed)
    }
}

/// Where to put writable data.
///
/// Order of precedence:
///   1. `LOCALCHAT_HOME` env var (any dir).
///   2. OS app-data dir + `"LocalChat"`:
///        Windows : %APPDATA%\LocalChat
///        macOS   : ~/Library/Application Support/LocalChat
///        Linux   : ~/.local/share/LocalChat
///   3. Fallback: a `localchat-data/` folder next to the exe.
fn resolve_app_root() -> PathBuf {
    if let Ok(p) = std::env::var("LOCALCHAT_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(d) = dirs::data_dir() {
        return d.join("LocalChat");
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    exe_dir.join("localchat-data")
}

/// One-shot migration from the old layout (config + uploads/ + history/
/// next to the exe) into the new app-data root. Skipped if the new
/// config already exists.
fn migrate_legacy_layout(
    new_root: &std::path::Path,
    new_config: &std::path::Path,
    new_uploads: &std::path::Path,
    new_history: &std::path::Path,
) {
    if new_config.exists() {
        return;
    }
    let exe_dir = match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
    {
        Some(d) => d,
        None => return,
    };
    if exe_dir == new_root {
        return;
    }
    let old_cfg = exe_dir.join("localchat-config.json");
    if old_cfg.exists() {
        let _ = std::fs::copy(&old_cfg, new_config);
    }
    let old_uploads = exe_dir.join("uploads");
    if old_uploads.is_dir() {
        copy_dir_shallow(&old_uploads, new_uploads);
    }
    let old_history = exe_dir.join("history");
    if old_history.is_dir() {
        copy_dir_shallow(&old_history, new_history);
    }
}

fn copy_dir_shallow(src: &std::path::Path, dst: &std::path::Path) {
    let _ = std::fs::create_dir_all(dst);
    if let Ok(rd) = std::fs::read_dir(src) {
        for ent in rd.flatten() {
            if let Ok(m) = ent.metadata() {
                if m.is_file() {
                    let _ = std::fs::copy(ent.path(), dst.join(ent.file_name()));
                }
            }
        }
    }
}
