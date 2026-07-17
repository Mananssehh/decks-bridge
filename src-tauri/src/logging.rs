//! Cross-platform file logging with simple rotation.
//!
//! macOS:   ~/Library/Logs/Decks Bridge/
//! Windows: %LOCALAPPDATA%\Decks Bridge\Logs\

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ROTATED: u32 = 5;

pub fn log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs_home() {
            return home.join("Library/Logs/Decks Bridge");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("Decks Bridge").join("Logs");
        }
    }

    std::env::temp_dir().join("Decks Bridge").join("Logs")
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn rotate_if_needed(dir: &PathBuf, active: &PathBuf) {
    if !active.exists() {
        return;
    }
    let Ok(meta) = fs::metadata(active) else {
        return;
    };
    if meta.len() < MAX_BYTES {
        return;
    }

    for i in (1..=MAX_ROTATED).rev() {
        let from = if i == 1 {
            active.clone()
        } else {
            dir.join(format!("decks-bridge.{}.log", i - 1))
        };
        let to = dir.join(format!("decks-bridge.{i}.log"));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

pub fn init() -> Result<(), String> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {e}"))?;

    let active = dir.join("decks-bridge.log");
    rotate_if_needed(&dir, &active);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&active)
        .map_err(|e| format!("open log file: {e}"))?;

    *LOG_FILE.lock().unwrap() = Some(file);
    write_line("startup", &format!("logging initialized at {}", dir.display()));
    Ok(())
}

pub fn write_line(category: &str, message: &str) {
    let line = format!("[{}] [{}] {message}\n", timestamp(), category);
    eprint!("{line}");
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}
