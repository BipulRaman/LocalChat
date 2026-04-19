//! Channels: lobby, groups, DMs. Each owns its own broadcast bus.

use std::collections::VecDeque;
use std::sync::Arc;

use compact_str::{CompactString, ToCompactString};
use dashmap::{DashMap, DashSet};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};

use crate::message::{ChannelId, WireMsg};
use crate::user::UserId;

pub const LOBBY_ID: &str = "pub:general";
pub const LOBBY_NAME: &str = "general";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Lobby,
    Group,
    Dm,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChannelMeta {
    pub id: ChannelId,
    pub kind: ChannelKind,
    pub name: CompactString,
    #[serde(rename = "isPrivate")]
    pub is_private: bool,
    pub members: Vec<UserId>,
    #[serde(rename = "createdBy")]
    pub created_by: UserId,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "dmUsers", skip_serializing_if = "Option::is_none")]
    pub dm_users: Option<[CompactString; 2]>,
}

pub struct Channel {
    pub id: ChannelId,
    pub kind: ChannelKind,
    pub name: CompactString,
    pub is_private: bool,
    pub members: DashSet<UserId>,
    pub created_by: UserId,
    pub created_at: u64,
    pub tx: broadcast::Sender<Arc<WireMsg>>,
    pub history: RwLock<VecDeque<Arc<WireMsg>>>,
    pub history_cap: usize,
    /// For DM channels: the two participant usernames (lowercased, sorted).
    /// Used to re-bind a returning user's new ephemeral UserId on reconnect
    /// so DMs persist across page reloads.
    pub dm_users: Option<[CompactString; 2]>,
}

impl Channel {
    pub fn new(
        id: ChannelId,
        kind: ChannelKind,
        name: CompactString,
        is_private: bool,
        created_by: UserId,
        history_cap: usize,
    ) -> Self {
        // Buffer sized to absorb short subscriber lag without dropping.
        // Each slot is an Arc<WireMsg> (8 bytes), so 256 is cheap.
        let (tx, _) = broadcast::channel(256);
        Self {
            id,
            kind,
            name,
            is_private,
            members: DashSet::new(),
            created_by,
            created_at: crate::message::now_secs(),
            tx,
            history: RwLock::new(VecDeque::with_capacity(history_cap)),
            history_cap,
            dm_users: None,
        }
    }

    pub fn meta(&self) -> ChannelMeta {
        ChannelMeta {
            id: self.id.clone(),
            kind: self.kind,
            name: self.name.clone(),
            is_private: self.is_private,
            members: self.members.iter().map(|e| *e).collect(),
            created_by: self.created_by,
            created_at: self.created_at,
            dm_users: self.dm_users.clone(),
        }
    }

    pub async fn push_history(&self, msg: Arc<WireMsg>) {
        let mut h = self.history.write().await;
        if h.len() == self.history_cap {
            h.pop_front();
        }
        h.push_back(msg);
    }

    pub async fn recent(&self, limit: usize) -> Vec<Arc<WireMsg>> {
        let h = self.history.read().await;
        let start = h.len().saturating_sub(limit);
        h.iter().skip(start).cloned().collect()
    }
}

pub struct ChannelRegistry {
    pub map: DashMap<ChannelId, Arc<Channel>>,
    /// Per-user list of channels they belong to. Bounded inline for the
    /// common "few channels per user" case.
    pub user_channels: DashMap<UserId, smallvec::SmallVec<[ChannelId; 8]>>,
    pub history_cap: usize,
}

impl ChannelRegistry {
    pub fn new(history_cap: usize) -> Self {
        let this = Self {
            map: DashMap::new(),
            user_channels: DashMap::new(),
            history_cap,
        };
        let lobby = Channel::new(
            CompactString::const_new(LOBBY_ID),
            ChannelKind::Lobby,
            CompactString::const_new(LOBBY_NAME),
            false,
            0,
            history_cap,
        );
        this.map
            .insert(lobby.id.clone(), Arc::new(lobby));
        this
    }

    pub fn get(&self, id: &str) -> Option<Arc<Channel>> {
        self.map.get(id).map(|e| Arc::clone(e.value()))
    }

