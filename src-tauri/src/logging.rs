//! Cross-platform file logging with simple rotation.
//!
//! macOS:   ~/Library/Logs/Decks Bridge/
//! Windows: %LOCALAPPDATA%\Decks Bridge\Logs\

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// Bytes written to the active log since it was opened or last rotated.
///
/// Tracked in memory so write_line can enforce the size cap without stat'ing
/// the file on every line. Detection logs several lines every 3s for the whole
/// length of a set, so a syscall per line would be pure waste.
static WRITTEN: AtomicU64 = AtomicU64::new(0);

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ROTATED: u32 = 5;
const ACTIVE_LOG: &str = "decks-bridge.log";

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

/// Shift decks-bridge.log → .1.log → .2.log … dropping the oldest.
/// Caller must ensure no File handle to `active` is still open.
fn rotate_files(dir: &Path, active: &Path) {
    for i in (1..=MAX_ROTATED).rev() {
        let from = if i == 1 {
            active.to_path_buf()
        } else {
            dir.join(format!("decks-bridge.{}.log", i - 1))
        };
        let to = dir.join(format!("decks-bridge.{i}.log"));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

fn rotate_if_needed(dir: &Path, active: &Path) {
    if !active.exists() {
        return;
    }
    let Ok(meta) = fs::metadata(active) else {
        return;
    };
    if meta.len() < MAX_BYTES {
        return;
    }
    rotate_files(dir, active);
}

fn open_active(dir: &Path) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(ACTIVE_LOG))
        .ok()
}

pub fn init() -> Result<(), String> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {e}"))?;

    let active = dir.join(ACTIVE_LOG);
    rotate_if_needed(&dir, &active);

    let file = open_active(&dir).ok_or_else(|| "open log file".to_string())?;

    // Seed the counter with what is already on disk so an appended-to log still
    // rotates at the cap rather than growing by another MAX_BYTES first.
    let existing = fs::metadata(&active).map(|m| m.len()).unwrap_or(0);
    WRITTEN.store(existing, Ordering::Relaxed);

    match LOG_FILE.lock() {
        Ok(mut guard) => *guard = Some(file),
        Err(poisoned) => *poisoned.into_inner() = Some(file),
    }
    write_line("startup", &format!("logging initialized at {}", dir.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The active log must never grow past the cap, and the rotated set must be
    /// bounded. This is the regression for rotation only running at init(): a DJ
    /// leaving Bridge running overnight used to grow decks-bridge.log without
    /// limit because the size check never ran again after launch.
    #[test]
    fn rotate_files_shifts_and_drops_the_oldest() {
        let dir = std::env::temp_dir().join(format!("db-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let active = dir.join(ACTIVE_LOG);

        // Seed the active log plus a full set of rotated generations.
        fs::write(&active, b"active").unwrap();
        for i in 1..=MAX_ROTATED {
            fs::write(dir.join(format!("decks-bridge.{i}.log")), format!("gen{i}")).unwrap();
        }

        rotate_files(&dir, &active);

        // active became .1
        assert_eq!(fs::read_to_string(dir.join("decks-bridge.1.log")).unwrap(), "active");
        // each generation shifted down by one
        for i in 2..=MAX_ROTATED {
            assert_eq!(
                fs::read_to_string(dir.join(format!("decks-bridge.{i}.log"))).unwrap(),
                format!("gen{}", i - 1)
            );
        }
        // the oldest was dropped, not kept forever
        assert!(!dir.join(format!("decks-bridge.{}.log", MAX_ROTATED + 1)).exists());
        // the log dir stays bounded at MAX_ROTATED generations
        let logs = fs::read_dir(&dir).unwrap().count();
        assert_eq!(logs, MAX_ROTATED as usize);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_if_needed_leaves_a_small_log_alone() {
        let dir = std::env::temp_dir().join(format!("db-log-small-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let active = dir.join(ACTIVE_LOG);
        fs::write(&active, b"tiny").unwrap();

        rotate_if_needed(&dir, &active);

        assert!(active.exists(), "a log under the cap must not rotate");
        assert!(!dir.join("decks-bridge.1.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}

pub fn write_line(category: &str, message: &str) {
    let line = format!("[{}] [{}] {message}\n", timestamp(), category);
    eprint!("{line}");

    // Recover from poisoning rather than propagating a panic: losing the log is
    // never a reason to take the app down mid-set.
    let mut guard = match LOG_FILE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    let mut over_cap = false;
    if let Some(file) = guard.as_mut() {
        if file.write_all(line.as_bytes()).is_ok() {
            let _ = file.flush();
            let total =
                WRITTEN.fetch_add(line.len() as u64, Ordering::Relaxed) + line.len() as u64;
            over_cap = total >= MAX_BYTES;
        }
    }

    if over_cap {
        // Rotation previously only ran at init(), so the size cap was enforced
        // once per launch. Detection logs several lines every 3s (~14MB/day), so
        // a DJ leaving Bridge running overnight blew past the cap in hours and
        // kept growing until they happened to restart. Rotating here bounds the
        // log dir at MAX_BYTES * (MAX_ROTATED + 1) no matter the uptime.
        let dir = log_dir();
        let active = dir.join(ACTIVE_LOG);
        *guard = None; // close the handle before renaming it
        rotate_files(&dir, &active);
        *guard = open_active(&dir);
        WRITTEN.store(0, Ordering::Relaxed);
    }
}
