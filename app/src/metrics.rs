//! Lightweight metrics. All counters are atomics: ~zero overhead.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::Serialize;

pub struct Metrics {
    pub started_at: Instant,
    pub total_messages: AtomicU64,
    pub total_uploads: AtomicU64,
    pub bytes_uploaded: AtomicU64,
    pub total_connections: AtomicU64,
    pub active_connections: AtomicU64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            total_messages: AtomicU64::new(0),
            total_uploads: AtomicU64::new(0),
            bytes_uploaded: AtomicU64::new(0),
            total_connections: AtomicU64::new(0),
            active_connections: AtomicU64::new(0),
        }
    }
}

impl Metrics {
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            uptime_s: self.started_at.elapsed().as_secs(),
            total_messages: self.total_messages.load(Ordering::Relaxed),
            total_uploads: self.total_uploads.load(Ordering::Relaxed),
            bytes_uploaded: self.bytes_uploaded.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            active_connections: self.active_connections.load(Ordering::Relaxed),
        }
    }

    pub fn inc_messages(&self) {
        self.total_messages.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_upload(&self, bytes: u64) {
        self.total_uploads.fetch_add(1, Ordering::Relaxed);
        self.bytes_uploaded.fetch_add(bytes, Ordering::Relaxed);
    }
    pub fn inc_connect(&self) {
        self.total_connections.fetch_add(1, Ordering::Relaxed);
        self.active_connections.fetch_add(1, Ordering::Relaxed);
    }
    pub fn dec_connect(&self) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct MetricsSnapshot {
    pub uptime_s: u64,
    pub total_messages: u64,
    pub total_uploads: u64,
    pub bytes_uploaded: u64,
    pub total_connections: u64,
    pub active_connections: u64,
}
