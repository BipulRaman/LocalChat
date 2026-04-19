//! WebSocket handler. Owns one connection, routes ops, fans out msgs.
//!
//! Wire protocol (JSON text frames):
//!
//!   Client → Server: {"op":"<name>", ...}
//!   Server → Client: {"ev":"<name>", ...}
//!
//! See README for the complete op/ev list.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use compact_str::{CompactString, ToCompactString};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::channel::{Channel, ChannelKind, LOBBY_ID};
use crate::message::{now_secs, FileInfo, MsgKind, WireMsg};
use crate::state::AppState;
use crate::user::{UserId, UserInfo};

pub async fn handle(socket: WebSocket, state: Arc<AppState>, peer_ip: String) {
    state.metrics.inc_connect();
    let (mut sink, mut stream) = socket.split();

    // ---- Wait for the first "join" op before adding to any state.
    let Some(Ok(Message::Text(init))) = stream.next().await else {
        state.metrics.dec_connect();
        return;
    };

    #[derive(Deserialize)]
    struct Join {
        username: String,
        #[serde(default)]
        avatar: String,
        #[serde(default)]
        color: String,
        #[serde(default)]
        pubkey: String,
    }
    let Ok(join) = serde_json::from_str::<Value>(&init).and_then(|v| {
        if v.get("op").and_then(Value::as_str) != Some("join") {
            return Err(serde::de::Error::custom("first op must be 'join'"));
        }
        serde_json::from_value::<Join>(v)
    }) else {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"first message must be {\"op\":\"join\"}"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    };

    let username = sanitize_username(&join.username);
    if username.is_empty() {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"invalid username"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    }

    // ---- Ban check.
    let banned = {
        let cfg = state.config.read().unwrap();
        cfg.banned_users.iter().any(|b| b == &username)
            || cfg.banned_ips.iter().any(|b| b == &peer_ip)
    };
    if banned {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"you are banned from this server"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    }

    // ── Username ownership check ─────────────────────────────────────
    // Once a username has been claimed by a browser (identified by its
    // E2EE public key), only that same browser can re-use the name.
    // Prevents trivial impersonation on a shared LAN.
    let supplied_pub: CompactString = join.pubkey
        .chars()
        .take(512)
        .collect::<String>()
        .to_compact_string();
    let key = username.to_lowercase().to_compact_string();
    if let Some(existing_id) = state.username_to_id.get(&key).map(|v| *v) {
        if let Some(prior) = state.known_users.get(&existing_id).map(|e| e.value().clone()) {
            if !prior.pubkey.is_empty()
                && (supplied_pub.is_empty() || supplied_pub != prior.pubkey)
            {
                let _ = sink
                    .send(Message::Text(
                        json!({
                            "ev":"error",
                            "text": format!(
                                "Username \"{}\" is already taken on this server. Pick a different name.",
                                username
                            ),
                            "code": "username_taken",
                        }).to_string(),
                    ))
                    .await;
                state.metrics.dec_connect();
                return;
            }
        }
    }

    let user_id = assign_user_id(&state, &username);

    // Restore previous identity (avatar/color/pubkey) if this user has
    // connected before. Client-supplied values still win when provided.
    let prior = state
        .known_users
        .get(&user_id)
        .map(|e| e.value().clone());


    let avatar = if !join.avatar.is_empty() {
        join.avatar.chars().take(4).collect::<String>().to_compact_string()
    } else if let Some(p) = prior.as_ref() {
        p.avatar.clone()
    } else {
        username
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".to_string())
            .to_compact_string()
    };
    let color = if !join.color.is_empty() {
        join.color.chars().take(16).collect::<String>().to_compact_string()
    } else if let Some(p) = prior.as_ref() {
        p.color.clone()
    } else {
        pick_color_for(&username).to_compact_string()
    };
    let pubkey = if !join.pubkey.is_empty() {
        join.pubkey.chars().take(512).collect::<String>().to_compact_string()
    } else {
        prior.as_ref().map(|p| p.pubkey.clone()).unwrap_or_default()
    };

    let info = UserInfo {
        id: user_id,
        username: username.clone(),
        avatar,
        color,
        joined_at: prior.as_ref().map(|p| p.joined_at).unwrap_or_else(now_secs),
        ip: peer_ip.to_compact_string(),
        msg_count: prior.as_ref().map(|p| p.msg_count).unwrap_or(0),
        bytes_uploaded: prior.as_ref().map(|p| p.bytes_uploaded).unwrap_or(0),
        pubkey,
    };
    state.users.insert(user_id, info.clone());
    state.known_users.insert(user_id, info.clone());
    let was_offline = {
        let mut entry = state.connections.entry(user_id).or_insert(0);
        let prev = *entry;
        *entry += 1;
        prev == 0
    };
    crate::applog::log(format_args!(
        "join: user={} id={} ip={} (sockets={})",
        info.username, user_id, peer_ip,
        state.connections.get(&user_id).map(|e| *e).unwrap_or(0),
    ));

    // Persist identity table so the same user keeps the same id across
    // server restarts. Cheap and infrequent.
    state.save_users().await;

    // Auto-join the lobby.
    let lobby = state.channels.get(LOBBY_ID).expect("lobby always exists");
    lobby.members.insert(user_id);
    state.channels.add_user_channel(user_id, &lobby.id);

    // Re-bind any DM channels that contain this username so they survive
    // page reloads (DMs are keyed by username hash, members are ephemeral).
    let rebound_dms = state.channels.rebind_user_dms(user_id, &info.username);

    // Re-subscribe to every group channel this user is already a member
    // of (membership is now durable across reloads & restarts).
    let mut my_channels: Vec<CompactString> = Vec::new();
    for entry in state.channels.map.iter() {
        let ch = entry.value();
        if matches!(ch.kind, ChannelKind::Lobby | ChannelKind::Dm) { continue; }
        if ch.members.contains(&user_id) {
            state.channels.add_user_channel(user_id, &ch.id);
            my_channels.push(ch.id.clone());
        }
    }

    // Subscribe to all channels this user can see.
    let mut rxs: smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]> =
        smallvec::smallvec![];
    rxs.push(lobby.tx.subscribe());
    for cid in &rebound_dms {
        if let Some(ch) = state.channels.get(cid) {
            rxs.push(ch.tx.subscribe());
        }
    }
    for cid in &my_channels {
        if let Some(ch) = state.channels.get(cid) {
            rxs.push(ch.tx.subscribe());
        }
    }

    // Welcome envelope.
    let welcome = json!({
        "ev": "welcome",
        "user": info,
        "channels": state.channels.visible_to(user_id),
        "users": state.users.iter().map(|e| e.value().clone()).collect::<Vec<_>>(),
        "lobby": LOBBY_ID,
    });
    if sink.send(Message::Text(welcome.to_string())).await.is_err() {
        cleanup(&state, user_id).await;
        return;
    }

    // Send lobby recent history.
    send_history(&mut sink, &lobby, 50).await;

    // Broadcast "X joined" only on the user's first concurrent socket.
    if was_offline {
        broadcast_system(&state, &lobby, &format!("{} joined the chat", info.username)).await;
        broadcast_users(&state).await;
    } else {
        // Still refresh presence for *this* socket so its UI is correct.
        broadcast_users(&state).await;
    }

    // ---- Main loop: multiplex incoming ops and outgoing broadcasts.
    let mut own_channels: smallvec::SmallVec<[CompactString; 8]> =
        smallvec::smallvec![lobby.id.clone()];
    for cid in rebound_dms { own_channels.push(cid); }
    for cid in my_channels { if !own_channels.iter().any(|c| c == &cid) { own_channels.push(cid); } }

    loop {
        tokio::select! {
            // Incoming ops
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Text(txt) => {
                        if let Err(e) = handle_op(&state, user_id, &mut sink, &mut rxs, &mut own_channels, &txt).await {
                            let _ = sink.send(Message::Text(
                                json!({"ev":"error","text":e}).to_string())).await;
                        }
                    }
                    Message::Ping(p) => { let _ = sink.send(Message::Pong(p)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }

            // Outgoing: whichever channel fires first.
            out = recv_any(&mut rxs) => {
                match out {
                    Some(msg) => {
                        // Intercept the __dm_subscribe control event: if it's
                        // addressed to us, subscribe to the named channel and
                        // do NOT forward it to the client.
                        if msg.username == "__dm_subscribe" {
                            if let Ok(v) = serde_json::from_str::<Value>(&msg.text) {
                                let target = v.get("forUserId").and_then(Value::as_u64).unwrap_or(0) as UserId;
                                if target == user_id {
                                    if let Some(ch_id) = v.get("channel").and_then(Value::as_str) {
                                        let cid = ch_id.to_compact_string();
                                        if !own_channels.iter().any(|c| c == &cid) {
                                            if let Some(ch) = state.channels.get(&cid) {
                                                rxs.push(ch.tx.subscribe());
                                                own_channels.push(cid.clone());
                                                // Push a ch_created event so the
                                                // client can show the DM in its sidebar.
                                                let out = json!({"ev":"ch_created","channel":ch.meta()});
                                                let _ = sink.send(Message::Text(out.to_string())).await;
                                            }
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                        // Intercept the __ch_invited control event: if it's
                        // addressed to us, subscribe to the channel, surface
                        // it in the sidebar, and tell the client to toast.
                        if msg.username == "__ch_invited" {
                            if let Ok(v) = serde_json::from_str::<Value>(&msg.text) {
                                let target = v.get("forUserId").and_then(Value::as_u64).unwrap_or(0) as UserId;
                                if target == user_id {
                                    if let Some(ch_id) = v.get("channel").and_then(Value::as_str) {
                                        let cid = ch_id.to_compact_string();
                                        if let Some(ch) = state.channels.get(&cid) {
                                            if !own_channels.iter().any(|c| c == &cid) {
                                                rxs.push(ch.tx.subscribe());
                                                own_channels.push(cid.clone());
                                            }
                                            let created = json!({"ev":"ch_created","channel":ch.meta()});
                                            let _ = sink.send(Message::Text(created.to_string())).await;
                                            let invited = json!({
                                                "ev":"ch_invited",
                                                "channel": ch.id,
                                                "channelName": ch.name,
                                                "inviter": v.get("inviter").and_then(Value::as_str).unwrap_or("")
                                            });
                                            let _ = sink.send(Message::Text(invited.to_string())).await;
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                        if sink.send(Message::Text(msg_to_json(&msg))).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // ---- Disconnect cleanup.
    cleanup(&state, user_id).await;
}

async fn cleanup(state: &Arc<AppState>, user_id: UserId) {
    // Decrement socket count; only fully "leave" when it hits zero.
    let still_online = {
        let mut entry = state.connections.entry(user_id).or_insert(0);
        if *entry > 0 { *entry -= 1; }
        let n = *entry;
        if n == 0 { drop(entry); state.connections.remove(&user_id); false } else { true }
    };
    if still_online {
        // Another tab/window is still open for this user. Keep presence
        // and channel memberships intact.
        state.metrics.dec_connect();
        return;
    }

    let removed = state.users.remove(&user_id).map(|(_, v)| v);
    // We INTENTIONALLY do not strip the user from channel members here.
    // Channel membership is durable; presence is reflected by `users`.
    // Lobby is special — it's auto-joined on every connection, so we can
    // drop it from user_channels to keep the per-user list trim.
    if let Some(mut chs) = state.channels.user_channels.get_mut(&user_id) {
        chs.retain(|c| c.as_str() != LOBBY_ID);
    }
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        lobby.members.remove(&user_id);
    }
    state.metrics.dec_connect();

    if let Some(u) = removed {
        crate::applog::log(format_args!(
            "leave: user={} id={}", u.username, user_id
        ));
        if let Some(lobby) = state.channels.get(LOBBY_ID) {
            broadcast_system(state, &lobby, &format!("{} left the chat", u.username)).await;
        }
        broadcast_users(state).await;
    }
}

/// Pick a UserId for this username. Always reuses the previously assigned
/// ID if the username has joined before — across reconnects AND across
/// server restarts (loaded from users.json). Multiple concurrent sockets
/// for the same username share the same UserId; the connection ref-count
/// in `state.connections` decides when the user truly goes offline.
fn assign_user_id(state: &Arc<AppState>, username: &CompactString) -> UserId {
    let key = username.to_lowercase().to_compact_string();
    if let Some(existing) = state.username_to_id.get(&key).map(|v| *v) {
        return existing;
    }
    let id = state.next_user_id();
    state.username_to_id.insert(key, id);
    id
}

fn sanitize_username(u: &str) -> CompactString {
    let cleaned: String = u
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(30)
        .collect();
    cleaned.to_compact_string()
}

/// Stable color from a username (case-insensitive, FNV-1a 32-bit hash).
fn pick_color_for(username: &str) -> &'static str {
    const COLORS: &[&str] = &[
        "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
        "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
    ];
    let mut h: u32 = 0x811c9dc5;
    for b in username.as_bytes() {
        let lower = b.to_ascii_lowercase();
        h ^= lower as u32;
        h = h.wrapping_mul(0x01000193);
    }
    COLORS[(h as usize) % COLORS.len()]
}

/// Merge-style receive: await on whichever channel fires first.
/// Uses a SmallVec to keep the per-message future array on the stack for
/// the common case (≤ 8 channels per user) — no heap allocation in the
/// hot WS loop.
async fn recv_any(
    rxs: &mut smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]>,
) -> Option<Arc<WireMsg>> {
    use futures_util::future::{select_all, FutureExt};
    if rxs.is_empty() {
        return futures_util::future::pending().await;
    }
    let futs: smallvec::SmallVec<[_; 8]> = rxs
        .iter_mut()
        .map(|rx| Box::pin(rx.recv().map(|r| r.ok())))
        .collect();
    let (res, _, _) = select_all(futs).await;
    res
}

fn msg_to_json(m: &WireMsg) -> String {
    json!({ "ev":"msg", "m": m }).to_string()
}

type WsSink = futures_util::stream::SplitSink<WebSocket, Message>;

async fn send_history(sink: &mut WsSink, ch: &Channel, limit: usize) {
    let recent = ch.recent(limit).await;
    let v: Vec<&WireMsg> = recent.iter().map(|a| a.as_ref()).collect();
    let out = json!({ "ev": "history", "channel": ch.id, "messages": v });
    let _ = sink.send(Message::Text(out.to_string())).await;
}

fn collect_reactions(
    state: &Arc<AppState>,
    channel: &CompactString,
) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for entry in state.reactions.iter() {
        let (ch_id, msg_id) = entry.key();
        if ch_id != channel { continue; }
        let mut emap = serde_json::Map::new();
        for ee in entry.value().iter() {
            let users: Vec<UserId> = ee.value().clone();
            if !users.is_empty() {
                emap.insert(ee.key().to_string(), json!(users));
            }
        }
        if !emap.is_empty() {
            out.insert(msg_id.to_string(), Value::Object(emap));
        }
    }
    out
}

async fn broadcast_system(state: &Arc<AppState>, ch: &Channel, text: &str) {
    let msg = Arc::new(WireMsg {
        id: state.next_msg_id(),
        channel: ch.id.clone(),
        kind: MsgKind::System,
        user_id: 0,
        username: CompactString::const_new(""),
        avatar: CompactString::const_new(""),
        color: CompactString::const_new(""),
        ts: now_secs(),
        text: text.to_string(),
        file: None,
        reply_to: None,
        edited_at: None,
        deleted: false,
    });
    ch.push_history(msg.clone()).await;
    state.history.append(&msg).await;
    let _ = ch.tx.send(msg);
}

async fn broadcast_users(state: &Arc<AppState>) {
    let users: Vec<UserInfo> =
        state.users.iter().map(|e| e.value().clone()).collect();
    let payload = json!({"ev":"users","users":users}).to_string();
    // Fan out on the lobby channel only (everyone is in lobby).
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        // Inject a synthetic "presence" message via tx? No — presence is a
        // control event, not a history message. We piggyback by storing as
        // a payload-only push. For simplicity we send presence as a system
        // message to the lobby broadcast, but don't persist.
        let msg = Arc::new(WireMsg {
            id: 0,
            channel: lobby.id.clone(),
            kind: MsgKind::System,
            user_id: 0,
            username: CompactString::const_new("__presence"),
            avatar: CompactString::const_new(""),
            color: CompactString::const_new(""),
            ts: now_secs(),
            text: payload,
            file: None,
            reply_to: None,
            edited_at: None,
            deleted: false,
        });
        // Tagged with a sentinel username; client special-cases it.
        let _ = lobby.tx.send(msg);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Op dispatch
// ──────────────────────────────────────────────────────────────────────

async fn handle_op(
    state: &Arc<AppState>,
    user_id: UserId,
    sink: &mut WsSink,
    rxs: &mut smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]>,
    own_channels: &mut smallvec::SmallVec<[CompactString; 8]>,
    txt: &str,
) -> Result<(), String> {
    let v: Value = serde_json::from_str(txt).map_err(|e| e.to_string())?;
    let op = v.get("op").and_then(Value::as_str).ok_or("missing op")?;

    match op {
        "send" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let text = v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_end_matches('\n')
                .to_string();
            if text.is_empty() || text.len() > 4096 {
                return Err("empty or oversize text".into());
            }
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) {
                return Err("not a member".into());
            }
            let user = state.users.get(&user_id).ok_or("user gone")?.clone();
            let msg = Arc::new(WireMsg {
                id: state.next_msg_id(),
                channel: channel_id.clone(),
                kind: MsgKind::Text,
                user_id,
                username: user.username.clone(),
                avatar: user.avatar.clone(),
                color: user.color.clone(),
                ts: now_secs(),
                text,
                file: None,
                reply_to: v.get("replyTo").and_then(Value::as_u64),
                edited_at: None,
                deleted: false,
            });
            ch.push_history(msg.clone()).await;
            state.history.append(&msg).await;
            state.metrics.inc_messages();
            bump_user_msg_count(state, user_id);
            let _ = ch.tx.send(msg);
        }

        "file" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let file: FileInfo = serde_json::from_value(
                v.get("file").cloned().ok_or("missing file")?,
            )
            .map_err(|e| e.to_string())?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) {
                return Err("not a member".into());
            }
            let user = state.users.get(&user_id).ok_or("user gone")?.clone();
            let msg = Arc::new(WireMsg {
                id: state.next_msg_id(),
                channel: channel_id.clone(),
                kind: MsgKind::File,
                user_id,
                username: user.username.clone(),
                avatar: user.avatar.clone(),
                color: user.color.clone(),
                ts: now_secs(),
                text: v
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                file: Some(file),
                reply_to: None,
                edited_at: None,
                deleted: false,
            });
            ch.push_history(msg.clone()).await;
            state.history.append(&msg).await;
            state.metrics.inc_messages();
            let _ = ch.tx.send(msg);
        }

        "typing" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let is_typing = v
                .get("typing")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let ch = state.channels.get(channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) {
                return Ok(()); // silently ignore
            }
            let user = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "typing",
                "channel": channel_id,
                "userId": user_id,
                "username": user,
                "typing": is_typing,
            });
            // piggyback on the channel broadcast via a synthetic WireMsg
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__typing"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "ch_create" => {
            let name = v
                .get("name")
                .and_then(Value::as_str)
                .ok_or("missing name")?
                .trim();
            if name.is_empty() {
                return Err("empty name".into());
            }
            let private = v.get("private").and_then(Value::as_bool).unwrap_or(false);
            let ch = state.channels.create_group(name, private, user_id);
            rxs.push(ch.tx.subscribe());
            own_channels.push(ch.id.clone());

            let out = json!({"ev":"ch_created","channel":ch.meta()});
            let _ = sink.send(Message::Text(out.to_string())).await;
            broadcast_system(state, &ch, &format!("Channel #{} created", ch.name)).await;
            state.save_channels().await;
        }

        "ch_join" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if ch.is_private && !ch.members.contains(&user_id) {
                return Err("channel is private".into());
            }
            ch.members.insert(user_id);
            state.channels.add_user_channel(user_id, &ch.id);
            if !own_channels.iter().any(|c| c == &ch.id) {
                rxs.push(ch.tx.subscribe());
                own_channels.push(ch.id.clone());
            }
            send_history(sink, &ch, 50).await;
            let username = state
                .users
                .get(&user_id)
                .map(|u| u.value().username.to_string())
                .unwrap_or_default();
            broadcast_system(state, &ch, &format!("{} joined #{}", username, ch.name)).await;
            state.save_channels().await;
        }

        "ch_leave" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            if id == LOBBY_ID {
                return Err("cannot leave lobby".into());
            }
            if let Some(ch) = state.channels.get(id) {
                ch.members.remove(&user_id);
                state.channels.remove_user_channel(user_id, id);
                own_channels.retain(|c| c != id);
                // rxs: we don't bother surgically removing; the send loop
                // will drop the receiver when the channel empties or the
                // socket closes. Correctness unaffected.
            }
            state.save_channels().await;
        }

        "ch_invite" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let users = v
                .get("users")
                .and_then(Value::as_array)
                .ok_or("missing users")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !ch.members.contains(&user_id) {
                return Err("not a member".into());
            }
            let inviter_name = state
                .users
                .get(&user_id)
                .map(|u| u.value().username.to_string())
                .unwrap_or_default();
            let mut added: Vec<(UserId, String)> = Vec::new();
            for u in users {
                if let Some(uid) = u.as_u64() {
                    let uid = uid as UserId;
                    if uid == user_id { continue; }
                    let was_new = ch.members.insert(uid);
                    state.channels.add_user_channel(uid, &ch.id);
                    if was_new {
                        let name = state
                            .users
                            .get(&uid)
                            .map(|u| u.value().username.to_string())
                            .unwrap_or_default();
                        added.push((uid, name));
                    }
                }
            }
            // Notify each invitee via the lobby control bus so their socket
            // can subscribe to the new channel and surface a toast.
            if !added.is_empty() {
                if let Some(lobby) = state.channels.get(LOBBY_ID) {
                    for (uid, _) in &added {
                        let payload = json!({
                            "ev": "ch_invited",
                            "channel": ch.id,
                            "forUserId": *uid,
                            "inviter": inviter_name,
                            "channelName": ch.name,
                        });
                        let _ = lobby.tx.send(Arc::new(WireMsg {
                            id: 0,
                            channel: lobby.id.clone(),
                            kind: MsgKind::System,
                            user_id,
                            username: CompactString::const_new("__ch_invited"),
                            avatar: CompactString::const_new(""),
                            color: CompactString::const_new(""),
                            ts: now_secs(),
                            text: payload.to_string(),
                            file: None,
                            reply_to: None,
                            edited_at: None,
                            deleted: false,
                        }));
                    }
                }
                // Post a single system message in the channel announcing the additions.
                let names: Vec<String> = added.iter().map(|(_, n)| n.clone()).filter(|s| !s.is_empty()).collect();
                if !names.is_empty() {
                    let joined = match names.len() {
                        1 => names[0].clone(),
                        2 => format!("{} and {}", names[0], names[1]),
                        _ => {
                            let last = names.last().cloned().unwrap_or_default();
                            let head = &names[..names.len() - 1];
                            format!("{}, and {}", head.join(", "), last)
                        }
                    };
                    let text = format!("{} added {} to #{}", inviter_name, joined, ch.name);
                    broadcast_system(state, &ch, &text).await;
                }
                state.save_channels().await;
            }
        }

        "dm_open" => {
            let peer = v.get("user").and_then(Value::as_u64).ok_or("missing user")?
                as UserId;
            if peer == user_id {
                return Err("cannot DM yourself".into());
            }
            let my_name = state.users.get(&user_id)
                .map(|e| e.value().username.to_string())
                .ok_or("self gone")?;
            let peer_name = state.users.get(&peer)
                .map(|e| e.value().username.to_string())
                .ok_or("peer gone")?;
            let ch = state.channels.open_dm(user_id, &my_name, peer, &peer_name);
            if !own_channels.iter().any(|c| c == &ch.id) {
                rxs.push(ch.tx.subscribe());
                own_channels.push(ch.id.clone());
            }
            let out = json!({"ev":"ch_created","channel":ch.meta()});
            let _ = sink.send(Message::Text(out.to_string())).await;
            send_history(sink, &ch, 50).await;

            // Tell the peer's WS handler (via the lobby bus) to subscribe to
            // this DM channel as well, so messages reach them in real-time
            // even if they haven't opened the DM yet.
            if let Some(lobby) = state.channels.get(LOBBY_ID) {
                let payload = json!({
                    "ev": "dm_subscribe",
                    "channel": ch.id,
                    "forUserId": peer,
                });
                let _ = lobby.tx.send(Arc::new(WireMsg {
                    id: 0,
                    channel: lobby.id.clone(),
                    kind: MsgKind::System,
                    user_id,
                    username: CompactString::const_new("__dm_subscribe"),
                    avatar: CompactString::const_new(""),
                    color: CompactString::const_new(""),
                    ts: now_secs(),
                    text: payload.to_string(),
                    file: None,
                    reply_to: None,
                    edited_at: None,
                    deleted: false,
                }));
            }
            state.save_channels().await;
        }

        "dm_delete" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Dm) {
                return Err("only DMs can be deleted".into());
            }
            if !ch.members.contains(&user_id) {
                return Err("not a member".into());
            }
            let id_str: CompactString = ch.id.clone();
            // Tell ALL members (including peer's other tabs and ourselves) to drop it
            // BEFORE we tear it down, while the broadcaster still exists.
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: id_str.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__dm_deleted"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: json!({"channel": id_str}).to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: true,
            }));
            // Detach all members and drop the channel.
            state.channels.delete_dm(&id_str);
            // Wipe persisted history.
            state.history.delete_channel(&id_str).await;
            // Drop our own subscription so the local rxs loop stops polling it.
            own_channels.retain(|c| c != &id_str);
            let _ = sink
                .send(Message::Text(json!({"ev":"ch_deleted","channel":id_str}).to_string()))
                .await;
            state.save_channels().await;
        }

        "ch_delete" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Group) {
                return Err("only group channels can be deleted".into());
            }
            if ch.created_by != user_id {
                return Err("only the creator can delete this channel".into());
            }
            let id_str: CompactString = ch.id.clone();
            // Notify all subscribers BEFORE we drop the broadcaster.
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: id_str.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__ch_deleted"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: json!({"channel": id_str}).to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: true,
            }));
            state.channels.delete_any(&id_str);
            state.history.delete_channel(&id_str).await;
            // Drop reactions for this channel.
            state.reactions.retain(|(c, _), _| c != &id_str);
            own_channels.retain(|c| c != &id_str);
            let _ = sink
                .send(Message::Text(json!({"ev":"ch_deleted","channel":id_str}).to_string()))
                .await;
            state.save_channels().await;
        }

        "history" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let limit = v
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(500) as usize;
            // RAM first, then fall back to disk if emptier than requested.
            let ch = state.channels.get(id).ok_or("no such channel")?;
            let mut out = ch.recent(limit).await;
            if out.len() < limit {
                let from_disk = state.history.tail(id, limit).await;
                out = from_disk;
            }
            let msgs: Vec<&WireMsg> = out.iter().map(|a| a.as_ref()).collect();
            let reactions = collect_reactions(state, &id.to_compact_string());
            let resp = json!({
                "ev":"history",
                "channel":id,
                "messages":msgs,
                "reactions": reactions,
            });
            let _ = sink.send(Message::Text(resp.to_string())).await;
        }

        "react" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let emoji = v
                .get("emoji")
                .and_then(Value::as_str)
                .ok_or("missing emoji")?;
            // Cap emoji to 16 bytes (a few graphemes).
            let emoji: CompactString = emoji.chars().take(8).collect::<String>().to_compact_string();
            if emoji.is_empty() { return Err("empty emoji".into()); }

            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) {
                return Err("not a member".into());
            }

            let key = (channel_id.clone(), msg_id);
            let entry = state.reactions.entry(key).or_default();
            let mut on = true;
            {
                let mut users = entry.entry(emoji.clone()).or_default();
                if let Some(pos) = users.iter().position(|u| *u == user_id) {
                    users.swap_remove(pos);
                    on = false;
                } else {
                    users.push(user_id);
                }
                if users.is_empty() {
                    drop(users);
                    entry.remove(&emoji);
                }
            }
            // Cleanup empty msg slots
            if entry.is_empty() {
                drop(entry);
                state.reactions.remove(&(channel_id.clone(), msg_id));
            }

            // Persist the toggle event so reactions survive restart.
            state.reaction_log.append(&crate::persist::ReactionEvent {
                c: channel_id.to_string(),
                m: msg_id,
                u: user_id,
                e: emoji.to_string(),
                on,
            }).await;

            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "react",
                "channel": channel_id,
                "msgId": msg_id,
                "userId": user_id,
                "username": username,
                "emoji": emoji,
                "on": on,
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__react"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "ping" => {
            let _ = sink.send(Message::Text(r#"{"ev":"pong"}"#.into())).await;
        }

        "call_signal" => {
            // Relay a WebRTC signaling blob to the other DM participant(s)
            // by piggybacking on the channel broadcast bus. The client
            // filters these synthetic messages by `username == "__call"`.
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let kind = v.get("kind").and_then(Value::as_str).ok_or("missing kind")?;
            // Whitelist the few signaling kinds we expect.
            if !matches!(kind, "offer" | "answer" | "ice" | "ringing" | "end" | "busy" | "decline") {
                return Err("invalid call kind".into());
            }
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) { return Err("not a member".into()); }
            // Only allow on DM channels — group calls aren't supported.
            if !matches!(ch.kind, ChannelKind::Dm) {
                return Err("calls only allowed in DMs".into());
            }
            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "call",
                "channel": channel_id,
                "kind": kind,
                "from": user_id,
                "fromName": username,
                "payload": v.get("payload").cloned().unwrap_or(Value::Null),
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__call"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "read" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, user_id) { return Err("not a member".into()); }
            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "read",
                "channel": channel_id,
                "msgId": msg_id,
                "userId": user_id,
                "username": username,
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__read"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        _ => return Err(format!("unknown op '{op}'")),
    }

    Ok(())
}

fn can_send(ch: &Channel, user: UserId) -> bool {
    matches!(ch.kind, ChannelKind::Lobby) || ch.members.contains(&user)
}

fn bump_user_msg_count(state: &Arc<AppState>, user_id: UserId) {
    if let Some(mut u) = state.users.get_mut(&user_id) {
        u.msg_count += 1;
    }
}

// Silences unused warning — placeholder for future per-channel buffers.
#[allow(dead_code)]
fn _unused() -> Bytes {
    Bytes::new()
}
