//! Persisted runtime configuration. Lives next to the executable.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    /// Override auto port-pick. 0 = auto.
    #[serde(default)]
    pub port: u16,

    /// Admin dashboard access token. Generated on first run.
    pub admin_token: String,

    /// If false (default), admin endpoints only accept requests from 127.0.0.1.
    #[serde(default)]
    pub allow_lan_admin: bool,

    /// Max upload size in MB.
    #[serde(default = "default_max_upload_mb")]
    pub max_upload_mb: u64,

    /// How many messages to keep per channel in RAM.
    #[serde(default = "default_history_ram")]
    pub history_ram: usize,

    /// Rotate JSONL files when they exceed this size (MB).
    #[serde(default = "default_rotate_mb")]
    pub rotate_mb: u64,

    /// Usernames / IPs that are banned from joining.
    #[serde(default)]
    pub banned_users: Vec<String>,
    #[serde(default)]
    pub banned_ips: Vec<String>,

    /// If true, server tries to start on Windows boot (HKCU Run key).
    #[serde(default)]
    pub autostart: bool,
}

fn default_max_upload_mb() -> u64 {
    500
}
fn default_history_ram() -> usize {
    64
}
fn default_rotate_mb() -> u64 {
    10
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 0,
            admin_token: gen_token(),
            allow_lan_admin: false,
            max_upload_mb: default_max_upload_mb(),
            history_ram: default_history_ram(),
            rotate_mb: default_rotate_mb(),
            banned_users: Vec::new(),
            banned_ips: Vec::new(),
            autostart: false,
        }
    }
}

impl Config {
    pub fn load_or_init(path: &Path) -> std::io::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => match serde_json::from_str::<Config>(&s) {
                Ok(cfg) => Ok(cfg),
                Err(_) => {
                    // Corrupt — back it up and start fresh.
                    let bak = path.with_extension("json.bak");
                    let _ = std::fs::rename(path, bak);
                    let cfg = Config::default();
                    cfg.save(path)?;
                    Ok(cfg)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let cfg = Config::default();
                cfg.save(path)?;
                Ok(cfg)
            }
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).unwrap();
        let tmp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

fn gen_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    (0..24)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}
