//! Tiny append-only file logger.
//!
//! Writes a single `lanchat.log` file inside the app-data `logs/` dir
//! and rotates once it crosses ~5 MB. Plain UTF-8, one line per event.
//! Also mirrors each line to stderr so the console / debug build still
//! shows activity.
//!
//! Intentionally dependency-free; no `tracing` / `log` runtime overhead.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

struct Logger {
    path: PathBuf,
    file: Mutex<Option<std::fs::File>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

pub fn init(logs_dir: &Path) {
    let _ = std::fs::create_dir_all(logs_dir);
    let path = logs_dir.join("lanchat.log");
    let _ = LOGGER.set(Logger {
        file: Mutex::new(open(&path)),
        path,
    });
}

pub fn log(args: std::fmt::Arguments<'_>) {
    let line = format!("{} {}\n", timestamp(), args);
    eprint!("{line}");
    let Some(l) = LOGGER.get() else { return };

    let mut guard = match l.file.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    // Lazy reopen if the file was rotated externally.
    if guard.is_none() {
        *guard = open(&l.path);
    }

    let needs_rotate = guard
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map(|m| m.len() >= MAX_BYTES)
        .unwrap_or(false);

    if needs_rotate {
        drop(guard.take());
        let backup = l.path.with_extension("log.1");
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(&l.path, &backup);
        *guard = open(&l.path);
    }

    if let Some(f) = guard.as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn path() -> Option<PathBuf> {
    LOGGER.get().map(|l| l.path.clone())
}

fn open(path: &Path) -> Option<std::fs::File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    // Cheap ISO-8601 (UTC) without bringing in chrono/time.
    let (y, mo, d, h, mi, s) = ymd_hms_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn ymd_hms_utc(mut secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    if secs < 0 { secs = 0; }
    let day = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let s = rem % 60;

    // Days since 1970-01-01 → civil date (Howard Hinnant algorithm).
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i32 + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}

/// Convenience macro: `log!("hello {}", name);`
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::applog::log(std::format_args!($($arg)*)) };
}
