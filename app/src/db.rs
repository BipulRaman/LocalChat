//! SQLite-backed persistence layer.
//!
//! One file: `<app_root>/localchat.db` (WAL mode). Owns the source of
//! truth for everything except raw upload bytes (those stay on disk in
//! `<app_root>/uploads/`). Every callsite that needs to read or mutate
//! durable state goes through this module.
//!
//! Threading: rusqlite is synchronous, so every public method is `async`
//! and offloads its work via `tokio::task::spawn_blocking`. The single
//! shared `Connection` is wrapped in a `Mutex`. SQLite WAL mode lets us
//! treat this as "many readers, one writer", and our LAN scale (a
//! handful of concurrent users) doesn't need anything fancier.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use compact_str::{CompactString, ToCompactString};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::channel::{ChannelKind, ChannelMeta};
use crate::message::{ChannelId, FileInfo, MsgKind, WireMsg};
use crate::user::{UserId, UserInfo};

/// Bumped whenever the schema changes incompatibly. Stored under
/// `schema_meta(key='version')`.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    username        TEXT    NOT NULL,
    username_lower  TEXT    NOT NULL UNIQUE,
    avatar          TEXT    NOT NULL DEFAULT '',
    color           TEXT    NOT NULL DEFAULT '',
    pubkey          TEXT    NOT NULL DEFAULT '',
    joined_at       INTEGER NOT NULL,
    last_connect    INTEGER NOT NULL DEFAULT 0,
    last_seen       INTEGER NOT NULL DEFAULT 0,
    last_ip         TEXT    NOT NULL DEFAULT '',
    total_sessions  INTEGER NOT NULL DEFAULT 0,
    msg_count       INTEGER NOT NULL DEFAULT 0,
    bytes_uploaded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_last_connect ON users(last_connect DESC);

