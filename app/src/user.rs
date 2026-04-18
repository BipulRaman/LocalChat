//! Users: lightweight records, addressed by numeric IDs.

use compact_str::CompactString;
use serde::{Deserialize, Serialize};

pub type UserId = u32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: UserId,
    pub username: CompactString,
    pub avatar: CompactString, // emoji or single letter
    pub color: CompactString,  // hex "#rrggbb"
    pub joined_at: u64,        // seconds since UNIX epoch
    #[serde(skip)]
    pub ip: CompactString,
    #[serde(default)]
    pub msg_count: u64,
    #[serde(default)]
    pub bytes_uploaded: u64,
    /// E2EE public key (JSON Web Key as a string). Empty = no E2EE support.
    /// Server never touches this; it just relays it so peers can encrypt DMs.
    #[serde(default)]
    pub pubkey: CompactString,
}
