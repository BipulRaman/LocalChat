//! Wire message envelope. One schema for lobby, groups, and DMs.

use compact_str::CompactString;
use serde::{Deserialize, Serialize};

use crate::user::UserId;

pub type ChannelId = CompactString;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MsgKind {
    Text,
    File,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub id: CompactString,
    #[serde(rename = "originalName")]
    pub original_name: String,
    pub filename: CompactString,
    pub size: u64,
    #[serde(rename = "mimeType")]
    pub mime_type: CompactString,
    pub url: CompactString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMsg {
    pub id: u64,
    pub channel: ChannelId,
    pub kind: MsgKind,
    #[serde(rename = "userId", default)]
    pub user_id: UserId,
    #[serde(default)]
    pub username: CompactString,
    #[serde(default)]
    pub avatar: CompactString,
    #[serde(default)]
    pub color: CompactString,
    /// Unix seconds
    pub ts: u64,

    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileInfo>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "replyTo")]
    pub reply_to: Option<u64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<u64>,

    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