CREATE TABLE IF NOT EXISTS channels (
    id          TEXT    PRIMARY KEY,
    kind        TEXT    NOT NULL CHECK (kind IN ('lobby','group','dm')),
    name        TEXT    NOT NULL DEFAULT '',
    is_private  INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    dm_user_a   TEXT,
    dm_user_b   TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(kind);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id  TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    channel_id  TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username    TEXT    NOT NULL DEFAULT '',
    avatar      TEXT    NOT NULL DEFAULT '',
    color       TEXT    NOT NULL DEFAULT '',
    kind        TEXT    NOT NULL CHECK (kind IN ('text','file','system')),
    ts          INTEGER NOT NULL,
    text        TEXT    NOT NULL DEFAULT '',
    reply_to    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at   INTEGER,
    deleted     INTEGER NOT NULL DEFAULT 0,
    file_id     TEXT,
    file_name   TEXT,
    file_size   INTEGER,
    file_mime   TEXT,
    file_url    TEXT,
    -- Client-supplied dedupe id (UUID). Lets the upload endpoint
    -- short-circuit replays of the same logical post without
    -- inserting a second message row.
    client_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user       ON messages(user_id);
-- Note: idx_messages_client_id is created in the migration block
-- in Db::open() so it can run *after* the ALTER TABLE that adds the
-- column on legacy installs.

CREATE TABLE IF NOT EXISTS reactions (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji       TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

-- Reactions are also append-logged so toggle history can be audited.
CREATE TABLE IF NOT EXISTS reaction_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    message_id  INTEGER NOT NULL,
    channel_id  TEXT    NOT NULL,
    user_id     INTEGER NOT NULL,
    emoji       TEXT    NOT NULL,
    on_         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reaction_events_msg ON reaction_events(message_id);

-- Connect/disconnect audit. Deliberately no FK on user_id: audit
-- entries must outlive the user row (e.g. after a flush_users).
CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    event       TEXT    NOT NULL CHECK (event IN ('connect','disconnect')),
    user_id     INTEGER NOT NULL,
    username    TEXT    NOT NULL,
    ip          TEXT    NOT NULL DEFAULT '',
    user_agent  TEXT    NOT NULL DEFAULT '',
    duration    INTEGER,
    sockets     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_events_user ON session_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_ts   ON session_events(ts DESC);

CREATE TABLE IF NOT EXISTS bans (
    kind     TEXT NOT NULL CHECK (kind IN ('user','ip')),
    value    TEXT NOT NULL,
    reason   TEXT NOT NULL DEFAULT '',
    created  INTEGER NOT NULL,
    PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS uploads (
    storage_name  TEXT    PRIMARY KEY,
    original_name TEXT    NOT NULL,
    mime          TEXT    NOT NULL DEFAULT '',
    size          INTEGER NOT NULL,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_by_name TEXT NOT NULL DEFAULT '',
    uploaded_at   INTEGER NOT NULL,
    message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_uploads_when ON uploads(uploaded_at DESC);

-- Generic admin audit: kicks, bans, broadcasts, resets. Pure history.
CREATE TABLE IF NOT EXISTS admin_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    action    TEXT    NOT NULL,
    actor_ip  TEXT    NOT NULL DEFAULT '',
    target    TEXT    NOT NULL DEFAULT '',
    details   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_events_ts ON admin_events(ts DESC);
"#;

#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
    pub path: PathBuf,
}

// ──────────────────────────────────────────────────────────────────────
// Construction
// ──────────────────────────────────────────────────────────────────────

impl Db {
    /// Open (or create) `<app_root>/localchat.db`, apply pragmas, and run
    /// the schema. Idempotent — safe to call on every boot. Returns
    /// `(db, server_id)` where `server_id` is a stable UUID stamped into
    /// `schema_meta` on first creation. The id never changes for the
    /// lifetime of this DB file, so clients can use it to namespace
    /// per-server localStorage.
    pub async fn open(app_root: &Path) -> rusqlite::Result<(Self, String)> {
        let path = app_root.join("localchat.db");
        let p = path.clone();
        let (conn, server_id) = tokio::task::spawn_blocking(move || -> rusqlite::Result<(Connection, String)> {
            let conn = Connection::open(&p)?;
            // Pragmas applied in the order rusqlite recommends.
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            conn.pragma_update(None, "temp_store", "MEMORY")?;
            conn.pragma_update(None, "busy_timeout", 5000_i64)?;
            conn.execute_batch(SCHEMA_SQL)?;
            // Lightweight in-place migration: add columns we now need
            // on existing DBs without bumping SCHEMA_VERSION (the
            // create-table SQL above already includes them, but
            // older installs won't have re-run it).
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN client_id TEXT", []);
            let _ = conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_id) WHERE client_id IS NOT NULL",
                [],
            );
            // Stamp the schema version so future migrations can branch.
            conn.execute(
                "INSERT INTO schema_meta(key,value) VALUES('version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![SCHEMA_VERSION.to_string()],
            )?;
            // Stamp a stable server id on first creation. Used by the
            // browser client to namespace localStorage so settings from
            // a different LocalChat database / install never bleed in.
            let existing: Option<String> = conn
                .query_row(
                    "SELECT value FROM schema_meta WHERE key='server_id'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let server_id = match existing {
                Some(s) if !s.is_empty() => s,
                _ => {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO schema_meta(key,value) VALUES('server_id', ?1)
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![new_id],
                    )?;
                    new_id
                }
            };
            Ok((conn, server_id))
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))??;

        Ok((Self { inner: Arc::new(Mutex::new(conn)), path }, server_id))
    }

    /// Run a closure with the locked connection on a blocking thread.
    /// Most public methods are thin wrappers around this.
    async fn with<F, T>(&self, f: F) -> rusqlite::Result<T>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let mut guard = inner.blocking_lock();
            f(&mut *guard)
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?
    }
}

// ──────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────

impl Db {
    /// Look up a user by case-insensitive username. Returns None if the
    /// name has never been seen on this server.
    pub async fn user_by_username(&self, username: &str) -> rusqlite::Result<Option<UserInfo>> {
        let lname = username.to_lowercase();
        self.with(move |c| {
            c.query_row(
                "SELECT id, username, avatar, color, pubkey, joined_at,
                        last_connect, last_seen, last_ip,
                        total_sessions, msg_count, bytes_uploaded
                   FROM users WHERE username_lower = ?1",
                params![lname],
                row_to_user,
            )
            .optional()
        })
        .await
    }

    pub async fn user_by_id(&self, id: UserId) -> rusqlite::Result<Option<UserInfo>> {
        self.with(move |c| {
            c.query_row(
                "SELECT id, username, avatar, color, pubkey, joined_at,
                        last_connect, last_seen, last_ip,
                        total_sessions, msg_count, bytes_uploaded
                   FROM users WHERE id = ?1",
                params![id],
                row_to_user,
            )
            .optional()
        })
        .await
    }

