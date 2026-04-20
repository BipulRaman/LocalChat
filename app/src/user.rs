//! Users: lightweight records, addressed by stable UUID strings.
//!
//! Using a server-issued UUID (instead of a sequential u32) means a
//! returning client can present its old id from localStorage and the
//! server can match it against the persisted pubkey to refuse
//! impersonation. UUIDs are also unguessable, so a malicious peer
//! can't forge a `userId` field on the wire and pretend to be user #5.

use compact_str::CompactString;
use serde::{Deserialize, Serialize};

/// Server-issued, opaque, stable per-user identifier. Generated as
/// `uuid::Uuid::new_v4().simple()` (32 hex chars, no dashes) on first
/// join and persisted in the `users` table forever. Clients echo it
/// back on every reconnect.
pub type UserId = CompactString;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: UserId,
    pub username: CompactString,
    pub avatar: CompactString, // emoji or single letter
    pub color: CompactString,  // hex "#rrggbb"
    pub joined_at: u64,        // seconds since UNIX epoch — first ever join
    #[serde(skip)]
    pub ip: CompactString,     // IP of the *current* live socket (presence)
    #[serde(default)]
    pub msg_count: u64,
    #[serde(default)]
    pub bytes_uploaded: u64,
    /// E2EE public key (JSON Web Key as a string). Empty = no E2EE support.
    /// Server never touches this; it just relays it so peers can encrypt DMs.
    #[serde(default)]
    pub pubkey: CompactString,
    /// IP address used on the most recent connection (persisted, survives
    /// restarts so the admin page can show "last seen from …" for offline
    /// users).
    #[serde(default)]
    pub last_ip: CompactString,
    /// Unix seconds of the most recent disconnect. 0 if the user has
    /// never disconnected since first joining (i.e. is currently online
    /// and has never had a session end yet).
    #[serde(default)]
    pub last_seen: u64,
    /// Unix seconds of the most recent successful connection. Used by the
    /// admin page to show "online since" for live users.
    #[serde(default)]
    pub last_connect: u64,
    /// Total number of WebSocket sessions this user has ever opened.
    #[serde(default)]
    pub total_sessions: u64,
}
