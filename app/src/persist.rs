//! Append-only JSONL history per channel. Loaded tail on startup.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::message::WireMsg;

pub struct HistoryStore {
    pub root: PathBuf,
    /// Serialize writes so interleaving never corrupts JSONL.
    pub write_lock: Mutex<()>,
    pub rotate_bytes: u64,
}

impl HistoryStore {
    pub fn new(root: PathBuf, rotate_mb: u64) -> Self {
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            write_lock: Mutex::new(()),
            rotate_bytes: rotate_mb.saturating_mul(1024 * 1024).max(1024 * 1024),
        }
    }

    fn path_for(&self, channel: &str) -> PathBuf {
        // Replace characters that aren't safe in Windows filenames.
        let safe: String = channel
            .chars()
            .map(|c| match c {
                'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' => c,
                _ => '-',
            })
            .collect();
        self.root.join(format!("{safe}.jsonl"))
    }

    pub async fn append(&self, msg: &WireMsg) {
        let _g = self.write_lock.lock().await;
        let path = self.path_for(&msg.channel);

        // Rotate if file is already large.
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            if meta.len() > self.rotate_bytes {
                let rotated = path.with_extension(format!(
                    "jsonl.{}",
                    crate::message::now_secs()
                ));
                let _ = tokio::fs::rename(&path, rotated).await;
            }
        }

        let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        else {
            return;
        };
        let Ok(line) = serde_json::to_vec(msg) else {
            return;
        };
        let _ = f.write_all(&line).await;
        let _ = f.write_all(b"\n").await;
    }

    /// Load the last `limit` messages for a channel (fast tail scan).
    pub async fn tail(&self, channel: &str, limit: usize) -> Vec<Arc<WireMsg>> {
        let path = self.path_for(channel);
        let Ok(f) = File::open(&path).await else {
            return Vec::new();
        };
        let mut reader = BufReader::new(f).lines();
        // Simple approach: read all, keep last N. For LAN scale with rotated
        // files, a single jsonl stays under 10 MB (~50k short messages), so
        // this is fine. Optimize to seek-from-end later if needed.
        let mut buf: Vec<Arc<WireMsg>> = Vec::with_capacity(limit);
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            if let Ok(m) = serde_json::from_str::<WireMsg>(&line) {
                if buf.len() == limit {
                    buf.remove(0);
                }
                buf.push(Arc::new(m));
            }
        }
        buf
    }

    pub async fn delete_channel(&self, channel: &str) {
        let path = self.path_for(channel);
        let _ = tokio::fs::remove_file(path).await;
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

// ──────────────────────────────────────────────────────────────────────
// Reactions append-only log
// ──────────────────────────────────────────────────────────────────────

/// One reaction toggle event written to `reactions.jsonl` in app_root.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct ReactionEvent {
    pub c: String,    // channel id
    pub m: u64,       // message id
    pub u: u32,       // user id
    pub e: String,    // emoji
    pub on: bool,     // true=added, false=removed
}

pub struct ReactionLog {
    pub path: PathBuf,
    pub write_lock: Mutex<()>,
}

impl ReactionLog {
    pub fn new(app_root: &Path) -> Self {
        Self {
            path: app_root.join("reactions.jsonl"),
            write_lock: Mutex::new(()),
        }
    }

    pub async fn append(&self, ev: &ReactionEvent) {
        let _g = self.write_lock.lock().await;
        let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
        else {
            return;
        };
        let Ok(line) = serde_json::to_vec(ev) else { return };
        let _ = f.write_all(&line).await;
        let _ = f.write_all(b"\n").await;
    }

    pub async fn load_all(&self) -> Vec<ReactionEvent> {
        let Ok(f) = File::open(&self.path).await else {
            return Vec::new();
        };
        let mut reader = BufReader::new(f).lines();
        let mut out = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() { continue; }
            if let Ok(ev) = serde_json::from_str::<ReactionEvent>(&line) {
                out.push(ev);
            }
        }
        out
    }
}