    pub fn create_group(
        &self,
        name: &str,
        is_private: bool,
        created_by: UserId,
    ) -> Arc<Channel> {
        let id: ChannelId =
            format!("grp:{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
                .to_compact_string();
        let ch = Arc::new(Channel::new(
            id.clone(),
            ChannelKind::Group,
            name.chars().take(40).collect::<String>().to_compact_string(),
            is_private,
            created_by,
            self.history_cap,
        ));
        ch.members.insert(created_by);
        self.map.insert(id.clone(), Arc::clone(&ch));
        self.add_user_channel(created_by, &id);
        ch
    }

    /// DM channels are keyed by a stable hash of the two participant
    /// usernames (lowercased, sorted) — NOT by ephemeral UserIds — so the
    /// channel survives reconnects where the user gets a new UserId.
    pub fn dm_id_for_names(a: &str, b: &str) -> ChannelId {
        let mut x = a.to_lowercase();
        let mut y = b.to_lowercase();
        if x > y { std::mem::swap(&mut x, &mut y); }
        // FNV-1a 64 over "a|b".
        let mut h: u64 = 0xcbf29ce484222325;
        for byte in x.bytes().chain(b"|".iter().copied()).chain(y.bytes()) {
            h ^= byte as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        format!("dm:{:016x}", h).to_compact_string()
    }

    pub fn open_dm(
        &self,
        a_id: UserId, a_name: &str,
        b_id: UserId, b_name: &str,
    ) -> Arc<Channel> {
        let id = Self::dm_id_for_names(a_name, b_name);
        if let Some(c) = self.get(&id) {
            // Refresh members in case either side is reconnecting.
            c.members.insert(a_id);
            c.members.insert(b_id);
            self.add_user_channel(a_id, &c.id);
            self.add_user_channel(b_id, &c.id);
            return c;
        }
        // Keep ORIGINAL casing for display; sort by lowercase for stability.
        let mut names = [a_name.to_compact_string(), b_name.to_compact_string()];
        if names[0].to_lowercase() > names[1].to_lowercase() { names.swap(0, 1); }
        let mut ch = Channel::new(
            id.clone(),
            ChannelKind::Dm,
            CompactString::const_new(""),
            true,
            a_id,
            self.history_cap,
        );
        ch.dm_users = Some(names);
        let ch = Arc::new(ch);
        ch.members.insert(a_id);
        ch.members.insert(b_id);
        self.map.insert(id.clone(), Arc::clone(&ch));
        self.add_user_channel(a_id, &id);
        self.add_user_channel(b_id, &id);
        ch
    }

    /// Re-bind any DM channels that contain `username` to the new `user_id`.
    /// Returns the channel IDs that were rebound.
    pub fn rebind_user_dms(&self, user_id: UserId, username: &str) -> Vec<ChannelId> {
        let lname = username.to_lowercase();
        let mut out = Vec::new();
        for entry in self.map.iter() {
            let ch = entry.value();
            if let Some(names) = &ch.dm_users {
                if names.iter().any(|n| n.to_lowercase() == lname) {
                    ch.members.insert(user_id);
                    self.add_user_channel(user_id, &ch.id);
                    out.push(ch.id.clone());
                }
            }
        }
        out
    }

    pub fn add_user_channel(&self, user: UserId, id: &ChannelId) {
        self.user_channels
            .entry(user)
            .or_default()
            .push(id.clone());
    }

    pub fn remove_user_channel(&self, user: UserId, id: &str) {
        if let Some(mut v) = self.user_channels.get_mut(&user) {
            v.retain(|c| c != id);
        }
    }

    /// Permanently delete a DM channel and detach it from every member.
    /// Returns the list of UserIds that had this channel attached so callers
    /// can notify their live sessions. No-op for non-DM channels.
    pub fn delete_dm(&self, id: &str) -> Vec<UserId> {
        let Some(ch) = self.get(id) else { return Vec::new(); };
        if !matches!(ch.kind, ChannelKind::Dm) { return Vec::new(); }
        let members: Vec<UserId> = ch.members.iter().map(|e| *e).collect();
        for uid in &members {
            self.remove_user_channel(*uid, id);
        }
        self.map.remove(id);
        members
    }

    /// Permanently delete any channel except the lobby. Returns the list of
    /// UserIds that had it attached so callers can notify them. Returns
    /// `None` if the channel doesn't exist or is the lobby.
    pub fn delete_any(&self, id: &str) -> Option<Vec<UserId>> {
        let ch = self.get(id)?;
        if matches!(ch.kind, ChannelKind::Lobby) { return None; }
        let members: Vec<UserId> = ch.members.iter().map(|e| *e).collect();
        for uid in &members {
            self.remove_user_channel(*uid, id);
        }
        self.map.remove(id);
        Some(members)
    }

    /// Return channels visible to `user`: public groups + their own.
    pub fn visible_to(&self, user: UserId) -> Vec<ChannelMeta> {
        self.map
            .iter()
            .filter(|e| {
                let c = e.value();
                match c.kind {
                    ChannelKind::Lobby => true,
                    ChannelKind::Group => !c.is_private || c.members.contains(&user),
                    ChannelKind::Dm => c.members.contains(&user),
                }
            })
            .map(|e| e.value().meta())
            .collect()
    }
}
