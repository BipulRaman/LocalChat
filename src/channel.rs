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
        let (tx, _) = broadcast::channel(64);
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

    /// DM channels have a deterministic ID from the sorted user IDs,
    /// so `dm_open(a, b)` is idempotent no matter who initiates.
    pub fn dm_id(a: UserId, b: UserId) -> ChannelId {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        format!("dm:{lo}:{hi}").to_compact_string()
    }

    pub fn open_dm(&self, a: UserId, b: UserId) -> Arc<Channel> {
        let id = Self::dm_id(a, b);
        if let Some(c) = self.get(&id) {
            return c;
        }
        let ch = Arc::new(Channel::new(
            id.clone(),
            ChannelKind::Dm,
            CompactString::const_new(""),
            true,
            a,
            self.history_cap,
        ));
        ch.members.insert(a);
        ch.members.insert(b);
        self.map.insert(id.clone(), Arc::clone(&ch));
        self.add_user_channel(a, &id);
        self.add_user_channel(b, &id);
        ch
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