    /// Insert a brand-new user. Caller already verified the username
    /// isn't taken (or `user_by_username` returned None).
    pub async fn create_user(&self, info: &UserInfo) -> rusqlite::Result<()> {
        let i = info.clone();
        self.with(move |c| {
            c.execute(
                "INSERT INTO users(
                    id, username, username_lower, avatar, color, pubkey,
                    joined_at, last_connect, last_seen, last_ip,
                    total_sessions, msg_count, bytes_uploaded
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    i.id,
                    i.username.as_str(),
                    i.username.to_lowercase().to_string(),
                    i.avatar.as_str(),
                    i.color.as_str(),
                    i.pubkey.as_str(),
                    i.joined_at as i64,
                    i.last_connect as i64,
                    i.last_seen as i64,
                    i.last_ip.as_str(),
                    i.total_sessions as i64,
                    i.msg_count as i64,
                    i.bytes_uploaded as i64,
                ],
            )?;
            Ok(())
        })
        .await
    }

    /// Mark a user as currently connecting. Bumps total_sessions, sets
    /// last_connect/last_ip, optionally updates avatar/color/pubkey if
    /// the client supplied them.
    pub async fn touch_user_on_connect(
        &self,
        id: UserId,
        avatar: &str,
        color: &str,
        pubkey: &str,
        ip: &str,
        ts: u64,
    ) -> rusqlite::Result<()> {
        let avatar = avatar.to_string();
        let color = color.to_string();
        let pubkey = pubkey.to_string();
        let ip = ip.to_string();
        self.with(move |c| {
            c.execute(
                "UPDATE users
                    SET avatar       = CASE WHEN ?2 <> '' THEN ?2 ELSE avatar END,
                        color        = CASE WHEN ?3 <> '' THEN ?3 ELSE color END,
                        pubkey       = CASE WHEN ?4 <> '' THEN ?4 ELSE pubkey END,
                        last_connect = ?5,
                        last_ip      = ?6,
                        total_sessions = total_sessions + 1
                  WHERE id = ?1",
                params![id, avatar, color, pubkey, ts as i64, ip],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn update_user_on_disconnect(
        &self,
        id: UserId,
        ip: &str,
        ts: u64,
    ) -> rusqlite::Result<()> {
        let ip = ip.to_string();
        self.with(move |c| {
            c.execute(
                "UPDATE users SET last_seen = ?2, last_ip = ?3 WHERE id = ?1",
                params![id, ts as i64, ip],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn bump_user_msg_count(&self, id: UserId) -> rusqlite::Result<()> {
        self.with(move |c| {
            c.execute("UPDATE users SET msg_count = msg_count + 1 WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
    }

    pub async fn bump_user_uploaded(&self, id: UserId, bytes: u64) -> rusqlite::Result<()> {
        self.with(move |c| {
            c.execute(
                "UPDATE users SET bytes_uploaded = bytes_uploaded + ?2 WHERE id = ?1",
                params![id, bytes as i64],
            )?;
            Ok(())
        })
        .await
    }

    /// Fetch every user record. Used at boot to hydrate the in-memory
    /// `known_users` map and on every admin /users request.
    pub async fn list_users(&self) -> rusqlite::Result<Vec<UserInfo>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, username, avatar, color, pubkey, joined_at,
                        last_connect, last_seen, last_ip,
                        total_sessions, msg_count, bytes_uploaded
                   FROM users ORDER BY id",
            )?;
            let rows = stmt.query_map([], row_to_user)?;
            let mut out = Vec::new();
            for r in rows { out.push(r?); }
            Ok(out)
        })
        .await
    }

    /// Return the next free user id. SQLite assigns it for us by using
    /// `MAX(id)+1`; cheap because `id` is the primary key.
    pub async fn next_user_id(&self) -> rusqlite::Result<UserId> {
        self.with(|c| {
            let id: Option<i64> = c
                .query_row("SELECT COALESCE(MAX(id), 0) FROM users", [], |r| r.get(0))
                .optional()?
                .flatten();
            Ok((id.unwrap_or(0) as u32) + 1)
        })
        .await
    }

    pub async fn delete_user(&self, id: UserId) -> rusqlite::Result<()> {
        self.with(move |c| {
            c.execute("DELETE FROM users WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
    }
}

fn row_to_user(r: &rusqlite::Row<'_>) -> rusqlite::Result<UserInfo> {
    Ok(UserInfo {
        id: r.get::<_, i64>(0)? as u32,
        username: r.get::<_, String>(1)?.to_compact_string(),
        avatar: r.get::<_, String>(3)?.to_compact_string(),
        color: r.get::<_, String>(4)?.to_compact_string(),
        joined_at: r.get::<_, i64>(6)? as u64,
        ip: CompactString::const_new(""),
        msg_count: r.get::<_, i64>(11)? as u64,
        bytes_uploaded: r.get::<_, i64>(12)? as u64,
        pubkey: r.get::<_, String>(5)?.to_compact_string(),
        last_ip: r.get::<_, String>(9)?.to_compact_string(),
        last_seen: r.get::<_, i64>(8)? as u64,
        last_connect: r.get::<_, i64>(7)? as u64,
        total_sessions: r.get::<_, i64>(10)? as u64,
    })
}

// ──────────────────────────────────────────────────────────────────────
// Channels & members
// ──────────────────────────────────────────────────────────────────────

impl Db {
    pub async fn upsert_channel(&self, m: &ChannelMeta) -> rusqlite::Result<()> {
        let m = m.clone();
        self.with(move |c| {
            let kind = match m.kind {
                ChannelKind::Lobby => "lobby",
                ChannelKind::Group => "group",
                ChannelKind::Dm    => "dm",
            };
            let (dm_a, dm_b) = match &m.dm_users {
                Some(arr) => (Some(arr[0].to_string()), Some(arr[1].to_string())),
                None => (None, None),
            };
            c.execute(
                "INSERT INTO channels(id, kind, name, is_private, created_by, created_at, dm_user_a, dm_user_b)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    name       = excluded.name,
                    is_private = excluded.is_private,
                    dm_user_a  = excluded.dm_user_a,
                    dm_user_b  = excluded.dm_user_b",
                params![
                    m.id.as_str(),
                    kind,
                    m.name.as_str(),
                    m.is_private as i64,
                    // created_by is a FK to users(id); the lobby (and any
                    // system-created channel) carries 0 here, so coerce
                    // that to NULL to satisfy the foreign key.
                    if m.created_by == 0 { None } else { Some(m.created_by) },
                    m.created_at as i64,
                    dm_a,
                    dm_b,
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn delete_channel(&self, id: &str) -> rusqlite::Result<()> {
        let id = id.to_string();
        self.with(move |c| {
            c.execute("DELETE FROM channels WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
    }

    pub async fn list_channels(&self) -> rusqlite::Result<Vec<ChannelMeta>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, kind, name, is_private, created_by, created_at, dm_user_a, dm_user_b
                   FROM channels",
            )?;
            let rows = stmt.query_map([], row_to_channel)?;
            let mut out: Vec<ChannelMeta> = Vec::new();
            for r in rows { out.push(r?); }
            // Members live in a separate table; load them in one sweep.
            let mut mstmt = c.prepare(
                "SELECT channel_id, user_id FROM channel_members ORDER BY channel_id",
            )?;
            let mut by_chan: std::collections::HashMap<String, Vec<UserId>> =
                std::collections::HashMap::new();
            let mrows = mstmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
            })?;
            for row in mrows {
                let (cid, uid) = row?;
                by_chan.entry(cid).or_default().push(uid);
            }
            for ch in &mut out {
                if let Some(v) = by_chan.remove(ch.id.as_str()) {
                    ch.members = v;
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn add_member(&self, channel_id: &str, user_id: UserId, ts: u64) -> rusqlite::Result<()> {
        let cid = channel_id.to_string();
        self.with(move |c| {
            c.execute(
                "INSERT OR IGNORE INTO channel_members(channel_id, user_id, joined_at)
                 VALUES (?1, ?2, ?3)",
                params![cid, user_id, ts as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn remove_member(&self, channel_id: &str, user_id: UserId) -> rusqlite::Result<()> {
        let cid = channel_id.to_string();
        self.with(move |c| {
            c.execute(
                "DELETE FROM channel_members WHERE channel_id = ?1 AND user_id = ?2",
                params![cid, user_id],
            )?;
            Ok(())
        })
        .await
    }
}

fn row_to_channel(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChannelMeta> {
    let kind = match r.get::<_, String>(1)?.as_str() {
        "lobby" => ChannelKind::Lobby,
        "dm"    => ChannelKind::Dm,
        _       => ChannelKind::Group,
    };
    let dm_a: Option<String> = r.get(6)?;
    let dm_b: Option<String> = r.get(7)?;
    let dm_users = match (dm_a, dm_b) {
        (Some(a), Some(b)) => Some([a.to_compact_string(), b.to_compact_string()]),
        _ => None,
    };
    Ok(ChannelMeta {
        id: r.get::<_, String>(0)?.to_compact_string(),
        kind,
        name: r.get::<_, String>(2)?.to_compact_string(),
        is_private: r.get::<_, i64>(3)? != 0,
        members: Vec::new(),
        created_by: r.get::<_, i64>(4).unwrap_or(0) as u32,
        created_at: r.get::<_, i64>(5)? as u64,
        dm_users,
    })
}

// ──────────────────────────────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────────────────────────────

impl Db {
    /// Returns the existing message id for a given file_id (used so the
    /// server can dedupe replayed `op:"file"` operations after a client
    /// refresh during an upload).
    pub async fn message_id_for_file(&self, file_id: &str) -> rusqlite::Result<Option<u64>> {
        let fid = file_id.to_string();
        self.with(move |c| {
            let v: Option<i64> = c
                .query_row(
                    "SELECT id FROM messages WHERE file_id = ?1 LIMIT 1",
                    params![fid],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(v.map(|x| x as u64))
        })
        .await
    }

    /// Look up a message by client-supplied dedupe id.
    pub async fn message_id_for_client_id(&self, client_id: &str) -> rusqlite::Result<Option<u64>> {
        let cid = client_id.to_string();
        self.with(move |c| {
            let v: Option<i64> = c
                .query_row(
                    "SELECT id FROM messages WHERE client_id = ?1 LIMIT 1",
                    params![cid],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(v.map(|x| x as u64))
        })
        .await
    }

    /// Stamp a previously-inserted message with its client dedupe id.
    pub async fn set_message_client_id(&self, msg_id: u64, client_id: &str) -> rusqlite::Result<()> {
        let cid = client_id.to_string();
        self.with(move |c| {
            c.execute(
                "UPDATE messages SET client_id = ?1 WHERE id = ?2",
                params![cid, msg_id as i64],
            )?;
            Ok(())
        })
        .await
    }

    /// Insert a message. Returns nothing — `msg.id` is the caller-chosen
    /// monotonic id (kept that way so the in-memory broadcast bus stays
    /// fast: we don't need to round-trip the DB to learn the id).
    pub async fn insert_message(&self, msg: &WireMsg) -> rusqlite::Result<()> {
        let m = msg.clone();
        self.with(move |c| {
            let kind = msg_kind_str(m.kind);
            let (fid, fname, fsize, fmime, furl) = match &m.file {
                Some(f) => (
                    Some(f.id.to_string()),
                    Some(f.original_name.clone()),
                    Some(f.size as i64),
                    Some(f.mime_type.to_string()),
                    Some(f.url.to_string()),
                ),
                None => (None, None, None, None, None),
            };
            c.execute(
                "INSERT INTO messages(
                    id, channel_id, user_id, username, avatar, color,
                    kind, ts, text, reply_to, edited_at, deleted,
                    file_id, file_name, file_size, file_mime, file_url
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    m.id as i64,
                    m.channel.as_str(),
                    if m.user_id == 0 { None } else { Some(m.user_id) },
                    m.username.as_str(),
                    m.avatar.as_str(),
                    m.color.as_str(),
                    kind,
                    m.ts as i64,
                    m.text,
                    m.reply_to.map(|x| x as i64),
                    m.edited_at.map(|x| x as i64),
                    m.deleted as i64,
                    fid, fname, fsize, fmime, furl,
                ],
            )?;
            Ok(())
        })
        .await
    }

    /// Last `limit` messages of a channel, oldest → newest.
    pub async fn tail_messages(&self, channel: &str, limit: usize) -> rusqlite::Result<Vec<WireMsg>> {
        let cid = channel.to_string();
        self.with(move |c| {
            // Pull newest first, then reverse — keeps the index hit clean.
            let mut stmt = c.prepare(
                "SELECT id, channel_id, user_id, username, avatar, color,
                        kind, ts, text, reply_to, edited_at, deleted,
                        file_id, file_name, file_size, file_mime, file_url
                   FROM messages
                  WHERE channel_id = ?1
                  ORDER BY id DESC
                  LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![cid, limit as i64], row_to_message)?;
            let mut out: Vec<WireMsg> = Vec::with_capacity(limit);
            for r in rows { out.push(r?); }
            out.reverse();
            Ok(out)
        })
        .await
    }

    /// Highest message id ever assigned. Used at boot to seed the
    /// monotonic counter.
    pub async fn max_message_id(&self) -> rusqlite::Result<u64> {
        self.with(|c| {
            let v: Option<i64> = c
                .query_row("SELECT MAX(id) FROM messages", [], |r| r.get(0))
                .optional()?
                .flatten();
            Ok(v.unwrap_or(0) as u64)
        })
        .await
    }

    pub async fn delete_messages_in_channel(&self, channel: &str) -> rusqlite::Result<()> {
        let cid = channel.to_string();
        self.with(move |c| {
            c.execute("DELETE FROM messages WHERE channel_id = ?1", params![cid])?;
            Ok(())
        })
        .await
    }
}

fn msg_kind_str(k: MsgKind) -> &'static str {
    match k {
        MsgKind::Text   => "text",
        MsgKind::File   => "file",
        MsgKind::System => "system",
    }
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<WireMsg> {
    let kind = match r.get::<_, String>(6)?.as_str() {
        "file"   => MsgKind::File,
        "system" => MsgKind::System,
        _        => MsgKind::Text,
    };
    let file = match (
        r.get::<_, Option<String>>(12)?,
        r.get::<_, Option<String>>(13)?,
        r.get::<_, Option<i64>>(14)?,
        r.get::<_, Option<String>>(15)?,
        r.get::<_, Option<String>>(16)?,
    ) {
        (Some(id), Some(name), Some(size), Some(mime), Some(url)) => Some(FileInfo {
            id: id.to_compact_string(),
            original_name: name,
            filename: url.rsplit('/').next().unwrap_or("").to_compact_string(),
            size: size as u64,
            mime_type: mime.to_compact_string(),
            url: url.to_compact_string(),
        }),
        _ => None,
    };
    Ok(WireMsg {
        id: r.get::<_, i64>(0)? as u64,
        channel: r.get::<_, String>(1)?.to_compact_string(),
        kind,
        user_id: r.get::<_, Option<i64>>(2)?.map(|v| v as u32).unwrap_or(0),
        username: r.get::<_, String>(3)?.to_compact_string(),
        avatar: r.get::<_, String>(4)?.to_compact_string(),
        color: r.get::<_, String>(5)?.to_compact_string(),
        ts: r.get::<_, i64>(7)? as u64,
        text: r.get::<_, String>(8)?,
        file,
        reply_to: r.get::<_, Option<i64>>(9)?.map(|v| v as u64),
        edited_at: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        deleted: r.get::<_, i64>(11)? != 0,
    })
}

// ──────────────────────────────────────────────────────────────────────
// Reactions
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ReactionRow {
    pub channel_id: ChannelId,
    pub message_id: u64,
    pub user_id: UserId,
    pub emoji: CompactString,
}

impl Db {
    /// Toggle a reaction. Returns true if it ended up "on" (added).
    pub async fn toggle_reaction(
        &self,
        channel: &str,
        message_id: u64,
        user_id: UserId,
        emoji: &str,
        ts: u64,
    ) -> rusqlite::Result<bool> {
        let cid = channel.to_string();
        let emoji_s = emoji.to_string();
        self.with(move |c| {
            let tx = c.transaction()?;
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM reactions
                      WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
                    params![message_id as i64, user_id, emoji_s],
                    |r| r.get(0),
                )
                .optional()?;
            let now_on;
            if exists.is_some() {
                tx.execute(
                    "DELETE FROM reactions
                      WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
                    params![message_id as i64, user_id, emoji_s],
                )?;
                now_on = false;
            } else {
                tx.execute(
                    "INSERT INTO reactions(message_id, user_id, emoji, ts)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![message_id as i64, user_id, emoji_s, ts as i64],
                )?;
                now_on = true;
            }
            tx.execute(
                "INSERT INTO reaction_events(ts, message_id, channel_id, user_id, emoji, on_)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    ts as i64,
                    message_id as i64,
                    cid,
                    user_id,
                    emoji_s,
                    now_on as i64,
                ],
            )?;
            tx.commit()?;
            Ok(now_on)
        })
        .await
    }

    /// All current reactions across every channel. Loaded once at boot
    /// to populate the in-memory map that `ws.rs` consults when sending
    /// history payloads.
    pub async fn all_reactions(&self) -> rusqlite::Result<Vec<ReactionRow>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT m.channel_id, r.message_id, r.user_id, r.emoji
                   FROM reactions r
                   JOIN messages m ON m.id = r.message_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(ReactionRow {
                    channel_id: r.get::<_, String>(0)?.to_compact_string(),
                    message_id: r.get::<_, i64>(1)? as u64,
                    user_id: r.get::<_, i64>(2)? as u32,
                    emoji: r.get::<_, String>(3)?.to_compact_string(),
                })
            })?;
            let mut out = Vec::new();
            for r in rows { out.push(r?); }
            Ok(out)
        })
        .await
    }
}

// ──────────────────────────────────────────────────────────────────────
// Sessions audit
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEventRow {
    pub id: i64,
    pub ts: u64,
    pub event: String,
    #[serde(rename = "userId")]
    pub user_id: u32,
    pub username: String,
    pub ip: String,
    #[serde(rename = "userAgent", default, skip_serializing_if = "String::is_empty")]
    pub user_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sockets: Option<u32>,
}

impl Db {
    pub async fn append_session_event(
        &self,
        event: &str,
        user_id: UserId,
        username: &str,
        ip: &str,
        user_agent: &str,
        ts: u64,
        duration: Option<u64>,
        sockets: Option<u32>,
    ) -> rusqlite::Result<()> {
        let event = event.to_string();
        let username = username.to_string();
        let ip = ip.to_string();
        let ua = user_agent.to_string();
        self.with(move |c| {
            c.execute(
                "INSERT INTO session_events(ts, event, user_id, username, ip, user_agent, duration, sockets)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    ts as i64,
                    event,
                    user_id,
                    username,
                    ip,
                    ua,
                    duration.map(|d| d as i64),
                    sockets.map(|s| s as i64),
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn tail_session_events(&self, limit: usize) -> rusqlite::Result<Vec<SessionEventRow>> {
        self.with(move |c| {
            let mut stmt = c.prepare(
                "SELECT id, ts, event, user_id, username, ip, user_agent, duration, sockets
                   FROM session_events ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |r| {
                Ok(SessionEventRow {
                    id: r.get(0)?,
                    ts: r.get::<_, i64>(1)? as u64,
                    event: r.get(2)?,
                    user_id: r.get::<_, i64>(3)? as u32,
                    username: r.get(4)?,
                    ip: r.get(5)?,
                    user_agent: r.get(6)?,
                    duration: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
                    sockets: r.get::<_, Option<i64>>(8)?.map(|v| v as u32),
                })
            })?;
            let mut out: Vec<SessionEventRow> = Vec::new();
            for r in rows { out.push(r?); }
            // Reverse so callers get oldest → newest, like the old log.
            out.reverse();
            Ok(out)
        })
        .await
    }
}

// ──────────────────────────────────────────────────────────────────────
// Bans
// ──────────────────────────────────────────────────────────────────────

impl Db {
    pub async fn add_ban(&self, kind: &str, value: &str, reason: &str, ts: u64) -> rusqlite::Result<()> {
        let kind = kind.to_string();
        let value = value.to_string();
        let reason = reason.to_string();
        self.with(move |c| {
            c.execute(
                "INSERT OR IGNORE INTO bans(kind, value, reason, created)
                 VALUES (?1, ?2, ?3, ?4)",
                params![kind, value, reason, ts as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn remove_ban(&self, kind: &str, value: &str) -> rusqlite::Result<()> {
        let kind = kind.to_string();
        let value = value.to_string();
        self.with(move |c| {
            c.execute("DELETE FROM bans WHERE kind = ?1 AND value = ?2", params![kind, value])?;
            Ok(())
        })
        .await
    }

    pub async fn list_bans(&self) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT kind, value FROM bans")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut users = Vec::new();
            let mut ips = Vec::new();
            for row in rows {
                let (k, v) = row?;
                if k == "user" { users.push(v); } else if k == "ip" { ips.push(v); }
            }
            Ok((users, ips))
        })
        .await
    }
}

// ──────────────────────────────────────────────────────────────────────
// Uploads
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct UploadRow {
    #[serde(rename = "name")]
    pub storage_name: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    pub mime: String,
    pub size: u64,
    #[serde(rename = "uploadedBy", skip_serializing_if = "Option::is_none")]
    pub uploaded_by: Option<u32>,
    #[serde(rename = "uploadedByName")]
    pub uploaded_by_name: String,
    #[serde(rename = "uploadedAt")]
    pub uploaded_at: u64,
}

impl Db {
    pub async fn insert_upload(
        &self,
        storage_name: &str,
        original_name: &str,
        mime: &str,
        size: u64,
        uploaded_by: Option<UserId>,
        uploaded_by_name: &str,
        ts: u64,
    ) -> rusqlite::Result<()> {
        let storage_name = storage_name.to_string();
        let original_name = original_name.to_string();
        let mime = mime.to_string();
        let by_name = uploaded_by_name.to_string();
        self.with(move |c| {
            c.execute(
                "INSERT OR REPLACE INTO uploads(
                    storage_name, original_name, mime, size,
                    uploaded_by, uploaded_by_name, uploaded_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![storage_name, original_name, mime, size as i64,
                        uploaded_by, by_name, ts as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn delete_upload(&self, storage_name: &str) -> rusqlite::Result<()> {
        let n = storage_name.to_string();
        self.with(move |c| {
            c.execute("DELETE FROM uploads WHERE storage_name = ?1", params![n])?;
            Ok(())
        })
        .await
    }

    pub async fn list_uploads(&self) -> rusqlite::Result<Vec<UploadRow>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT storage_name, original_name, mime, size,
                        uploaded_by, uploaded_by_name, uploaded_at
                   FROM uploads ORDER BY uploaded_at DESC",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(UploadRow {
                    storage_name:    r.get(0)?,
                    original_name:   r.get(1)?,
                    mime:            r.get(2)?,
                    size:            r.get::<_, i64>(3)? as u64,
                    uploaded_by:     r.get::<_, Option<i64>>(4)?.map(|v| v as u32),
                    uploaded_by_name: r.get(5)?,
                    uploaded_at:     r.get::<_, i64>(6)? as u64,
                })
            })?;
            let mut out: Vec<UploadRow> = Vec::new();
            for r in rows { out.push(r?); }
            Ok(out)
        })
        .await
    }
}

// ──────────────────────────────────────────────────────────────────────
// Admin events audit
// ──────────────────────────────────────────────────────────────────────

impl Db {
    pub async fn log_admin(
        &self,
        action: &str,
        actor_ip: &str,
        target: &str,
        details: &str,
    ) -> rusqlite::Result<()> {
        let action = action.to_string();
        let actor_ip = actor_ip.to_string();
        let target = target.to_string();
        let details = details.to_string();
        let ts = crate::message::now_secs();
        self.with(move |c| {
            c.execute(
                "INSERT INTO admin_events(ts, action, actor_ip, target, details)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![ts as i64, action, actor_ip, target, details],
            )?;
            Ok(())
        })
        .await
    }
}

// ──────────────────────────────────────────────────────────────────────
// Bulk reset operations
// ──────────────────────────────────────────────────────────────────────

impl Db {
    /// Wipe every user (and via FK cascade, their channel memberships).
    /// Session audit and admin audit are preserved on purpose.
    pub async fn flush_users(&self) -> rusqlite::Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            // channel_members has FK→users(ON DELETE CASCADE), so this
            // also clears memberships. Channels themselves stay.
            tx.execute("DELETE FROM users", [])?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    /// Wipe every channel except the lobby, and every message/reaction
    /// that belonged to them (cascade).
    pub async fn flush_channels(&self) -> rusqlite::Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM channels WHERE id != 'pub:general'", [])?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    /// Wipe every message and reaction. Channels and members survive.
    pub async fn flush_messages(&self) -> rusqlite::Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM messages", [])?;
            // reactions cascade from messages, but be explicit in case
            // a future schema ever changes that:
            tx.execute("DELETE FROM reactions", [])?;
            tx.execute("DELETE FROM reaction_events", [])?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    /// Wipe the connect/disconnect audit log without touching anything
    /// else. Used by reset endpoints after kicking sockets so any race-
    /// inserted rows from in-flight cleanup tasks are scrubbed too.
    pub async fn flush_session_events(&self) -> rusqlite::Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM session_events", [])?;
            Ok(())
        })
        .await
    }

    /// Master reset: wipes EVERYTHING (users, channels, messages,
    /// reactions, sessions, uploads metadata, admin audit). Bans are
    /// preserved on purpose so a reset doesn't unban anyone.
    pub async fn flush_all(&self) -> rusqlite::Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM uploads", [])?;
            tx.execute("DELETE FROM reactions", [])?;
            tx.execute("DELETE FROM reaction_events", [])?;
            tx.execute("DELETE FROM messages", [])?;
            tx.execute("DELETE FROM channel_members", [])?;
            tx.execute("DELETE FROM channels", [])?;
            tx.execute("DELETE FROM users", [])?;
            tx.execute("DELETE FROM session_events", [])?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
}
