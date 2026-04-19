//! Central shared state. Wrapped in `Arc<AppState>` and handed everywhere.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
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

    /// Per-WS session tokens → user_id. Issued in the WS join op so
    /// HTTP endpoints (uploads) can identify the user without a
    /// separate cookie-based auth layer. Tokens live as long as the
    /// WS connection that created them.
    pub sessions: DashMap<compact_str::CompactString, UserId>,

    pub next_user_id: AtomicU32,
    pub next_msg_id: AtomicU64,

    pub bound_port: AtomicU16,

    pub kick_tx: tokio::sync::broadcast::Sender<KickSignal>,

    /// Set true while a factory/users reset is in progress so that
    /// the cleanup() path of kicked WS sockets skips writing fresh
    /// `disconnect` rows (and other per-user persistence) that would
    /// otherwise survive the DB flush as ghost audit entries.
    pub resetting: AtomicBool,
}

#[derive(Debug, Clone, Copy)]
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

        let _ = std::fs::create_dir_all(&app_root);
        let _ = std::fs::create_dir_all(&uploads_dir);
        let _ = std::fs::create_dir_all(&logs_dir);

        let mut config = Config::load_or_init(&config_path)?;
        let history_cap = config.history_ram;

        crate::applog::init(&logs_dir);
        crate::applog::log(format_args!("bootstrap: app_root={}", app_root.display()));

        let db = Db::open(&app_root)
            .await
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        crate::applog::log(format_args!("bootstrap: db ready at {}", db.path.display()));

        let known: Vec<UserInfo> = db.list_users().await.unwrap_or_default();
        let username_to_id: DashMap<compact_str::CompactString, UserId> = DashMap::new();
        let known_users: DashMap<UserId, UserInfo> = DashMap::new();
        for u in &known {
            username_to_id.insert(u.username.to_lowercase().to_compact_string(), u.id);
            known_users.insert(u.id, u.clone());
        }
        let next_user_id = db.next_user_id().await.unwrap_or(1).max(1);

        let channels = ChannelRegistry::new(history_cap);
        let prior_channels = db.list_channels().await.unwrap_or_default();
        channels.hydrate(prior_channels);
        if !channels.map.contains_key(LOBBY_ID) {
            let lobby = crate::channel::Channel::new(
                compact_str::CompactString::const_new(LOBBY_ID),
                ChannelKind::Lobby,
                compact_str::CompactString::const_new(LOBBY_NAME),
                false,
                0,
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
            sessions: DashMap::new(),
            next_user_id: AtomicU32::new(next_user_id),
            next_msg_id: AtomicU64::new(next_msg),
            bound_port: AtomicU16::new(0),
            kick_tx: tokio::sync::broadcast::channel(16).0,
            resetting: AtomicBool::new(false),
        }))
    }

    pub fn next_msg_id(&self) -> u64 {
        self.next_msg_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn next_user_id(&self) -> UserId {
        self.next_user_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn save_channel(&self, channel_id: &str) {
        if let Some(ch) = self.channels.get(channel_id) {
            let _ = self.db.upsert_channel(&ch.meta()).await;
        }
    }
}

fn resolve_app_root() -> PathBuf {
    // Explicit override wins.
    if let Ok(p) = std::env::var("LOCALCHAT_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // Prefer a folder next to the running exe. This avoids Windows
    // "Controlled Folder Access" (ransomware protection) blocking
    // writes into %APPDATA% for un-whitelisted binaries during
    // development, which otherwise silently drops DB inserts and
    // file uploads.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("localchat-data");
        }
    }
    if let Some(d) = dirs::data_dir() {
        return d.join("LocalChat");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("localchat-data")
}
