#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod detect_windows;
mod logging;
mod sentry;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::Manager;
#[cfg(target_os = "windows")]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

// ── Pending update cache ──────────────────────────────────────────────────────
// Holds the Update object returned by check_for_update so install_update can
// use it directly without a second manifest fetch.

struct PendingUpdate(Mutex<Option<Update>>);

/// Store the pending update, recovering the guard if the mutex was poisoned.
///
/// A poisoned lock only means some other thread panicked while holding it; the
/// Option<Update> inside carries no invariant that a panic could have corrupted.
/// Unwrapping would turn an unrelated panic into a hard crash of the whole app
/// mid-set, so we take the value and carry on.
fn set_pending(pending: &tauri::State<'_, PendingUpdate>, value: Option<Update>) {
    match pending.0.lock() {
        Ok(mut guard) => *guard = value,
        Err(poisoned) => *poisoned.into_inner() = value,
    }
}

/// Take the cached update out, recovering from poisoning for the same reason.
fn take_pending(pending: &tauri::State<'_, PendingUpdate>) -> Option<Update> {
    match pending.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    }
}

// ── Return type ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingTrack {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub is_playing: bool,
    /// Detection path: "media_remote" | "applescript_music" | "applescript_djay"
    ///                 | "djay_no_metadata" | "none"
    pub source: Option<String>,
    /// Human-readable app name, e.g. "Music", "djay", "Spotify".
    pub playback_app: Option<String>,
    pub error: Option<String>,
    /// Full pipeline trace shown in the Bridge debug panel.
    pub diagnostics: Option<String>,
}

// ── Top-level detection pipeline ──────────────────────────────────────────────
//
// Priority (highest → lowest):
//   1. MediaRemote  — works for Spotify, Rekordbox, browser audio, and djay
//                     when it publishes to the system NowPlaying center.
//   2. djay-specific — if djay is running but MediaRemote returned nothing,
//                      try accessibility scraping before anything else.
//   3. Apple Music  — ONLY when Music.app is actively PLAYING (not paused).
//                     A paused Music track must never shadow an active DJ app.
//   4. Nothing detected.

// ── macOS version + Automation-permission helpers ─────────────────────────────

/// Returns the macOS product version as (major, minor), e.g. (15, 6).
///
/// Cached for the process lifetime: the OS version cannot change while we are
/// running, but this used to fork `sw_vers` on every call — and read_media_remote
/// calls it twice per detect, i.e. every 3 seconds for the whole set.
#[cfg(target_os = "macos")]
fn macos_version() -> (u32, u32) {
    use std::sync::OnceLock;
    static VERSION: OnceLock<(u32, u32)> = OnceLock::new();
    *VERSION.get_or_init(|| {
        let out = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut parts = s.trim().split('.');
            let major = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let minor = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            return (major, minor);
        }
        (0, 0)
    })
}

/// True on macOS 15.4+ where Apple restricts the private MediaRemote framework's
/// Now Playing info for non-Apple-signed apps. On these versions MediaRemote's
/// info dict is empty for third-party apps, so AppleScript fallbacks are required.
#[cfg(target_os = "macos")]
fn media_remote_restricted() -> bool {
    let (major, minor) = macos_version();
    major > 15 || (major == 15 && minor >= 4)
}

/// Detects the AppleScript "not authorized to send Apple events" (TCC) error,
/// which means the user hasn't granted Decks Bridge Automation permission for
/// the target app in System Settings → Privacy & Security → Automation.
#[cfg(target_os = "macos")]
fn is_automation_permission_error(stderr: &str) -> bool {
    stderr.contains("-1743")
        || stderr.contains("Not authorized to send Apple events")
        || stderr.contains("not allowed to send Apple events")
        || stderr.contains("not authorised")
        || stderr.contains("-25211")
}

// ── Accessibility permission (needed to read djay Pro's UI) ───────────────────
//
// Reading another app's UI elements via System Events requires the CALLING app
// to hold Accessibility permission (System Settings → Privacy & Security →
// Accessibility). This is separate from Automation permission. On macOS 15.4+
// MediaRemote is dead and djay Pro has no scripting dictionary, so Accessibility
// scraping is the only way to read djay — hence this check.

#[cfg(target_os = "macos")]
fn has_accessibility_permission() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

/// Shows the system "grant Accessibility" prompt at most once per app run.
#[cfg(target_os = "macos")]
fn prompt_accessibility_once() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PROMPTED: AtomicBool = AtomicBool::new(false);
    if PROMPTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // AXIsProcessTrustedWithOptions({ kAXTrustedCheckOptionPrompt: true })
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    }
    unsafe {
        use objc::{class, msg_send, sel, sel_impl};
        // Build @{ "AXTrustedCheckOptionPrompt": @YES } as a CFDictionary-compatible NSDictionary.
        let key: *mut objc::runtime::Object = {
            let s = std::ffi::CString::new("AXTrustedCheckOptionPrompt").unwrap();
            msg_send![class!(NSString), stringWithUTF8String: s.as_ptr()]
        };
        let yes: *mut objc::runtime::Object = msg_send![class!(NSNumber), numberWithBool: true];
        let dict: *mut objc::runtime::Object =
            msg_send![class!(NSDictionary), dictionaryWithObject: yes forKey: key];
        let _ = AXIsProcessTrustedWithOptions(dict as *const std::ffi::c_void);
    }
}

/// Outcome of an AppleScript player-state query against Music/Spotify.
#[cfg(target_os = "macos")]
enum PlayerOutcome {
    /// Player is actively playing and we read its metadata.
    Track(NowPlayingTrack),
    /// Player is running but paused/stopped — not the active source.
    NotPlaying,
    /// App is running but Bridge lacks Automation permission to read it.
    PermissionDenied,
}

// ── Per-source "usable track" attempts ────────────────────────────────────────
//
// Each returns Some(track) ONLY when that app currently has a readable track
// (title present). They emit no "app open but idle" messaging — that stays in
// detect(). Used by (a) the DJ-first Auto priority and (b) the forced-source
// selector, so a DJ app with a live track wins over Apple Music / Spotify.

#[cfg(target_os = "macos")]
fn attempt_djay_track() -> Option<NowPlayingTrack> {
    if running_djay_process_name().is_none() {
        return None;
    }
    try_djay_accessibility(&mut Vec::new())
}

#[cfg(target_os = "macos")]
fn attempt_serato_track() -> Option<NowPlayingTrack> {
    if !is_process_running("Serato DJ Pro") {
        return None;
    }
    let np = serato_now_playing()?;
    if !np.is_playing {
        return None;
    }
    Some(NowPlayingTrack {
        title:        Some(np.name),
        artist:       np.artist,
        is_playing:   true,
        source:       Some("serato_pro_sqlite".into()),
        playback_app: Some("Serato DJ Pro".into()),
        ..Default::default()
    })
}

#[cfg(target_os = "macos")]
fn attempt_rekordbox_track() -> Option<NowPlayingTrack> {
    if !is_process_running("rekordbox") {
        return None;
    }
    let (title, artist) = rekordbox_now_playing()?;
    Some(NowPlayingTrack {
        title:        Some(title),
        artist,
        is_playing:   true,
        source:       Some("rekordbox_ax".into()),
        playback_app: Some("rekordbox".into()),
        ..Default::default()
    })
}

#[cfg(target_os = "macos")]
fn attempt_apple_music_track() -> Option<NowPlayingTrack> {
    if !is_process_running("Music") {
        return None;
    }
    match try_applescript_apple_music(&mut Vec::new()) {
        PlayerOutcome::Track(t) => Some(t),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn attempt_spotify_track() -> Option<NowPlayingTrack> {
    if !is_process_running("Spotify") {
        return None;
    }
    match try_applescript_spotify(&mut Vec::new()) {
        PlayerOutcome::Track(t) => Some(t),
        _ => None,
    }
}

/// Detection when the user has forced a specific Now Playing source. Only the
/// chosen source is attempted; if it has no readable track we return a warning
/// and DO NOT silently fall back to another app. "auto" (or unknown) → detect().
#[cfg(target_os = "macos")]
pub fn detect_forced(source: &str) -> NowPlayingTrack {
    let (track, app, hint): (Option<NowPlayingTrack>, &str, &str) = match source {
        "djay" => (
            attempt_djay_track(),
            "djay Pro",
            "Open djay Pro, load a track onto a deck, and make sure its window is visible. \
             djay Pro also needs Accessibility permission.",
        ),
        "serato" | "serato_pro" => (
            attempt_serato_track(),
            "Serato DJ Pro",
            "Open Serato DJ Pro and PLAY a track (not just load/preview) — Decks Bridge reads \
             the current track from Serato's play history.",
        ),
        "rekordbox" => (
            attempt_rekordbox_track(),
            "rekordbox",
            "Open rekordbox, load and play a track on a deck. rekordbox also needs \
             Accessibility permission.",
        ),
        "apple_music" => (
            attempt_apple_music_track(),
            "Apple Music",
            "Open Apple Music and play a track. Decks Bridge may need Automation permission \
             (System Settings → Privacy & Security → Automation).",
        ),
        "spotify" => (
            attempt_spotify_track(),
            "Spotify",
            "Open Spotify and play a track. Decks Bridge may need Automation permission \
             (System Settings → Privacy & Security → Automation).",
        ),
        _ => return detect(),
    };

    if let Some(t) = track {
        logging::write_line("detect", &format!(
            "chosen={app} (forced source) title={:?} artist={:?}", t.title, t.artist));
        return t;
    }

    NowPlayingTrack {
        source:       Some("forced_no_track".into()),
        playback_app: Some(app.into()),
        error:        Some(format!(
            "{app} is set as your Now Playing source, but no track is playing there yet. {hint}"
        )),
        diagnostics: Some(format!("forced_source={source} no_track")),
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
pub fn detect() -> NowPlayingTrack {
    let mut diag: Vec<String> = Vec::new();

    // ── 1. MediaRemote / Control Center dictionary — source of truth ──────────
    //
    // Covers: Apple Music, Spotify, browser audio, djay Pro (when publishing),
    // Rekordbox, VirtualDJ — anything that registers with macOS Now Playing.
    //
    // Rule: a dictionary with valid title + artist is usable Now Playing metadata
    // and is accepted immediately — even if isPlaying is false, playback state is
    // missing, the app is djay Pro, album is empty, or artwork is missing.
    // "djay is open" must never override active MediaRemote metadata.
    //
    // (On macOS 15.4+ this dict is NULL for third-party apps, so we fall through.)
    let mr = read_media_remote(&mut diag);
    if mr.title.is_some() && mr.artist.is_some() {
        eprintln!(
            "[detect] MediaRemote ✓ title={:?} artist={:?} app={:?} isPlaying={}",
            mr.title, mr.artist, mr.playback_app, mr.is_playing
        );
        logging::write_line("detect", &format!(
            "chosen=MediaRemote reason=valid_title+artist title={:?} artist={:?} isPlaying={}",
            mr.title, mr.artist, mr.is_playing
        ));
        return mr;
    }
    // Title without artist: still prefer it over app-open fallbacks, but let the
    // AppleScript paths try first in case they can supply a complete pair.
    let mr_title_only = if mr.title.is_some() { Some(mr) } else { None };

    // ── Process snapshot (only reached when MediaRemote has nothing) ──────────
    let music_running     = is_process_running("Music");
    let spotify_running   = is_process_running("Spotify");
    let djay_app          = running_djay_process_name();
    let serato_running    = is_process_running("Serato DJ Pro");
    let rekordbox_running = is_process_running("rekordbox");
    let virtualdj_running = is_process_running("VirtualDJ");

    diag.push(format!(
        "apps=music:{} spotify:{} djay:{} serato:{} rekordbox:{} virtualdj:{}",
        music_running, spotify_running,
        djay_app.as_deref().unwrap_or("none"),
        serato_running, rekordbox_running, virtualdj_running
    ));
    eprintln!(
        "[detect] MR gave no title — music={} spotify={} djay={:?} serato={} rekordbox={} vdj={}",
        music_running, spotify_running, djay_app,
        serato_running, rekordbox_running, virtualdj_running
    );

    // ── 1.5 DJ-app priority (Auto) ────────────────────────────────────────────
    //
    // Decks Bridge is a DJ tool: when a DJ app has a live track it must win over
    // Apple Music / Spotify. Priority: djay Pro → Serato DJ Pro → rekordbox.
    // Each attempt returns a track ONLY when the app actually has one loaded/
    // playing, so a merely-open DJ app never blocks Apple Music / Spotify. The
    // detailed "open but idle" / "needs Accessibility" messaging is handled by
    // steps 4–6 below, reached only when none of these yields a track.
    if djay_app.is_some() {
        if let Some(track) = attempt_djay_track() {
            diag.push("auto=djay".into());
            logging::write_line("detect", &format!(
                "chosen=djay (auto priority) title={:?} artist={:?}", track.title, track.artist));
            return NowPlayingTrack { diagnostics: Some(diag.join(" | ")), ..track };
        }
    }
    if serato_running {
        if let Some(track) = attempt_serato_track() {
            diag.push("auto=serato".into());
            logging::write_line("detect", &format!(
                "chosen=Serato DJ Pro (auto priority) title={:?} artist={:?}", track.title, track.artist));
            return NowPlayingTrack { diagnostics: Some(diag.join(" | ")), ..track };
        }
    }
    if rekordbox_running {
        if let Some(track) = attempt_rekordbox_track() {
            diag.push("auto=rekordbox".into());
            logging::write_line("detect", &format!(
                "chosen=rekordbox (auto priority) title={:?} artist={:?}", track.title, track.artist));
            return NowPlayingTrack { diagnostics: Some(diag.join(" | ")), ..track };
        }
    }

    // ── 2. Apple Music AppleScript ────────────────────────────────────────────
    //
    // Primary path on macOS 15.4+ where MediaRemote is restricted. Fires when
    // Apple Music is the active player but djay (or another app) has taken the
    // NP registration slot, or when MediaRemote returns nothing at all.
    if music_running {
        match try_applescript_apple_music(&mut diag) {
            PlayerOutcome::Track(track) => {
                eprintln!("[detect] Apple Music ✓ via AppleScript");
                logging::write_line("detect", &format!("source=Apple Music title={:?}", track.title));
                return track;
            }
            PlayerOutcome::PermissionDenied => {
                // Apple Music is running but Bridge can't read it. Per the
                // detection contract, Apple Music must win over djay — surface a
                // clear permission message instead of falling through to djay.
                diag.push("apple_music=PERMISSION_DENIED".into());
                logging::write_line("detect", "Apple Music running but Automation permission denied");
                return NowPlayingTrack {
                    source:       Some("apple_music_permission".into()),
                    playback_app: Some("Apple Music".into()),
                    error:        Some(
                        "Apple Music is playing but Decks Bridge needs permission to read it. \
                         Open System Settings → Privacy & Security → Automation → Decks Bridge, \
                         turn on Music, then click Refresh."
                            .into(),
                    ),
                    diagnostics: Some(diag.join(" | ")),
                    ..Default::default()
                };
            }
            PlayerOutcome::NotPlaying => { /* fall through */ }
        }
    }

    // ── 3. Spotify AppleScript ────────────────────────────────────────────────
    if spotify_running {
        match try_applescript_spotify(&mut diag) {
            PlayerOutcome::Track(track) => {
                eprintln!("[detect] Spotify ✓ via AppleScript");
                logging::write_line("detect", &format!("source=Spotify title={:?}", track.title));
                return track;
            }
            PlayerOutcome::PermissionDenied => {
                diag.push("spotify=PERMISSION_DENIED".into());
                logging::write_line("detect", "Spotify running but Automation permission denied");
                return NowPlayingTrack {
                    source:       Some("spotify_permission".into()),
                    playback_app: Some("Spotify".into()),
                    error:        Some(
                        "Spotify is playing but Decks Bridge needs permission to read it. \
                         Open System Settings → Privacy & Security → Automation → Decks Bridge, \
                         turn on Spotify, then click Refresh."
                            .into(),
                    ),
                    diagnostics: Some(diag.join(" | ")),
                    ..Default::default()
                };
            }
            PlayerOutcome::NotPlaying => { /* fall through */ }
        }
    }

    // ── 3.5 MediaRemote title-only ────────────────────────────────────────────
    //
    // If MediaRemote gave a title but no artist (rare), that active metadata
    // still beats an "app is open" fallback — never let djay override it.
    if let Some(track) = mr_title_only {
        eprintln!("[detect] MediaRemote (title-only) ✓ title={:?}", track.title);
        logging::write_line("detect", &format!(
            "chosen=MediaRemote reason=title_only title={:?}", track.title));
        return track;
    }

    // ── 4. djay-specific detection ────────────────────────────────────────────
    //
    // djay has no scripting dictionary and MediaRemote is dead on 15.4+, so we
    // read its window via the direct Accessibility C API. Only reached when
    // Apple Music and Spotify are not the active source.
    if let Some(ref app_name) = djay_app {
        let _ = app_name;
        if let Some(track) = try_djay_accessibility(&mut diag) {
            eprintln!("[detect] djay ✓ via direct Accessibility API");
            logging::write_line("detect", &format!(
                "chosen=djay reason=accessibility title={:?} artist={:?}", track.title, track.artist));
            return track;
        }

        // AX read failed. On macOS 15.4+ MediaRemote is dead and djay has no
        // scripting dictionary, so Accessibility is the ONLY way to read djay.
        // If we lack that permission, say so explicitly (and prompt once) rather
        // than the misleading "not publishing metadata".
        if !has_accessibility_permission() {
            diag.push("djay_needs_accessibility=true".into());
            eprintln!("[detect] djay running but Bridge lacks Accessibility permission");
            logging::write_line("detect", "djay detected but Accessibility permission missing");
            prompt_accessibility_once();
            return NowPlayingTrack {
                source:       Some("djay_needs_accessibility".into()),
                playback_app: Some("djay Pro".into()),
                error:        Some(
                    "djay Pro is detected, but macOS doesn't expose its track info to apps. \
                     Grant Decks Bridge Accessibility permission (System Settings → Privacy & \
                     Security → Accessibility), then click Refresh. Or use Manual Mode."
                        .into(),
                ),
                diagnostics: Some(diag.join(" | ")),
                ..Default::default()
            };
        }

        diag.push("djay_no_metadata=true".into());
        eprintln!("[detect] djay running, have accessibility, but no readable track");
        logging::write_line("detect",
            "djay running, accessibility OK, but no readable track (window hidden or no track loaded)");
        return NowPlayingTrack {
            source:       Some("djay_no_metadata".into()),
            playback_app: Some(app_name.clone()),
            error:        Some(
                "djay Pro is open but no track is readable yet. Load a track into a deck \
                 and make sure the djay window is visible, then click Refresh."
                    .into(),
            ),
            diagnostics: Some(diag.join(" | ")),
            ..Default::default()
        };
    }

    // ── 5. Serato DJ Pro — read the current track from its SQLite history ─────
    //
    // Serato doesn't publish to macOS Now Playing (MediaRemote blocked on 15.4+)
    // and its UI exposes no Accessibility text. But Serato DJ Pro records plays
    // to …/Serato/Library/master.sqlite; the most-recently-started row still
    // playing (end_time = -1) is the current track. Requires the Pro process to
    // be running AND a deck actually playing — so we never send a stale track.
    if serato_running {
        if let Some(np) = serato_now_playing() {
            if np.is_playing {
                diag.push(format!("serato_pro_sqlite=OK(deck={},id={})", np.deck, np.id));
                logging::write_line("detect", &format!(
                    "chosen=Serato DJ Pro (SQLite history) title={:?} artist={:?} deck={}",
                    np.name, np.artist, np.deck));
                return NowPlayingTrack {
                    title:        Some(np.name),
                    artist:       np.artist,
                    is_playing:   true,
                    source:       Some("serato_pro_sqlite".into()),
                    playback_app: Some("Serato DJ Pro".into()),
                    diagnostics:  Some(diag.join(" | ")),
                    ..Default::default()
                };
            }
        }
        // Serato Pro open but no deck currently playing.
        diag.push("serato_no_track=true".into());
        return NowPlayingTrack {
            source:       Some("serato_no_track".into()),
            playback_app: Some("Serato DJ Pro".into()),
            error:        Some(
                "Serato DJ Pro is open but no deck is playing. Load and play a track — \
                 Decks Bridge reads the current track from Serato's history."
                    .into(),
            ),
            diagnostics: Some(diag.join(" | ")),
            ..Default::default()
        };
    }

    // ── 6. rekordbox — read the loaded deck's title/artist from Accessibility ──
    //
    // rekordbox doesn't publish to macOS Now Playing (MediaRemote blocked on
    // 15.4+) and its library DB is encrypted. But rekordbox 7 exposes the loaded
    // track's title and artist as AXStaticText just before the deck BPM, which
    // rekordbox_now_playing() parses via the direct AXUIElement C API.
    if rekordbox_running {
        if let Some((title, artist)) = rekordbox_now_playing() {
            diag.push(format!("rekordbox_ax=OK(title={title:?})"));
            logging::write_line("detect", &format!(
                "chosen=rekordbox (Accessibility deck text) title={title:?} artist={artist:?}"));
            return NowPlayingTrack {
                title:        Some(title),
                artist,
                is_playing:   true,
                source:       Some("rekordbox_ax".into()),
                playback_app: Some("rekordbox".into()),
                diagnostics:  Some(diag.join(" | ")),
                ..Default::default()
            };
        }
        // rekordbox open but no track readable from the deck text yet.
        diag.push("rekordbox_no_track=true".into());
        return NowPlayingTrack {
            source:       Some("rekordbox_no_track".into()),
            playback_app: Some("rekordbox".into()),
            error:        Some(
                "rekordbox is open but no track could be read from the deck yet. \
                 Load and play a track on a deck — Decks Bridge reads the current \
                 track from rekordbox's deck display."
                    .into(),
            ),
            diagnostics: Some(diag.join(" | ")),
            ..Default::default()
        };
    }

    if virtualdj_running {
        diag.push("virtualdj_no_metadata=true".into());
        return NowPlayingTrack {
            source:       Some("virtualdj_no_metadata".into()),
            playback_app: Some("VirtualDJ".into()),
            error:        Some(
                "VirtualDJ is running but does not publish track metadata to macOS \
                 Now Playing. Use Manual Mode to send tracks to Decks."
                    .into(),
            ),
            diagnostics: Some(diag.join(" | ")),
            ..Default::default()
        };
    }

    // ── 6. Nothing ────────────────────────────────────────────────────────────
    diag.push("source=none".into());
    NowPlayingTrack {
        source:      Some("none".into()),
        diagnostics: Some(diag.join(" | ")),
        ..Default::default()
    }
}

// ── Process helpers ───────────────────────────────────────────────────────────

/// Snapshot of running process names, cached briefly.
///
/// detect() asks about six or more apps per poll, and each question used to
/// fork+exec its own `pgrep`. At a 3s poll for a four-hour set that is tens of
/// thousands of process spawns on a machine that is also running a DJ rig. One
/// `ps` answers every question instead.
///
/// The TTL is well under the poll interval, so each detect still sees a fresh
/// process list — it only collapses the burst of lookups *within* a single
/// detect into one spawn. Process state cannot meaningfully change inside that
/// window given detection is already sampled every 3s.
/// Run `f` against the cached process-name list, refreshing it if stale.
///
/// Takes a closure rather than returning the Vec so callers borrow the cached
/// list instead of cloning it: detect() asks about ~10 apps per poll, and
/// cloning a ~500-entry Vec<String> each time would trade the fork/exec we just
/// removed for thousands of allocations per poll.
#[cfg(target_os = "macos")]
fn with_process_names<R>(f: impl FnOnce(&[String]) -> R) -> R {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_millis(1_000);

    // Poisoning is recovered rather than unwrapped: a stale process list is
    // never a reason to crash the app mid-set.
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    let fresh = guard
        .as_ref()
        .is_some_and(|(at, _)| at.elapsed() < TTL);

    if !fresh {
        // -A all processes, -c the executable name only (no args, no path),
        // -o comm= suppresses the header. Verified against `pgrep -xi` on the
        // live process table: preserves names containing spaces ("Serato DJ
        // Pro") and does not truncate.
        let names: Vec<String> = std::process::Command::new("ps")
            .args(["-Ac", "-o", "comm="])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        *guard = Some((Instant::now(), names));
    }

    match guard.as_ref() {
        Some((_, names)) => f(names),
        None => f(&[]),
    }
}

/// Returns true if `process_name` is currently in the macOS process list.
/// Matches the previous `pgrep -xi` semantics: exact name, case-insensitive.
#[cfg(target_os = "macos")]
fn is_process_running(process_name: &str) -> bool {
    with_process_names(|names| names.iter().any(|n| n.eq_ignore_ascii_case(process_name)))
}

/// Returns the running djay process name, or None if djay is not open.
/// Tries several known bundle/process names across djay versions.
#[cfg(target_os = "macos")]
fn running_djay_process_name() -> Option<String> {
    // pgrep matches against the process name (argv[0] basename).
    // Different djay versions use different names.
    for name in &["djay", "djay Pro", "djay Pro AI", "djay Pro 2", "djay2"] {
        if is_process_running(name) {
            eprintln!("[detect] djay process found: {:?}", name);
            return Some((*name).to_string());
        }
    }
    None
}

// ── djay detection ────────────────────────────────────────────────────────────
//
// djay Pro has no AppleScript dictionary, and on macOS 15.4+ MediaRemote is dead
// for third-party apps, so the ONLY way to read djay's current track is the
// Accessibility API. We use the direct AXUIElement C API (not osascript →
// System Events): the direct API uses the "Accessibility" permission the user
// grants to Decks Bridge, and — proven by the diagnostic probe — reliably reads
// djay's window text, e.g. AXStaticText "Abanikanda (feat. Naira Marley)" /
// "Zinoleesky". The old System-Events path needed a *different* permission
// (Automation → System Events) and kept failing.

#[cfg(target_os = "macos")]
fn try_djay_accessibility(diag: &mut Vec<String>) -> Option<NowPlayingTrack> {
    if !has_accessibility_permission() {
        diag.push("djay_ax=NOT_TRUSTED".into());
        return None; // detect() surfaces a "grant Accessibility" message
    }

    for pid in djay_pids() {
        // Cap the tree walk — djay's deck title/artist appear in the first few
        // AXStaticText elements, so a small cap keeps each poll fast.
        let (had_windows, pairs) = ax_api::read_app_texts(pid, 160);
        let (title, artist) = djay_title_artist_from_texts(&pairs);
        diag.push(format!(
            "djay_ax pid={} windows={} elems={} title={:?}",
            pid, had_windows, pairs.len(), title
        ));
        if let Some(title) = title {
            if !title.trim().is_empty() {
                return Some(NowPlayingTrack {
                    title:        Some(title),
                    artist,
                    is_playing:   true, // djay deck has a loaded track → treat as active
                    source:       Some("accessibility_djay".into()),
                    playback_app: Some("djay Pro".into()),
                    diagnostics:  Some(diag.join(" | ")),
                    ..Default::default()
                });
            }
        }
    }
    None
}

// ── Apple Music detection ─────────────────────────────────────────────────────
//
// Returns Track ONLY when Music.app player state is PLAYING.
// A paused Music track must never shadow an active DJ application.
// PermissionDenied is surfaced distinctly so djay can't win when Apple Music is
// actually the source but Bridge lacks Automation permission.

#[cfg(target_os = "macos")]
fn try_applescript_apple_music(diag: &mut Vec<String>) -> PlayerOutcome {
    let script = r#"
tell application "Music"
    set s to player state as text
    if s is "playing" then
        set t to name of current track
        set a to artist of current track
        set al to album of current track
        set p to player position
        return "PLAYING|||" & t & "|||" & a & "|||" & al & "|||" & p
    end if
    return "STATE|||" & s
end tell
"#;

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output();

    match out {
        Err(e) => {
            diag.push(format!("as_music=SPAWN_ERROR:{}", e));
            eprintln!("[AS/Music] osascript spawn error: {}", e);
            PlayerOutcome::NotPlaying
        }
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            eprintln!("[AS/Music] stdout={:?}  stderr={:?}", s, err);
            logging::write_line("mediaremote", &format!("AppleMusic AS stdout={:?} stderr={:?}", s, err));

            if is_automation_permission_error(&err) {
                diag.push("as_music=PERMISSION_DENIED".into());
                return PlayerOutcome::PermissionDenied;
            }

            if !s.starts_with("PLAYING|||") {
                // "STATE|||paused" / "STATE|||stopped" → not the active source.
                diag.push(format!("as_music={}", s));
                return PlayerOutcome::NotPlaying;
            }

            let parts: Vec<&str> = s.splitn(5, "|||").collect();
            let title    = parts.get(1).copied().unwrap_or("").trim().to_string();
            let artist   = parts.get(2).copied().unwrap_or("").trim().to_string();
            let album    = parts.get(3).copied().unwrap_or("").trim().to_string();
            let position = parts.get(4).copied().unwrap_or("").trim();

            eprintln!("[AS/Music] PLAYING title={:?} artist={:?} elapsed={}", title, artist, position);
            logging::write_line("mediaremote",
                &format!("AppleMusic PLAYING title={:?} artist={:?} album={:?} elapsed={}", title, artist, album, position));

            if title.is_empty() {
                diag.push("as_music=PLAYING_NO_TITLE".into());
                return PlayerOutcome::NotPlaying;
            }

            diag.push(format!("as_music=OK(PLAYING:{})", title));
            PlayerOutcome::Track(NowPlayingTrack {
                title:        Some(title),
                artist:       if artist.is_empty() { None } else { Some(artist) },
                album:        if album.is_empty() { None } else { Some(album) },
                is_playing:   true,
                source:       Some("applescript_music".into()),
                playback_app: Some("Apple Music".into()),
                diagnostics:  Some(diag.join(" | ")),
                ..Default::default()
            })
        }
    }
}

// ── Spotify AppleScript detection ────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn try_applescript_spotify(diag: &mut Vec<String>) -> PlayerOutcome {
    let script = r#"tell application "Spotify"
    if player state is playing then
        set t to name of current track
        set a to artist of current track
        set al to album of current track
        set p to player position
        return "PLAYING|||" & t & "|||" & a & "|||" & al & "|||" & p
    end if
    return "NOT_PLAYING"
end tell"#;

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output();

    match out {
        Err(e) => {
            diag.push(format!("as_spotify=SPAWN_ERROR:{}", e));
            eprintln!("[AS/Spotify] osascript spawn error: {}", e);
            PlayerOutcome::NotPlaying
        }
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            eprintln!("[AS/Spotify] stdout={:?}  stderr={:?}", s, err);
            logging::write_line("mediaremote", &format!("Spotify AS stdout={:?} stderr={:?}", s, err));

            if is_automation_permission_error(&err) {
                diag.push("as_spotify=PERMISSION_DENIED".into());
                return PlayerOutcome::PermissionDenied;
            }

            if !s.starts_with("PLAYING|||") {
                diag.push(format!("as_spotify={}", s));
                return PlayerOutcome::NotPlaying;
            }

            let parts: Vec<&str> = s.splitn(5, "|||").collect();
            let title    = parts.get(1).copied().unwrap_or("").trim().to_string();
            let artist   = parts.get(2).copied().unwrap_or("").trim().to_string();
            let album    = parts.get(3).copied().unwrap_or("").trim().to_string();
            let position = parts.get(4).copied().unwrap_or("").trim();

            eprintln!("[AS/Spotify] PLAYING title={:?} artist={:?} elapsed={}", title, artist, position);

            if title.is_empty() {
                diag.push("as_spotify=PLAYING_NO_TITLE".into());
                return PlayerOutcome::NotPlaying;
            }

            diag.push(format!("as_spotify=OK({})", title));
            PlayerOutcome::Track(NowPlayingTrack {
                title:        Some(title),
                artist:       if artist.is_empty() { None } else { Some(artist) },
                album:        if album.is_empty() { None } else { Some(album) },
                is_playing:   true,
                source:       Some("applescript_spotify".into()),
                playback_app: Some("Spotify".into()),
                diagnostics:  Some(diag.join(" | ")),
                ..Default::default()
            })
        }
    }
}

// ── MediaRemote raw diagnostic dump ───────────────────────────────────────────
//
// Invoked via `Decks Bridge.app/Contents/MacOS/decks-bridge --dump-nowplaying`.
// Fetches the Now Playing info dict UNCONDITIONALLY (ignores isPlaying) and
// prints every key with its value description, plus client name/bundle/isPlaying.
// This is how we empirically confirm which keys djay Pro / Apple Music expose.

#[cfg(target_os = "macos")]
fn dump_now_playing_raw() {
    use std::ffi::c_void;
    unsafe {
        let framework =
            b"/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote\0";
        let handle = libc::dlopen(
            framework.as_ptr() as *const libc::c_char,
            libc::RTLD_LAZY | libc::RTLD_LOCAL,
        );
        if handle.is_null() {
            println!("DUMP: dlopen FAILED");
            return;
        }
        println!("DUMP: dlopen OK");

        extern "C" {
            fn dispatch_get_global_queue(identifier: i64, flags: usize) -> *mut c_void;
        }
        let queue = dispatch_get_global_queue(0, 0);

        let (major, minor) = macos_version();
        println!("DUMP: macOS={}.{} restricted_expected={}", major, minor, media_remote_restricted());

        let playing = mr_is_playing(handle, queue);
        println!("DUMP: isPlaying={}", playing);

        let (app, bundle) = mr_client_name(handle, queue);
        println!("DUMP: clientDisplayName={:?} bundleId={:?}", app, bundle);

        // Fetch dict unconditionally and print every key → description.
        let pairs = dump_dict_all(handle, queue);
        println!("DUMP: dict has {} keys", pairs.len());
        for (k, v) in &pairs {
            println!("DUMP:   {} = {}", k, v);
        }
        libc::dlclose(handle);
        println!("DUMP: done");
    }
}

/// Fetch the Now Playing info dict unconditionally and return every
/// (key, value-description) pair. Used only by the --dump-nowplaying diagnostic.
#[cfg(target_os = "macos")]
unsafe fn dump_dict_all(
    handle: *mut std::ffi::c_void,
    queue: *mut std::ffi::c_void,
) -> Vec<(String, String)> {
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;
    use objc::{msg_send, sel, sel_impl};

    let sym = b"MRMediaRemoteGetNowPlayingInfo\0";
    let fn_ptr = libc::dlsym(handle, sym.as_ptr() as *const libc::c_char);
    if fn_ptr.is_null() {
        return vec![("<error>".into(), "symbol missing".into())];
    }

    let result: Arc<Mutex<Option<Vec<(String, String)>>>> = Arc::new(Mutex::new(None));
    let ready  = Arc::new((Mutex::new(false), Condvar::new()));
    let r_cb   = result.clone();
    let rdy_cb = ready.clone();

    let cb = block::ConcreteBlock::new(move |dict: *mut objc::runtime::Object| {
        let mut out: Vec<(String, String)> = Vec::new();
        if dict.is_null() {
            out.push(("<dict>".into(), "NULL".into()));
        } else {
            let all_keys: *mut objc::runtime::Object = msg_send![dict, allKeys];
            let count: usize = msg_send![all_keys, count];
            for i in 0..count {
                let key: *mut objc::runtime::Object = msg_send![all_keys, objectAtIndex: i];
                let key_s = obj_str(key).unwrap_or_else(|| "<non-string-key>".into());
                let val: *mut objc::runtime::Object = msg_send![dict, objectForKey: key];
                let desc: *mut objc::runtime::Object = if val.is_null() {
                    std::ptr::null_mut()
                } else {
                    msg_send![val, description]
                };
                let val_s = obj_str(desc).unwrap_or_else(|| "<nil>".into());
                // Truncate long values (e.g. artwork data) for readability.
                let val_s = if val_s.len() > 120 { format!("{}…({} bytes)", &val_s[..120], val_s.len()) } else { val_s };
                out.push((key_s, val_s));
            }
        }
        *r_cb.lock().unwrap() = Some(out);
        let (lock, cvar) = &*rdy_cb;
        *lock.lock().unwrap() = true;
        cvar.notify_one();
    });
    let cb = cb.copy();

    type MRFn = unsafe extern "C" fn(*mut std::ffi::c_void, *const std::ffi::c_void);
    let f: MRFn = std::mem::transmute(fn_ptr);
    f(queue, (&*cb) as *const block::Block<(*mut objc::runtime::Object,), ()> as *const std::ffi::c_void);

    let (lock, cvar) = &*ready;
    let g = lock.lock().unwrap();
    let _ = cvar.wait_timeout_while(g, Duration::from_secs(2), |&mut v| !v);
    let out = result.lock().unwrap().clone();
    out.unwrap_or_else(|| vec![("<error>".into(), "TIMEOUT".into())])
}

// ── MediaRemote path ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn read_media_remote(diag: &mut Vec<String>) -> NowPlayingTrack {
    use std::ffi::c_void;

    unsafe {
        let framework =
            b"/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote\0";
        let handle = libc::dlopen(
            framework.as_ptr() as *const libc::c_char,
            libc::RTLD_LAZY | libc::RTLD_LOCAL,
        );
        if handle.is_null() {
            diag.push("mr_dlopen=FAIL".into());
            eprintln!("[MR] dlopen failed");
            return NowPlayingTrack::default();
        }
        diag.push("mr_dlopen=OK".into());

        extern "C" {
            fn dispatch_get_global_queue(identifier: i64, flags: usize) -> *mut c_void;
        }
        let queue = dispatch_get_global_queue(0, 0);

        let (major, minor) = macos_version();
        let restricted = media_remote_restricted();
        diag.push(format!("macos={}.{}", major, minor));

        let api_playing = mr_is_playing(handle, queue);
        diag.push(format!("mr_playing={}", api_playing));

        // Read the active client (app) name + bundle id for logging even when
        // nothing is playing — helps explain what OWNS the NP slot.
        let (app_name, bundle_id) = mr_client_name(handle, queue);
        logging::write_line(
            "mediaremote",
            &format!(
                "poll: isPlaying={} app={:?} bundleId={:?} macOS={}.{} restricted={}",
                api_playing, app_name, bundle_id, major, minor, restricted
            ),
        );

        // Always fetch the info dict — do NOT gate on api_playing.
        //
        // The MediaRemote dict is the system Now Playing / Control Center source
        // of truth. Some apps (notably djay Pro) publish valid title/artist while
        // MRMediaRemoteGetNowPlayingApplicationIsPlaying reports false. The rule
        // (per product spec) is: valid title + artist = usable metadata, even if
        // isPlaying is false, playback state is missing, or album/artwork are
        // empty. detect() decides acceptance based on title+artist presence.
        //
        // Note: on macOS 15.4+ this dict comes back NULL for third-party apps
        // (Apple gated it behind a private entitlement), so this returns nothing
        // and detect() falls through to the AppleScript / Accessibility paths.
        diag.push(format!("mr_app={}", app_name.as_deref().unwrap_or("nil")));
        eprintln!("[MR] api_playing={}  app={:?}  bundle={:?}", api_playing, app_name, bundle_id);

        let (mut track, key_log) = mr_now_playing_info(handle, queue);
        diag.extend(key_log);

        libc::dlclose(handle);

        // Explain the common failure mode: empty dict on macOS 15.4+.
        if track.title.is_none() {
            if restricted {
                diag.push("mr_note=EMPTY_dict_restricted_macOS_15.4+".into());
                logging::write_line(
                    "mediaremote",
                    "MediaRemote returned no metadata — expected on macOS 15.4+ where Apple \
                     restricts Now Playing info for third-party apps. Falling back to AppleScript/Accessibility.",
                );
            } else {
                diag.push("mr_note=EMPTY_dict".into());
                logging::write_line("mediaremote", "MediaRemote info dict was empty (no active session).");
            }
        }

        // is_playing is informational only — acceptance is based on title+artist.
        // If the dict gave a rate>0 use it; otherwise fall back to the isPlaying
        // callback, but a false here must NOT discard valid title/artist metadata.
        track.is_playing = if track.title.is_some() {
            track.is_playing || api_playing
        } else {
            false
        };
        track.playback_app = app_name;
        track.source = Some("media_remote".into());
        track.diagnostics = Some(diag.join(" | "));

        eprintln!("[MR] final title={:?} artist={:?} is_playing={}",
            track.title, track.artist, track.is_playing);
        track
    }
}

// ── MRMediaRemoteGetNowPlayingApplicationIsPlaying ────────────────────────────

#[cfg(target_os = "macos")]
unsafe fn mr_is_playing(handle: *mut std::ffi::c_void, queue: *mut std::ffi::c_void) -> bool {
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    let sym = b"MRMediaRemoteGetNowPlayingApplicationIsPlaying\0";
    let fn_ptr = libc::dlsym(handle, sym.as_ptr() as *const libc::c_char);
    if fn_ptr.is_null() {
        return false;
    }

    let result: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
    let ready   = Arc::new((Mutex::new(false), Condvar::new()));
    let r_cb    = result.clone();
    let rdy_cb  = ready.clone();

    let cb = block::ConcreteBlock::new(move |playing: u8| {
        *r_cb.lock().unwrap() = Some(playing != 0);
        let (lock, cvar) = &*rdy_cb;
        *lock.lock().unwrap() = true;
        cvar.notify_one();
    });
    let cb = cb.copy();

    type Fn = unsafe extern "C" fn(*mut std::ffi::c_void, *const std::ffi::c_void);
    let f: Fn = std::mem::transmute(fn_ptr);
    f(queue, (&*cb) as *const block::Block<(u8,), ()> as *const std::ffi::c_void);

    let (lock, cvar) = &*ready;
    let g = lock.lock().unwrap();
    let _ = cvar.wait_timeout_while(g, Duration::from_millis(800), |&mut v| !v);
    let val = result.lock().unwrap();
    val.unwrap_or(false)
}

// ── MRMediaRemoteGetNowPlayingClient ──────────────────────────────────────────

/// Returns (displayName, bundleIdentifier) of the active Now Playing client.
#[cfg(target_os = "macos")]
unsafe fn mr_client_name(
    handle: *mut std::ffi::c_void,
    queue: *mut std::ffi::c_void,
) -> (Option<String>, Option<String>) {
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    let sym = b"MRMediaRemoteGetNowPlayingClient\0";
    let fn_ptr = libc::dlsym(handle, sym.as_ptr() as *const libc::c_char);
    if fn_ptr.is_null() {
        return (None, None);
    }

    // (display_name, bundle_id)
    let result: Arc<Mutex<(Option<String>, Option<String>)>> =
        Arc::new(Mutex::new((None, None)));
    let ready   = Arc::new((Mutex::new(false), Condvar::new()));
    let r_cb    = result.clone();
    let rdy_cb  = ready.clone();

    let cb = block::ConcreteBlock::new(move |client: *mut objc::runtime::Object| {
        if !client.is_null() {
            use objc::{msg_send, sel, sel_impl};
            let display = obj_str(msg_send![client, displayName]);
            let bundle  = obj_str(msg_send![client, bundleIdentifier]);
            *r_cb.lock().unwrap() = (display, bundle);
        }
        let (lock, cvar) = &*rdy_cb;
        *lock.lock().unwrap() = true;
        cvar.notify_one();
    });
    let cb = cb.copy();

    type Fn = unsafe extern "C" fn(*mut std::ffi::c_void, *const std::ffi::c_void);
    let f: Fn = std::mem::transmute(fn_ptr);
    f(
        queue,
        (&*cb) as *const block::Block<(*mut objc::runtime::Object,), ()>
            as *const std::ffi::c_void,
    );

    let (lock, cvar) = &*ready;
    let g = lock.lock().unwrap();
    let _ = cvar.wait_timeout_while(g, Duration::from_millis(800), |&mut v| !v);
    let (display, bundle) = result.lock().unwrap().clone();
    // Prefer displayName; fall back to bundle id for the app label.
    let name = display.or_else(|| bundle.clone());
    (name, bundle)
}

// ── MRMediaRemoteGetNowPlayingInfo ────────────────────────────────────────────

#[cfg(target_os = "macos")]
unsafe fn mr_now_playing_info(
    handle: *mut std::ffi::c_void,
    queue: *mut std::ffi::c_void,
) -> (NowPlayingTrack, Vec<String>) {
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    let sym = b"MRMediaRemoteGetNowPlayingInfo\0";
    let fn_ptr = libc::dlsym(handle, sym.as_ptr() as *const libc::c_char);
    if fn_ptr.is_null() {
        return (
            NowPlayingTrack {
                error: Some("MRMediaRemoteGetNowPlayingInfo symbol missing".into()),
                ..Default::default()
            },
            vec!["mr_info_sym=MISSING".into()],
        );
    }

    let k_title   = load_nsstring(handle, b"kMRMediaRemoteNowPlayingInfoTitle\0");
    let k_artist  = load_nsstring(handle, b"kMRMediaRemoteNowPlayingInfoArtist\0");
    let k_album   = load_nsstring(handle, b"kMRMediaRemoteNowPlayingInfoAlbum\0");
    let k_rate    = load_nsstring(handle, b"kMRMediaRemoteNowPlayingInfoPlaybackRate\0");
    let k_elapsed = load_nsstring(handle, b"kMRMediaRemoteNowPlayingInfoElapsedTime\0");

    let result: Arc<Mutex<Option<(NowPlayingTrack, Vec<String>)>>> =
        Arc::new(Mutex::new(None));
    let ready  = Arc::new((Mutex::new(false), Condvar::new()));
    let r_cb   = result.clone();
    let rdy_cb = ready.clone();

    let k_title_u   = k_title   as usize;
    let k_artist_u  = k_artist  as usize;
    let k_album_u   = k_album   as usize;
    let k_rate_u    = k_rate    as usize;
    let k_elapsed_u = k_elapsed as usize;

    let cb = block::ConcreteBlock::new(move |dict: *mut objc::runtime::Object| {
        if dict.is_null() {
            eprintln!("[MR] dict=NULL");
            logging::write_line("mediaremote", "info dict = NULL (no active Now Playing session)");
            *r_cb.lock().unwrap() = Some((NowPlayingTrack::default(), vec!["mr_dict=NULL".into()]));
        } else {
            let raw_keys = collect_dict_keys(dict);
            eprintln!("[MR] dict keys ({}): {:?}", raw_keys.len(), raw_keys);

            let k_t = k_title_u  as *mut objc::runtime::Object;
            let k_a = k_artist_u as *mut objc::runtime::Object;
            let k_al = k_album_u as *mut objc::runtime::Object;
            let k_r = k_rate_u   as *mut objc::runtime::Object;
            let k_e = k_elapsed_u as *mut objc::runtime::Object;

            let title = dict_nsstr(dict, k_t)
                .or_else(|| dict_strlit(dict, "kMRMediaRemoteNowPlayingInfoTitle"))
                .or_else(|| dict_strlit(dict, "Title"));
            let artist = dict_nsstr(dict, k_a)
                .or_else(|| dict_strlit(dict, "kMRMediaRemoteNowPlayingInfoArtist"))
                .or_else(|| dict_strlit(dict, "Artist"));
            let album = dict_nsstr(dict, k_al)
                .or_else(|| dict_strlit(dict, "kMRMediaRemoteNowPlayingInfoAlbum"))
                .or_else(|| dict_strlit(dict, "Album"));
            let rate = dict_f64_nskey(dict, k_r)
                .or_else(|| dict_f64_strlit(dict, "kMRMediaRemoteNowPlayingInfoPlaybackRate"))
                .or_else(|| dict_f64_strlit(dict, "PlaybackRate"))
                .unwrap_or(0.0);
            let elapsed = dict_f64_nskey(dict, k_e)
                .or_else(|| dict_f64_strlit(dict, "kMRMediaRemoteNowPlayingInfoElapsedTime"))
                .or_else(|| dict_f64_strlit(dict, "ElapsedTime"))
                .unwrap_or(0.0);

            eprintln!("[MR] parsed title={:?} artist={:?} album={:?} rate={} elapsed={}",
                title, artist, album, rate, elapsed);
            logging::write_line("mediaremote", &format!(
                "info dict: keys={} title={:?} artist={:?} album={:?} rate={} elapsed={:.1}s",
                raw_keys.len(), title, artist, album, rate, elapsed
            ));

            let key_diag = vec![
                format!("mr_dict_keys={}", raw_keys.len()),
                format!("mr_title={}", if title.is_some() { "OK" } else { "MISSING" }),
                format!("mr_rate={}", rate),
                format!("mr_elapsed={:.1}", elapsed),
                format!("mr_raw_keys={}", raw_keys.join(",")),
            ];

            let track = NowPlayingTrack {
                title,
                artist,
                album,
                is_playing: rate > 0.0,
                source: Some("media_remote".into()),
                ..Default::default()
            };
            *r_cb.lock().unwrap() = Some((track, key_diag));
        }
        let (lock, cvar) = &*rdy_cb;
        *lock.lock().unwrap() = true;
        cvar.notify_one();
    });
    let cb = cb.copy();

    type MRFn = unsafe extern "C" fn(*mut std::ffi::c_void, *const std::ffi::c_void);
    let f: MRFn = std::mem::transmute(fn_ptr);
    f(
        queue,
        (&*cb) as *const block::Block<(*mut objc::runtime::Object,), ()>
            as *const std::ffi::c_void,
    );

    let (lock, cvar) = &*ready;
    let g = lock.lock().unwrap();
    let timed_out = cvar
        .wait_timeout_while(g, Duration::from_secs(2), |&mut v| !v)
        .map(|(_, t)| t.timed_out())
        .unwrap_or(true);

    if timed_out {
        eprintln!("[MR] timeout");
        return (NowPlayingTrack::default(), vec!["mr_info=TIMEOUT".into()]);
    }

    let val = result.lock().unwrap().clone();
    val.unwrap_or_else(|| (NowPlayingTrack::default(), vec!["mr_info=NO_RESULT".into()]))
}

// ── ObjC / NSDictionary helpers ───────────────────────────────────────────────

#[cfg(target_os = "macos")]
unsafe fn load_nsstring(
    handle: *mut std::ffi::c_void,
    sym: &[u8],
) -> *mut objc::runtime::Object {
    let ptr = libc::dlsym(handle, sym.as_ptr() as *const libc::c_char);
    if ptr.is_null() {
        return std::ptr::null_mut();
    }
    *(ptr as *const *mut objc::runtime::Object)
}

#[cfg(target_os = "macos")]
unsafe fn collect_dict_keys(dict: *mut objc::runtime::Object) -> Vec<String> {
    use objc::{msg_send, sel, sel_impl};
    let all_keys: *mut objc::runtime::Object = msg_send![dict, allKeys];
    let count: usize = msg_send![all_keys, count];
    let mut keys = Vec::with_capacity(count.min(40));
    for i in 0..count.min(40) {
        let key: *mut objc::runtime::Object = msg_send![all_keys, objectAtIndex: i];
        if let Some(s) = obj_str(key) {
            keys.push(s);
        }
    }
    keys
}

#[cfg(target_os = "macos")]
unsafe fn obj_str(obj: *mut objc::runtime::Object) -> Option<String> {
    use objc::{msg_send, sel, sel_impl};
    if obj.is_null() {
        return None;
    }
    let ptr: *const std::os::raw::c_char = msg_send![obj, UTF8String];
    if ptr.is_null() {
        return None;
    }
    let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "macos")]
unsafe fn dict_nsstr(
    dict: *mut objc::runtime::Object,
    key: *mut objc::runtime::Object,
) -> Option<String> {
    use objc::{msg_send, sel, sel_impl};
    if key.is_null() {
        return None;
    }
    let val: *mut objc::runtime::Object = msg_send![dict, objectForKey: key];
    obj_str(val)
}

#[cfg(target_os = "macos")]
unsafe fn dict_strlit(dict: *mut objc::runtime::Object, key: &str) -> Option<String> {
    use objc::{class, msg_send, sel, sel_impl};
    let ckey = std::ffi::CString::new(key).ok()?;
    let ns_key: *mut objc::runtime::Object =
        msg_send![class!(NSString), stringWithUTF8String: ckey.as_ptr()];
    if ns_key.is_null() {
        return None;
    }
    let val: *mut objc::runtime::Object = msg_send![dict, objectForKey: ns_key];
    obj_str(val)
}

#[cfg(target_os = "macos")]
unsafe fn dict_f64_nskey(
    dict: *mut objc::runtime::Object,
    key: *mut objc::runtime::Object,
) -> Option<f64> {
    use objc::{msg_send, sel, sel_impl};
    if key.is_null() {
        return None;
    }
    let val: *mut objc::runtime::Object = msg_send![dict, objectForKey: key];
    if val.is_null() {
        return None;
    }
    Some(msg_send![val, doubleValue])
}

#[cfg(target_os = "macos")]
unsafe fn dict_f64_strlit(dict: *mut objc::runtime::Object, key: &str) -> Option<f64> {
    use objc::{class, msg_send, sel, sel_impl};
    let ckey = std::ffi::CString::new(key).ok()?;
    let ns_key: *mut objc::runtime::Object =
        msg_send![class!(NSString), stringWithUTF8String: ckey.as_ptr()];
    if ns_key.is_null() {
        return None;
    }
    let val: *mut objc::runtime::Object = msg_send![dict, objectForKey: ns_key];
    if val.is_null() {
        return None;
    }
    Some(msg_send![val, doubleValue])
}

// ── Direct Accessibility C API (djay reader) ──────────────────────────────────
//
// This reads djay's window text via the AXUIElement* C API DIRECTLY from our
// process. This is the path the "Accessibility" permission actually enables.
// (Our old osascript→System Events path needs *Automation* permission for
// "System Events" instead — a different toggle — which is why granting
// Accessibility didn't help before.)
//
// CFStringRef / CFArrayRef are toll-free bridged to NSString*/NSArray*, so we
// reuse objc msg_send + obj_str to read values and iterate children.

#[cfg(target_os = "macos")]
mod ax_api {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void, // CFStringRef
            value: *mut *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *mut c_void);
        fn CFGetTypeID(cf: *mut c_void) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
    }

    unsafe fn nsstring(s: &str) -> *mut objc::runtime::Object {
        let c = std::ffi::CString::new(s).unwrap_or_default();
        msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
    }

    /// Read a CFString value as a Rust String — ONLY if it really is a CFString.
    /// (AXValue can return AXValueRef / CFNumber for non-text elements; calling
    /// UTF8String on those throws an ObjC exception that aborts the process.)
    unsafe fn cfstr_to_string(v: *mut c_void) -> Option<String> {
        if v.is_null() || CFGetTypeID(v) != CFStringGetTypeID() {
            return None;
        }
        let obj = v as *mut objc::runtime::Object;
        let ptr: *const std::os::raw::c_char = msg_send![obj, UTF8String];
        if ptr.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
        if s.is_empty() { None } else { Some(s) }
    }

    /// Copy an AX attribute; returns a +1 CF object the caller must CFRelease.
    unsafe fn copy_attr(el: *mut c_void, attr: &str) -> *mut c_void {
        let a = nsstring(attr);
        let mut out: *mut c_void = null_mut();
        let err = AXUIElementCopyAttributeValue(el, a as *const c_void, &mut out);
        if err == 0 { out } else { null_mut() }
    }

    unsafe fn attr_string(el: *mut c_void, attr: &str) -> Option<String> {
        let v = copy_attr(el, attr);
        if v.is_null() {
            return None;
        }
        let s = cfstr_to_string(v);
        CFRelease(v);
        s
    }

    /// Recursively collect (role, value/title) of every element under `el`.
    /// Stops once `out` reaches `max` entries (djay's deck title/artist appear
    /// within the first ~4, so production can cap low and stay fast; the
    /// diagnostic passes a large cap to dump the whole tree).
    unsafe fn walk(el: *mut c_void, depth: u32, out: &mut Vec<(String, String)>, max: usize) {
        if depth > 14 || out.len() >= max {
            return;
        }
        let role = attr_string(el, "AXRole").unwrap_or_default();
        let text = attr_string(el, "AXValue")
            .or_else(|| attr_string(el, "AXTitle"))
            .or_else(|| attr_string(el, "AXDescription"));
        if let Some(t) = text {
            if !t.trim().is_empty() {
                out.push((role.clone(), t.trim().to_string()));
            }
        }
        let children = copy_attr(el, "AXChildren");
        if !children.is_null() {
            // Only iterate if it's genuinely a CFArray.
            if CFGetTypeID(children) == CFArrayGetTypeID() {
                let arr = children as *mut objc::runtime::Object;
                let count: usize = msg_send![arr, count];
                for i in 0..count.min(300) {
                    if out.len() >= max {
                        break;
                    }
                    let child: *mut objc::runtime::Object = msg_send![arr, objectAtIndex: i];
                    walk(child as *mut c_void, depth + 1, out, max);
                }
            }
            CFRelease(children);
        }
    }

    /// Read up to `max` (role, text) pairs from every window of the given pid.
    /// Returns (had_windows, pairs).
    pub fn read_app_texts(pid: i32, max: usize) -> (bool, Vec<(String, String)>) {
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return (false, vec![]);
            }
            let mut out = Vec::new();
            let mut had_windows = false;
            let windows = copy_attr(app, "AXWindows");
            if !windows.is_null() {
                if CFGetTypeID(windows) == CFArrayGetTypeID() {
                    let arr = windows as *mut objc::runtime::Object;
                    let count: usize = msg_send![arr, count];
                    had_windows = count > 0;
                    for i in 0..count {
                        let w: *mut objc::runtime::Object = msg_send![arr, objectAtIndex: i];
                        walk(w as *mut c_void, 0, &mut out, max);
                    }
                }
                CFRelease(windows);
            }
            CFRelease(app);
            (had_windows, out)
        }
    }
}

/// Returns pids of running djay processes (may be more than one).
#[cfg(target_os = "macos")]
fn djay_pids() -> Vec<i32> {
    let mut pids = Vec::new();
    for name in &["djay Pro", "djay", "djay Pro AI"] {
        if let Ok(out) = std::process::Command::new("pgrep").args(["-x", name]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    if !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

/// Extract (title, artist) from djay's AX static texts.
/// djay renders per deck: title, artist, artist, artist. First two uniques win.
#[cfg(target_os = "macos")]
fn djay_title_artist_from_texts(pairs: &[(String, String)]) -> (Option<String>, Option<String>) {
    let mut seen = std::collections::HashSet::new();
    let candidates: Vec<&str> = pairs
        .iter()
        .filter(|(role, _)| role == "AXStaticText")
        .map(|(_, t)| t.as_str())
        .filter(|t| {
            let t = t.trim();
            if t.is_empty() { return false; }
            if t.starts_with('-') && t.contains(':') { return false; } // time codes
            if t.chars().all(|c| c.is_ascii_digit() || c == '%' || c == '.' || c == ':') {
                return false;
            }
            true
        })
        .filter(|t| seen.insert(*t))
        .collect();
    let title = candidates.first().map(|s| s.to_string());
    let artist = candidates.get(1).map(|s| s.to_string());
    (title, artist)
}

// ── Diagnostic probe: tests every detection method, prints raw output ─────────

#[cfg(target_os = "macos")]
fn debug_now_playing_report() -> String {
    use std::fmt::Write as _;
    let mut r = String::new();
    let ts = std::process::Command::new("date").output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let (maj, min) = macos_version();
    let _ = writeln!(r, "==================================================================");
    let _ = writeln!(r, "Decks Bridge — Now Playing Diagnostic Probe");
    let _ = writeln!(r, "timestamp: {ts}");
    let _ = writeln!(r, "macOS: {maj}.{min}   MediaRemote restricted (15.4+): {}", media_remote_restricted());
    let _ = writeln!(r, "==================================================================\n");

    // Collect results for the decision table.
    let mut mr_ffi = (false, None::<String>, None::<String>, String::new());
    let mut objc_bridge = (false, None::<String>, None::<String>, String::new());
    let mut am = (false, None::<String>, None::<String>);
    let mut sp = (false, None::<String>, None::<String>);
    let mut dj = (false, None::<String>, None::<String>);

    // ── METHOD 1: MediaRemote C FFI raw dump ─────────────────────────────────
    let _ = writeln!(r, "── METHOD 1: MediaRemote (C FFI) ─────────────────────────────────");
    unsafe {
        let fw = b"/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote\0";
        let handle = libc::dlopen(fw.as_ptr() as *const libc::c_char, libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if handle.is_null() {
            let _ = writeln!(r, "dlopen: FAIL");
            mr_ffi.3 = "dlopen failed".into();
        } else {
            let _ = writeln!(r, "dlopen: OK");
            extern "C" { fn dispatch_get_global_queue(identifier: i64, flags: usize) -> *mut std::ffi::c_void; }
            let queue = dispatch_get_global_queue(0, 0);
            let is_playing = mr_is_playing(handle, queue);
            let (app, bundle) = mr_client_name(handle, queue);
            let _ = writeln!(r, "MediaRemote call succeeded: true");
            let _ = writeln!(r, "active app name: {:?}", app);
            let _ = writeln!(r, "bundle id: {:?}", bundle);
            let _ = writeln!(r, "isPlaying: {}", is_playing);
            let pairs = dump_dict_all(handle, queue);
            let is_null = pairs.iter().any(|(k, v)| k == "<dict>" && v == "NULL");
            let _ = writeln!(r, "raw dictionary keys: {}", if is_null { 0 } else { pairs.len() });
            for (k, v) in &pairs {
                let _ = writeln!(r, "   [{}] = {}", k, v);
            }
            // Extract candidates from the dict values.
            let getv = |want: &str| pairs.iter().find(|(k, _)| k.contains(want)).map(|(_, v)| v.clone());
            let title  = getv("Title");
            let artist = getv("Artist");
            let album  = getv("Album");
            let elapsed = getv("ElapsedTime");
            let duration = getv("Duration");
            let artwork = pairs.iter().any(|(k, _)| k.contains("Artwork"));
            let _ = writeln!(r, "title candidate:  {:?}", title);
            let _ = writeln!(r, "artist candidate: {:?}", artist);
            let _ = writeln!(r, "album candidate:  {:?}", album);
            let _ = writeln!(r, "artwork present:  {}", artwork);
            let _ = writeln!(r, "elapsed time:     {:?}", elapsed);
            let _ = writeln!(r, "duration:         {:?}", duration);
            let usable = title.is_some() && artist.is_some();
            let _ = writeln!(r, "USABLE_METADATA={}", usable);
            mr_ffi = (usable, title, artist,
                if usable { "title+artist present".into() }
                else if is_null { "dict NULL (blocked on macOS 15.4+)".into() }
                else { "no title/artist in dict".into() });
            libc::dlclose(handle);
        }
    }
    let _ = writeln!(r, "");

    // ── METHOD 2: MediaRemote ObjC higher-level objects ──────────────────────
    let _ = writeln!(r, "── METHOD 2: MediaRemote ObjC bridge (MRNowPlayingRequest…) ──────");
    {
        // Ensure classes are loaded.
        unsafe {
            let fw = b"/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote\0";
            let _ = libc::dlopen(fw.as_ptr() as *const libc::c_char, libc::RTLD_LAZY | libc::RTLD_LOCAL);
        }
        for cls in &["MRNowPlayingRequest", "MRNowPlayingController", "MRContentItem", "MRMediaRemoteControllerServer"] {
            let exists = objc::runtime::Class::get(cls).is_some();
            let _ = writeln!(r, "class {cls}: {}", if exists { "EXISTS" } else { "missing" });
        }
        // Attempt a guarded call on MRNowPlayingRequest.
        if let Some(cls) = objc::runtime::Class::get("MRNowPlayingRequest") {
            unsafe {
                use objc::{msg_send, sel, sel_impl};
                let sel_local = objc::runtime::Sel::register("localNowPlayingItem");
                let responds: bool = msg_send![cls, respondsToSelector: sel_local];
                let _ = writeln!(r, "responds to +localNowPlayingItem: {}", responds);
                if responds {
                    let item: *mut objc::runtime::Object = msg_send![cls, localNowPlayingItem];
                    let _ = writeln!(r, "localNowPlayingItem: {}", if item.is_null() { "nil" } else { "object" });
                    if !item.is_null() {
                        let sel_info = objc::runtime::Sel::register("nowPlayingInfo");
                        let r2: bool = msg_send![item, respondsToSelector: sel_info];
                        if r2 {
                            let info: *mut objc::runtime::Object = msg_send![item, nowPlayingInfo];
                            let _ = writeln!(r, "nowPlayingInfo: {}", if info.is_null() { "nil" } else { "dict" });
                        }
                    }
                }
                objc_bridge.3 = "attempted; see above".into();
            }
        } else {
            objc_bridge.3 = "MRNowPlayingRequest class missing".into();
        }
    }
    let _ = writeln!(r, "");

    // ── METHOD 3: AppleScript (Apple Music + Spotify) ────────────────────────
    let _ = writeln!(r, "── METHOD 3: AppleScript fallback ────────────────────────────────");
    {
        let mut diag = Vec::new();
        if is_process_running("Music") {
            match try_applescript_apple_music(&mut diag) {
                PlayerOutcome::Track(t) => {
                    let _ = writeln!(r, "Apple Music: PLAYING  title={:?} artist={:?}", t.title, t.artist);
                    am = (true, t.title.clone(), t.artist.clone());
                }
                PlayerOutcome::NotPlaying => { let _ = writeln!(r, "Apple Music: not playing/paused"); }
                PlayerOutcome::PermissionDenied => { let _ = writeln!(r, "Apple Music: AUTOMATION PERMISSION DENIED (-1743)"); }
            }
        } else {
            let _ = writeln!(r, "Apple Music: not running");
        }
        if is_process_running("Spotify") {
            match try_applescript_spotify(&mut diag) {
                PlayerOutcome::Track(t) => {
                    let _ = writeln!(r, "Spotify: PLAYING  title={:?} artist={:?}", t.title, t.artist);
                    sp = (true, t.title.clone(), t.artist.clone());
                }
                PlayerOutcome::NotPlaying => { let _ = writeln!(r, "Spotify: not playing/paused"); }
                PlayerOutcome::PermissionDenied => { let _ = writeln!(r, "Spotify: AUTOMATION PERMISSION DENIED (-1743)"); }
            }
        } else {
            let _ = writeln!(r, "Spotify: not running");
        }
    }
    let _ = writeln!(r, "");

    // ── METHOD 4: djay Pro Accessibility (DIRECT AX C API) ───────────────────
    let _ = writeln!(r, "── METHOD 4: djay Pro Accessibility (direct AX C API) ────────────");
    {
        let trusted = has_accessibility_permission();
        let _ = writeln!(r, "AXIsProcessTrusted: {}", trusted);
        let pids = djay_pids();
        let _ = writeln!(r, "djay process found: {}  pids={:?}", !pids.is_empty(), pids);
        let mut any_text = false;
        for pid in &pids {
            let (had_windows, pairs) = ax_api::read_app_texts(*pid, 4000);
            let _ = writeln!(r, "  pid {pid}: windows={} textElements={}", had_windows, pairs.len());
            for (role, text) in pairs.iter().take(40) {
                let _ = writeln!(r, "     {role}: {text}");
            }
            let (title, artist) = djay_title_artist_from_texts(&pairs);
            if title.is_some() {
                let _ = writeln!(r, "  -> title candidate:  {:?}", title);
                let _ = writeln!(r, "  -> artist candidate: {:?}", artist);
                if !any_text {
                    dj = (title.is_some() && artist.is_some(), title, artist);
                }
                any_text = true;
            }
        }
        if pids.is_empty() {
            let _ = writeln!(r, "reason: djay Pro not running");
        } else if !trusted {
            let _ = writeln!(r, "reason: AXIsProcessTrusted=false — grant Accessibility to THIS binary");
        } else if !any_text {
            let _ = writeln!(r, "reason: AX trusted + djay running but no static text (window hidden / no track loaded)");
        }
    }
    let _ = writeln!(r, "");

    // ── METHOD 5: decision table ─────────────────────────────────────────────
    let _ = writeln!(r, "── METHOD 5: decision table ──────────────────────────────────────");
    let row = |name: &str, s: bool, t: &Option<String>, a: &Option<String>, reason: &str| {
        format!("{:<26} success={:<5} title={:<22} artist={:<22} {}\n",
            name, s,
            t.clone().unwrap_or_else(|| "-".into()),
            a.clone().unwrap_or_else(|| "-".into()),
            reason)
    };
    r.push_str(&row("MediaRemote C FFI", mr_ffi.0, &mr_ffi.1, &mr_ffi.2, &mr_ffi.3));
    r.push_str(&row("MediaRemote ObjC/JXA", objc_bridge.0, &objc_bridge.1, &objc_bridge.2, &objc_bridge.3));
    r.push_str(&row("Apple Music", am.0, &am.1, &am.2, ""));
    r.push_str(&row("Spotify", sp.0, &sp.1, &sp.2, ""));
    r.push_str(&row("djay Accessibility", dj.0, &dj.1, &dj.2, ""));

    // Final decision — mirrors detect() priority.
    let _ = writeln!(r, "");
    let (src, t, a, why) =
        if mr_ffi.0 { ("MediaRemote", mr_ffi.1.clone(), mr_ffi.2.clone(), "MediaRemote title+artist") }
        else if am.0 { ("Apple Music", am.1.clone(), am.2.clone(), "Apple Music playing") }
        else if sp.0 { ("Spotify", sp.1.clone(), sp.2.clone(), "Spotify playing") }
        else if dj.0 { ("djay Pro", dj.1.clone(), dj.2.clone(), "djay AX title+artist") }
        else if dj.1.is_some() { ("djay Pro", dj.1.clone(), dj.2.clone(), "djay AX title only") }
        else { ("none", None, None, "no detector produced title+artist") };
    let _ = writeln!(r, "FINAL chosen source: {}", src);
    let _ = writeln!(r, "FINAL title:  {:?}", t);
    let _ = writeln!(r, "FINAL artist: {:?}", a);
    let _ = writeln!(r, "FINAL reason: {}", why);
    let _ = writeln!(r, "==================================================================");
    r
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Write a diagnostic report to the app's LOG DIR (always writable, no TCC) and,
/// best-effort, to ~/Desktop (works only when the caller has Desktop access, e.g.
/// Terminal — the app under its own identity cannot write Desktop). Returns the
/// log-dir path actually written.
#[cfg(target_os = "macos")]
fn write_diag(name: &str, content: &str) -> std::path::PathBuf {
    let dir = logging::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join(name);
    let _ = std::fs::write(&log_path, content);
    if let Some(home) = std::env::var_os("HOME") {
        let desktop = std::path::PathBuf::from(home).join("Desktop").join(name);
        let _ = std::fs::write(&desktop, content); // ignored if Desktop is TCC-blocked
    }
    log_path
}

/// Runs the full diagnostic probe. Writes it to the log dir (and best-effort
/// Desktop) and returns the raw text. macOS only.
#[tauri::command]
fn debug_now_playing() -> String {
    #[cfg(target_os = "macos")]
    {
        let report = debug_now_playing_report();
        let _ = write_diag("decks-bridge-diagnostics.txt", &report);
        report
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Diagnostic probe is macOS-only.".to_string()
    }
}

/// Focused djay check: Accessibility trust + djay AX read ONLY. No MediaRemote,
/// no Music/Spotify AppleScript — so it never blocks on an Automation prompt.
/// Structured result of a djay-only detection check, for both the CLI
/// (--check-djay) and the in-app "Test djay Pro Detection" button.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DjayCheck {
    pub accessibility_trusted: bool,
    pub djay_running: bool,
    pub pids: Vec<i32>,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// "djay Pro" when a track was read, else "none".
    pub source: String,
    /// Path of the running executable's .app bundle.
    pub app_path: String,
    /// Where the app is expected to run from.
    pub expected_path: String,
    /// True when running from the expected /Applications location.
    pub correct_location: bool,
    /// Machine-readable status:
    /// "detected" | "not_trusted" | "djay_not_running" | "djay_no_track" | "wrong_location"
    pub status: String,
    /// Raw text report (for "Copy Diagnostic Report").
    pub report: String,
}

#[cfg(target_os = "macos")]
fn run_djay_check() -> DjayCheck {
    use std::fmt::Write as _;

    let trusted = has_accessibility_permission();
    let pids = djay_pids();

    // Where is this binary running from?
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_str = exe.to_string_lossy().to_string();
    // Strip /Contents/MacOS/decks-bridge → the .app bundle path.
    let app_path = exe_str
        .split("/Contents/MacOS/")
        .next()
        .unwrap_or(&exe_str)
        .to_string();
    let expected_path = "/Applications/Decks Bridge.app".to_string();
    let correct_location = app_path == expected_path;

    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;
    let mut per_pid = String::new();
    for pid in &pids {
        let (had_windows, pairs) = ax_api::read_app_texts(*pid, 160);
        let (t, a) = djay_title_artist_from_texts(&pairs);
        let _ = writeln!(per_pid, "  pid {pid}: windows={} textElements={} title={:?}", had_windows, pairs.len(), t);
        if t.is_some() && title.is_none() {
            title = t;
            artist = a;
        }
    }

    let source = if title.is_some() { "djay Pro" } else { "none" };
    let status = if !trusted {
        "not_trusted"
    } else if pids.is_empty() {
        "djay_not_running"
    } else if title.is_some() {
        "detected"
    } else {
        "djay_no_track"
    };

    // Human-readable raw report (matches the --check-djay text).
    let mut report = String::new();
    let _ = writeln!(report, "AXIsProcessTrusted: {}", trusted);
    let _ = writeln!(report, "djay process found: {}  pids={:?}", !pids.is_empty(), pids);
    report.push_str(&per_pid);
    let _ = writeln!(report, "app path: {}", app_path);
    let _ = writeln!(report, "expected path: {}", expected_path);
    let _ = writeln!(report, "correct location: {}", correct_location);
    let _ = writeln!(report, "FINAL chosen source: {}", source);
    let _ = writeln!(report, "FINAL title:  {:?}", title);
    let _ = writeln!(report, "FINAL artist: {:?}", artist);
    let _ = writeln!(report, "status: {}", status);

    DjayCheck {
        accessibility_trusted: trusted,
        djay_running: !pids.is_empty(),
        pids,
        title,
        artist,
        source: source.to_string(),
        app_path,
        expected_path,
        correct_location,
        status: status.to_string(),
        report,
    }
}

/// Text form of the djay check (used by --check-djay CLI).
#[cfg(target_os = "macos")]
fn check_djay_report() -> String {
    run_djay_check().report
}

/// In-app "Test djay Pro Detection" — runs the djay-only check under the app's
/// real identity, writes the report to the LOG DIR (no Desktop TCC issue), and
/// returns structured results for the Diagnostics UI.
#[tauri::command]
fn check_djay() -> DjayCheck {
    #[cfg(target_os = "macos")]
    {
        let result = run_djay_check();
        let _ = write_diag("decks-bridge-djay-check.txt", &result.report);
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        DjayCheck {
            status: "unsupported".into(),
            report: "djay detection is macOS-only.".into(),
            expected_path: "/Applications/Decks Bridge.app".into(),
            ..Default::default()
        }
    }
}

// ── Serato diagnostic (DIAGNOSTIC-ONLY — Serato is NOT a supported source) ────
//
// Empirically, Serato DJ (Pro & Lite) does NOT publish to macOS MediaRemote /
// Now Playing, and its Qt/OpenGL UI exposes 0 Accessibility text elements — so
// neither of Decks Bridge's detection methods can read Serato's current track.
// This check exists so a Serato DJ gets an HONEST answer instead of silence.

/// Returns (pid, app_bundle_path, bundle_id) for each running Serato process.
#[cfg(target_os = "macos")]
fn serato_apps() -> Vec<(i32, String, String)> {
    let mut out = Vec::new();
    let ps = std::process::Command::new("ps").args(["-Ao", "pid=,comm="]).output();
    if let Ok(o) = ps {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let line = line.trim_start();
            let mut it = line.splitn(2, ' ');
            let pid = it.next().and_then(|p| p.trim().parse::<i32>().ok());
            let comm = it.next().unwrap_or("").trim();
            // Match the MAIN Serato app process (has /Contents/MacOS/), not helpers.
            if let Some(pid) = pid {
                if comm.contains("/Serato DJ") && comm.contains("/Contents/MacOS/")
                    && !comm.contains("crashpad") && !comm.contains("QtWebEngine")
                {
                    let app_path = comm.split("/Contents/MacOS/").next().unwrap_or(comm).to_string();
                    let bundle_id = std::process::Command::new("defaults")
                        .args(["read", &format!("{app_path}/Contents/Info.plist"), "CFBundleIdentifier"])
                        .output()
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .unwrap_or_default();
                    if !out.iter().any(|(p, _, _): &(i32, String, String)| *p == pid) {
                        out.push((pid, app_path, bundle_id));
                    }
                }
            }
        }
    }
    out
}

/// True if Serato history/session files exist that could contain played tracks.
/// Serato DJ Pro records plays to a SQLite database; Serato DJ Lite does not.
#[cfg(target_os = "macos")]
fn serato_history_db() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let p = std::path::PathBuf::from(home)
        .join("Library/Application Support/Serato/Library/master.sqlite");
    if p.exists() { Some(p) } else { None }
}

/// A row from Serato DJ Pro's history.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub struct SeratoNowPlaying {
    pub id: i64,
    pub name: String,
    pub artist: Option<String>,
    pub deck: String,
    /// True when Serato has not written an end_time yet (end_time = -1) — i.e. the
    /// track is currently playing on a deck. This is our reliable "live" signal
    /// AND stale protection: if nothing is playing, no row has end_time = -1.
    pub is_playing: bool,
}

#[cfg(target_os = "macos")]
fn serato_query_row(db: &str, sql: &str) -> Option<String> {
    let out = std::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg("-separator")
        .arg("\u{1f}") // unit separator — won't appear in titles
        .arg(db)
        .arg(sql)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next()?.trim().to_string();
    if line.is_empty() { None } else { Some(line) }
}

#[cfg(target_os = "macos")]
fn serato_parse_row(line: &str, is_playing: bool) -> Option<SeratoNowPlaying> {
    let mut p = line.splitn(4, '\u{1f}');
    let id: i64 = p.next()?.trim().parse().ok()?;
    let name = p.next().unwrap_or("").trim().to_string();
    let artist = p.next().unwrap_or("").trim().to_string();
    let deck = p.next().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(SeratoNowPlaying {
        id,
        name,
        artist: if artist.is_empty() { None } else { Some(artist) },
        deck,
        is_playing,
    })
}

/// Reads Serato DJ Pro's current now-playing track from its SQLite history
/// (…/Serato/Library/master.sqlite → history_entry). Read-only + WAL-safe.
///
/// Validated query: the most-recently-started row that is still playing
/// (end_time = -1) is the current track. `id DESC` (autoincrement) breaks ties
/// between two live decks in favour of the one that started most recently.
/// If no row is currently playing, falls back to the latest overall row with
/// is_playing=false (so the diagnostic can show "last played", but detect()
/// will not send it). Serato DJ Lite has no such DB, so this returns None there.
#[cfg(target_os = "macos")]
fn serato_now_playing() -> Option<SeratoNowPlaying> {
    let db = serato_history_db()?;
    let dbs = db.to_string_lossy().to_string();
    if let Some(l) = serato_query_row(
        &dbs,
        "SELECT id, name, artist, deck FROM history_entry WHERE end_time = -1 ORDER BY id DESC LIMIT 1;",
    ) {
        if let Some(row) = serato_parse_row(&l, true) {
            return Some(row);
        }
    }
    // Nothing currently playing — latest overall row (diagnostic only).
    let l = serato_query_row(
        &dbs,
        "SELECT id, name, artist, deck FROM history_entry ORDER BY id DESC LIMIT 1;",
    )?;
    serato_parse_row(&l, false)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeratoCheck {
    pub serato_found: bool,
    pub edition: String,
    pub bundle_id: String,
    pub pid: Option<i32>,
    pub app_path: String,
    pub accessibility_trusted: bool,
    /// "NULL (no metadata)" or a title string.
    pub media_remote_result: String,
    pub ax_element_count: usize,
    pub readable_text: bool,
    pub db_path: String,
    pub db_readable: bool,
    pub latest_history_id: Option<i64>,
    pub deck: Option<String>,
    pub is_playing: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Method that produced the metadata.
    pub method: String,
    /// "detected" | "serato_not_running" | "not_exposed"
    pub status: String,
    pub verdict: String,
    pub report: String,
}

#[cfg(target_os = "macos")]
fn run_serato_check() -> SeratoCheck {
    use std::fmt::Write as _;

    let trusted = has_accessibility_permission();
    let apps = serato_apps();
    let serato_found = !apps.is_empty();
    let (pid, app_path, bundle_id) = apps
        .first()
        .cloned()
        .map(|(p, a, b)| (Some(p), a, b))
        .unwrap_or((None, String::new(), String::new()));

    let is_pro = app_path.contains("Serato DJ Pro");
    let edition = if is_pro { "Serato DJ Pro" } else if serato_found { "Serato DJ Lite" } else { "Serato" };

    // MediaRemote (blocked on macOS 15.4+).
    let mr = read_media_remote(&mut Vec::new());
    let media_remote_result = match mr.title {
        Some(t) => format!("metadata present: {t}"),
        None => "NULL (no metadata)".to_string(),
    };

    // Accessibility (Serato's Qt/OpenGL UI exposes no text).
    let mut ax_element_count = 0usize;
    let mut ax_sample = String::new();
    if let Some(pid) = pid {
        let (_had_windows, pairs) = ax_api::read_app_texts(pid, 400);
        ax_element_count = pairs.len();
        let texts: Vec<String> = pairs
            .iter()
            .filter(|(role, _)| role == "AXStaticText")
            .map(|(_, t)| t.clone())
            .take(10)
            .collect();
        ax_sample = texts.join(" | ");
    }
    let readable_text = !ax_sample.trim().is_empty();

    // File/history method — Serato DJ Pro's SQLite history (the ONLY method that
    // works: MediaRemote is blocked and the UI has no readable text).
    let db = serato_history_db();
    let db_path = db
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "(not found)".into());
    let db_readable = db.is_some();
    let np = serato_now_playing();
    let latest_history_id = np.as_ref().map(|r| r.id);
    let deck = np.as_ref().map(|r| r.deck.clone());
    let is_playing = np.as_ref().map(|r| r.is_playing).unwrap_or(false);

    // Only treat it as a live "now playing" when a deck is actually playing
    // (end_time = -1). If Serato is open but idle, we surface the last row for
    // diagnostics but mark status accordingly.
    let (title, artist) = match &np {
        Some(r) => (Some(r.name.clone()), r.artist.clone()),
        None => (None, None),
    };

    let method = if title.is_some() { "SQLite History" } else { "none" };
    let source_detected = title.is_some() && is_playing;

    let status = if !serato_found {
        "serato_not_running"
    } else if source_detected {
        "detected"
    } else {
        "not_exposed"
    };

    let verdict = if !serato_found {
        "Serato is not open.".to_string()
    } else if source_detected {
        let a = artist.as_ref().map(|a| format!(" — {a}")).unwrap_or_default();
        format!(
            "{edition} detected through SQLite History. Now playing: {}{a} (deck {}).",
            title.clone().unwrap_or_default(),
            deck.clone().unwrap_or_default()
        )
    } else if title.is_some() {
        format!(
            "{edition} is open but no deck is currently playing (last history entry: {}). \
             Load and play a track, then test again.",
            title.clone().unwrap_or_default()
        )
    } else if is_pro {
        "Serato DJ Pro is open, but no history entry was found yet. Play a track for a \
         few seconds (Serato writes history once a track starts playing), then re-test."
            .to_string()
    } else {
        "Serato DJ Lite is open, but it does not record a SQLite play history, and it \
         exposes no metadata via MediaRemote or Accessibility. Use Manual Mode for Lite."
            .to_string()
    };

    let result_line = if source_detected {
        "RESULT: ✅ Serato DJ Pro detected through SQLite History"
    } else {
        "RESULT: Serato DJ Pro not detected"
    };

    let mut report = String::new();
    let _ = writeln!(report, "Serato Pro running: {}", is_pro && serato_found);
    let _ = writeln!(report, "Serato app found: {serato_found}");
    let _ = writeln!(report, "Serato edition: {edition}");
    let _ = writeln!(report, "Serato bundle id: {}", if bundle_id.is_empty() { "-" } else { &bundle_id });
    let _ = writeln!(report, "Serato process id: {:?}", pid);
    let _ = writeln!(report, "Serato app path: {}", if app_path.is_empty() { "-" } else { &app_path });
    let _ = writeln!(report, "AXIsProcessTrusted: {trusted}");
    let _ = writeln!(report, "MediaRemote result: {media_remote_result}");
    let _ = writeln!(report, "AX elements found: {ax_element_count}");
    let _ = writeln!(report, "AX static-text sample: {}", if ax_sample.is_empty() { "(none)" } else { &ax_sample });
    let _ = writeln!(report, "readable track text found: {}", if readable_text { "yes" } else { "no" });
    let _ = writeln!(report, "SQLite DB path: {db_path}");
    let _ = writeln!(report, "DB readable: {db_readable}");
    let _ = writeln!(report, "latest history id: {:?}", latest_history_id);
    let _ = writeln!(report, "deck: {:?}", deck);
    let _ = writeln!(report, "currently playing (end_time=-1): {is_playing}");
    let _ = writeln!(report, "FINAL source: {}", if source_detected { "Serato DJ Pro" } else { "none" });
    let _ = writeln!(report, "FINAL method: {method}");
    let _ = writeln!(report, "FINAL title:  {:?}", title);
    let _ = writeln!(report, "FINAL artist: {:?}", artist);
    let _ = writeln!(report, "status: {status}");
    let _ = writeln!(report, "verdict: {verdict}");
    let _ = writeln!(report, "{result_line}");

    SeratoCheck {
        serato_found,
        edition: edition.to_string(),
        bundle_id,
        pid,
        app_path,
        accessibility_trusted: trusted,
        media_remote_result,
        ax_element_count,
        readable_text,
        db_path,
        db_readable,
        latest_history_id,
        deck,
        is_playing,
        title,
        artist,
        method: method.to_string(),
        status: status.to_string(),
        verdict,
        report,
    }
}

/// In-app "Test Serato Detection" — diagnostic only. Serato is NOT a supported
/// source; this reports honestly why. Writes the report to the log dir.
#[tauri::command]
fn check_serato() -> SeratoCheck {
    #[cfg(target_os = "macos")]
    {
        let result = run_serato_check();
        let _ = write_diag("decks-bridge-serato-check.txt", &result.report);
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        SeratoCheck {
            status: "unsupported".into(),
            verdict: "Serato detection is macOS-only.".into(),
            report: "Serato detection is macOS-only.".into(),
            ..Default::default()
        }
    }
}

// ── rekordbox diagnostic (DIAGNOSTIC-ONLY — NOT a supported source) ───────────
//
// Empirically (rekordbox 7 on macOS 15.6):
//   • MediaRemote  → NULL (rekordbox doesn't publish Now Playing; blocked anyway)
//   • Accessibility → 0 AX elements (opaque custom UI, like Serato)
//   • Local files   → the library AND play history live in an ENCRYPTED SQLCipher
//                     DB (~/Library/Pioneer/rekordbox/master.db). Writes on
//                     play go to master.db-wal. We do NOT bypass encryption.
//                     Unencrypted caches (networkAnalyze6.db) hold only file
//                     paths — no title/artist and no "current track".
// So rekordbox's current track is NOT readable through any allowed method.
// (A future option would be the ProDJ Link / StagelinQ network protocol, or OCR.)

#[cfg(target_os = "macos")]
fn rekordbox_apps() -> Vec<(i32, String, String)> {
    let mut out = Vec::new();
    if let Ok(o) = std::process::Command::new("ps").args(["-Ao", "pid=,comm="]).output() {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let line = line.trim_start();
            let mut it = line.splitn(2, ' ');
            let pid = it.next().and_then(|p| p.trim().parse::<i32>().ok());
            let comm = it.next().unwrap_or("").trim();
            if let Some(pid) = pid {
                // Main rekordbox process only (not rekordboxAgent/helpers/GPU).
                if comm.ends_with("/Contents/MacOS/rekordbox")
                    && !comm.contains("rekordboxAgent")
                    && !comm.contains("Helper")
                {
                    let app_path = comm.split("/Contents/MacOS/").next().unwrap_or(comm).to_string();
                    let bundle_id = std::process::Command::new("defaults")
                        .args(["read", &format!("{app_path}/Contents/Info.plist"), "CFBundleIdentifier"])
                        .output().ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .unwrap_or_default();
                    if !out.iter().any(|(p, _, _): &(i32, String, String)| *p == pid) {
                        out.push((pid, app_path, bundle_id));
                    }
                }
            }
        }
    }
    out
}

/// Ordered AXStaticText values from rekordbox's window (direct AX C API).
#[cfg(target_os = "macos")]
fn rekordbox_ax_texts(pid: i32) -> Vec<String> {
    ax_api::read_app_texts(pid, 400)
        .1
        .into_iter()
        .filter(|(role, _)| role == "AXStaticText")
        .map(|(_, t)| t)
        .collect()
}

/// True if a token is a rekordbox BPM display, e.g. "128.00" (a float in a
/// plausible BPM range). Time codes ("-02:33", "00:18") contain ':' and won't
/// parse; pitch values (".9") parse but fall below the range.
#[cfg(target_os = "macos")]
fn looks_like_bpm(t: &str) -> bool {
    if !t.contains('.') {
        return false;
    }
    t.parse::<f64>().map(|v| (40.0..=300.0).contains(&v)).unwrap_or(false)
}

/// Extract (title, artist) from rekordbox's deck AXStaticText.
/// rekordbox renders each loaded deck as: … title, artist, BPM, … — so the two
/// texts immediately before a BPM value are the title and artist. Returns the
/// FIRST deck found (deck A / master in the common single-deck case).
#[cfg(target_os = "macos")]
fn rekordbox_extract_track(texts: &[String]) -> Option<(String, Option<String>)> {
    for i in 2..texts.len() {
        if looks_like_bpm(&texts[i]) {
            let title = texts[i - 2].trim().to_string();
            let artist = texts[i - 1].trim().to_string();
            // Guard: title must be real text, not a time/number/blank.
            let bad = title.is_empty()
                || title.contains(':')
                || title.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-');
            if !bad {
                return Some((
                    title,
                    if artist.is_empty() || artist.contains(':') { None } else { Some(artist) },
                ));
            }
        }
    }
    None
}

/// Read rekordbox's current deck track via Accessibility. Requires AX trust.
#[cfg(target_os = "macos")]
fn rekordbox_now_playing() -> Option<(String, Option<String>)> {
    if !has_accessibility_permission() {
        return None;
    }
    for (pid, _, _) in rekordbox_apps() {
        let texts = rekordbox_ax_texts(pid);
        if let Some(t) = rekordbox_extract_track(&texts) {
            return Some(t);
        }
    }
    None
}

/// Path to rekordbox's main library DB (encrypted). Returns (path, is_readable).
#[cfg(target_os = "macos")]
fn rekordbox_master_db() -> Option<(String, bool)> {
    let home = std::env::var_os("HOME")?;
    let p = std::path::PathBuf::from(home).join("Library/Pioneer/rekordbox/master.db");
    if !p.exists() {
        return None;
    }
    // Reading the schema (sqlite_master) requires decrypting the file, so this
    // fails on an encrypted (SQLCipher) DB but succeeds on plain SQLite.
    // (`SELECT 1;` would falsely succeed — it never touches the file.)
    let readable = std::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg(p.to_string_lossy().as_ref())
        .arg("SELECT count(*) FROM sqlite_master;")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Some((p.to_string_lossy().to_string(), readable))
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxCheck {
    pub rekordbox_running: bool,
    pub bundle_id: String,
    pub pid: Option<i32>,
    pub app_path: String,
    pub version: String,
    pub accessibility_trusted: bool,
    pub media_remote_result: String,
    pub ax_element_count: usize,
    pub db_path: String,
    /// True only if the DB is plain (unencrypted) SQLite we may read.
    pub db_readable: bool,
    pub db_encrypted: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub method: String,
    /// "detected" | "rekordbox_not_running" | "not_readable"
    pub status: String,
    pub verdict: String,
    pub report: String,
}

#[cfg(target_os = "macos")]
fn run_rekordbox_check() -> RekordboxCheck {
    use std::fmt::Write as _;

    let trusted = has_accessibility_permission();
    let apps = rekordbox_apps();
    let running = !apps.is_empty();
    let (pid, app_path, bundle_id) = apps
        .first().cloned()
        .map(|(p, a, b)| (Some(p), a, b))
        .unwrap_or((None, String::new(), String::new()));
    let version = if app_path.is_empty() {
        String::new()
    } else {
        std::process::Command::new("defaults")
            .args(["read", &format!("{app_path}/Contents/Info.plist"), "CFBundleShortVersionString"])
            .output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };

    // MediaRemote.
    let mr = read_media_remote(&mut Vec::new());
    let media_remote_result = match mr.title {
        Some(t) => format!("metadata present: {t}"),
        None => "NULL (no metadata)".to_string(),
    };

    // Accessibility: count elements, sample the static-text content, AND parse
    // the current deck's track. rekordbox 7 exposes the loaded track's title and
    // artist as AXStaticText just before the deck BPM (e.g. "Demo Track 1",
    // "Loopmasters", "128.00"). rekordbox_extract_track() reads that pattern.
    let mut ax_element_count = 0usize;
    let mut ax_sample = String::new();
    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;
    if let Some(pid) = pid {
        let pairs = ax_api::read_app_texts(pid, 400).1;
        ax_element_count = pairs.len();
        let texts: Vec<String> = pairs
            .iter()
            .filter(|(role, _)| role == "AXStaticText")
            .map(|(_, t)| t.clone())
            .collect();
        ax_sample = texts.iter().take(60).cloned().collect::<Vec<_>>().join(" | ");
        if let Some((t, a)) = rekordbox_extract_track(&texts) {
            title = Some(t);
            artist = a;
        }
    }

    // Local DB — present but encrypted?
    let db = rekordbox_master_db();
    let (db_path, db_readable) = db
        .clone()
        .unwrap_or_else(|| ("(not found)".to_string(), false));
    let db_encrypted = db.is_some() && !db_readable;

    let detected = title.is_some();
    let method = if detected { "Accessibility (deck text)" } else { "none" };

    let status = if detected {
        "detected"
    } else if !running {
        "rekordbox_not_running"
    } else {
        "not_readable"
    };
    let verdict = if detected {
        format!(
            "rekordbox detected via Accessibility. Current track: {}{}",
            title.as_deref().unwrap_or(""),
            artist.as_deref().map(|a| format!(" — {a}")).unwrap_or_default(),
        )
    } else if !running {
        "rekordbox is not open.".to_string()
    } else {
        "rekordbox is open, but Decks Bridge could not read the current track from \
         its Accessibility deck text yet. Load and PLAY a track on a deck, then \
         re-test. rekordbox does not publish to macOS Now Playing (MediaRemote) and \
         its library/history DB is ENCRYPTED (master.db), which we do not bypass. \
         If detection keeps failing, use Manual Mode."
            .to_string()
    };
    let result_line = if detected {
        "RESULT: ✅ rekordbox detected"
    } else {
        "RESULT: rekordbox not detected"
    };

    let mut report = String::new();
    let _ = writeln!(report, "rekordbox running: {running}");
    let _ = writeln!(report, "app path: {}", if app_path.is_empty() { "-" } else { &app_path });
    let _ = writeln!(report, "bundle id: {}", if bundle_id.is_empty() { "-" } else { &bundle_id });
    let _ = writeln!(report, "version: {}", if version.is_empty() { "-" } else { &version });
    let _ = writeln!(report, "-- detection method results --");
    let _ = writeln!(report, "MediaRemote: {media_remote_result}");
    let _ = writeln!(report, "Accessibility: AXIsProcessTrusted={trusted}, AX elements={ax_element_count}");
    let _ = writeln!(report, "AX static-text sample: {}", if ax_sample.is_empty() { "(none)" } else { &ax_sample });
    let _ = writeln!(report, "local DB path: {db_path}");
    let _ = writeln!(report, "local DB readable (unencrypted): {db_readable}");
    let _ = writeln!(report, "local DB encrypted: {db_encrypted}");
    let _ = writeln!(report, "XML/logs: no current-track title/artist (settings/playlists only)");
    let _ = writeln!(report, "FINAL source: {}", if detected { "rekordbox" } else { "none" });
    let _ = writeln!(report, "FINAL method: {method}");
    let _ = writeln!(report, "FINAL title:  {:?}", title);
    let _ = writeln!(report, "FINAL artist: {:?}", artist);
    let _ = writeln!(report, "status: {status}");
    let _ = writeln!(report, "verdict: {verdict}");
    let _ = writeln!(report, "{result_line}");

    RekordboxCheck {
        rekordbox_running: running,
        bundle_id, pid, app_path, version,
        accessibility_trusted: trusted,
        media_remote_result, ax_element_count,
        db_path, db_readable, db_encrypted,
        title, artist,
        method: method.to_string(),
        status: status.to_string(),
        verdict, report,
    }
}

/// In-app "Test rekordbox Detection" — diagnostic only (rekordbox is NOT a
/// supported source; reports honestly why). Writes the report to the log dir.
#[tauri::command]
fn check_rekordbox() -> RekordboxCheck {
    #[cfg(target_os = "macos")]
    {
        let result = run_rekordbox_check();
        let _ = write_diag("decks-bridge-rekordbox-check.txt", &result.report);
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        RekordboxCheck {
            status: "unsupported".into(),
            verdict: "rekordbox detection is macOS-only.".into(),
            report: "rekordbox detection is macOS-only.".into(),
            ..Default::default()
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_now_playing() -> NowPlayingTrack {
    detect()
}

/// Now Playing detection honoring a user-selected source. "auto" (or empty) runs
/// the full priority pipeline; a specific source is forced (no silent fallback).
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_now_playing_source(source: String) -> NowPlayingTrack {
    if source.is_empty() || source == "auto" {
        detect()
    } else {
        detect_forced(&source)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_now_playing() -> NowPlayingTrack {
    detect_windows::detect()
}

/// Windows has no per-app DJ source selector yet — always runs auto detection.
#[cfg(target_os = "windows")]
#[tauri::command]
fn get_now_playing_source(_source: String) -> NowPlayingTrack {
    detect_windows::detect()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
#[tauri::command]
fn get_now_playing() -> NowPlayingTrack {
    NowPlayingTrack {
        error: Some("Now Playing detection is not supported on this platform".into()),
        ..Default::default()
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
#[tauri::command]
fn get_now_playing_source(_source: String) -> NowPlayingTrack {
    NowPlayingTrack {
        error: Some("Now Playing detection is not supported on this platform".into()),
        ..Default::default()
    }
}

#[tauri::command]
fn log_diagnostic(category: String, message: String) {
    logging::write_line(&category, &message);
}

#[tauri::command]
fn get_log_dir() -> String {
    logging::log_dir().display().to_string()
}

// ── Updater ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Check for an available update.
/// Returns Some(UpdateInfo) if a newer version is available, None if up-to-date.
/// Errors (network failure, manifest parse error) are returned as Err(String).
/// The Update object is cached in PendingUpdate state for install_update to use.
#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    eprintln!("[update] check — current version: {}", current);

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                current_version: current,
                body: update.body.clone(),
                date: update.date.map(|d| d.to_string()),
            };
            eprintln!(
                "[update] update available: {} → {}  notes={:?}",
                info.current_version, info.version, info.body
            );
            // Cache the update so install_update doesn't need to re-check.
            set_pending(&pending, Some(update));
            Ok(Some(info))
        }
        Ok(None) => {
            eprintln!("[update] already up-to-date");
            set_pending(&pending, None);
            Ok(None)
        }
        Err(e) => {
            let msg = format!("{e}");
            eprintln!("[update] check failed: {msg}");
            logging::write_line("update", &format!("check failed: {msg}"));

            // ONLY a genuine 404 means "no manifest published for this channel
            // yet" — that is legitimately 'no update available', not an error.
            //
            // Everything else (HTTP 5xx, malformed manifest, signature
            // verification failure, TLS error) is REAL breakage and must reach
            // the DJ. Reporting those as "up-to-date" would make a completely
            // broken update system indistinguishable from a healthy one — and
            // the updater is the only channel we have to ship a fix, so a silent
            // failure here is the one failure we can never afford.
            let manifest_absent = msg.contains("404") || msg.contains("Not Found");

            if manifest_absent {
                eprintln!("[update] no manifest published — treating as up-to-date");
                set_pending(&pending, None);
                return Ok(None);
            }

            set_pending(&pending, None);
            Err(msg)
        }
    }
}

/// Download and install the pending update.
/// Emits tauri events: "update://progress" with `{ downloaded, total }` bytes.
/// Call relaunch() from the frontend after this resolves.
/// Uses the cached update from check_for_update — no second manifest fetch.
#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    eprintln!("[update] starting download + install…");

    // Use cached update. If not present, do a fresh check as fallback.
    let update = take_pending(&pending);

    let update = match update {
        Some(u) => {
            eprintln!("[update] using cached update v{}", u.version);
            u
        }
        None => {
            eprintln!("[update] no cached update — running fresh check");
            let updater = app
                .updater_builder()
                .build()
                .map_err(|e| format!("Failed to build updater: {e}"))?;
            updater
                .check()
                .await
                .map_err(|e| format!("Check failed: {e}"))?
                .ok_or_else(|| "No update available".to_string())?
        }
    };

    eprintln!("[update] downloading v{}…", update.version);

    let app2 = app.clone();
    update
        .download_and_install(
            move |chunk_len, total| {
                eprintln!(
                    "[update] progress: {} / {}",
                    chunk_len,
                    total.unwrap_or(0)
                );
                // Emit progress event to the frontend.
                let _ = app2.emit(
                    "update://progress",
                    serde_json::json!({ "downloaded": chunk_len, "total": total }),
                );
            },
            || {
                eprintln!("[update] download finished — installing…");
            },
        )
        .await
        .map_err(|e| {
            eprintln!("[update] install failed: {e}");
            format!("{e}")
        })?;

    eprintln!("[update] install complete — waiting for frontend to relaunch");
    Ok(())
}

// ── Windows tray ──────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "tray-show", "Show Decks Bridge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Decks Bridge", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .ok_or("missing default window icon")?
        .clone();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Decks Bridge")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    logging::write_line("tray", "system tray initialized");
    Ok(())
}

/// Bring the main window back: Windows tray "Show"/left-click, macOS Dock click.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    // Diagnostic mode: dump the raw MediaRemote Now Playing dictionary and exit.
    // Run: "Decks Bridge.app/Contents/MacOS/decks-bridge" --dump-nowplaying
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--dump-nowplaying") {
        dump_now_playing_raw();
        return;
    }

    // Diagnostic mode: run the full detection pipeline once and print the result.
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--detect-once") {
        let t = detect();
        println!("DETECT: source={:?}", t.source);
        println!("DETECT: playback_app={:?}", t.playback_app);
        println!("DETECT: title={:?}", t.title);
        println!("DETECT: artist={:?}", t.artist);
        println!("DETECT: album={:?}", t.album);
        println!("DETECT: is_playing={}", t.is_playing);
        println!("DETECT: error={:?}", t.error);
        println!("DETECT: diagnostics={:?}", t.diagnostics);
        return;
    }

    // Diagnostic mode: force a specific Now Playing source (the selector's
    // behavior). Usage: --detect-source rekordbox|djay|serato|apple_music|spotify|auto
    #[cfg(target_os = "macos")]
    if let Some(pos) = std::env::args().position(|a| a == "--detect-source") {
        let src = std::env::args().nth(pos + 1).unwrap_or_else(|| "auto".to_string());
        let t = if src == "auto" { detect() } else { detect_forced(&src) };
        println!("DETECT[{src}]: source={:?}", t.source);
        println!("DETECT[{src}]: playback_app={:?}", t.playback_app);
        println!("DETECT[{src}]: title={:?}", t.title);
        println!("DETECT[{src}]: artist={:?}", t.artist);
        println!("DETECT[{src}]: is_playing={}", t.is_playing);
        println!("DETECT[{src}]: error={:?}", t.error);
        return;
    }

    // Diagnostic mode: run the full multi-method probe, write it to the log dir
    // (and best-effort Desktop), and print it. NOTE: under the app's own identity
    // this may trigger a Music/Spotify Automation prompt (Method 3). Prefer
    // --check-djay for a non-blocking djay confirmation.
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--debug-now-playing") {
        let report = debug_now_playing();
        print!("{report}");
        return;
    }

    // Focused djay check: Accessibility trust + djay AX read only. No blocking
    // prompts, writes to the log dir (readable without Desktop TCC access).
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--check-djay") {
        let report = check_djay_report();
        let path = write_diag("decks-bridge-djay-check.txt", &report);
        print!("{report}");
        println!("(written to {})", path.display());
        return;
    }

    // Serato diagnostic. --check-serato and --check-serato-pro run the same
    // multi-method check (MediaRemote → Accessibility → SQLite history file).
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--check-serato" || a == "--check-serato-pro") {
        let result = run_serato_check();
        let path = write_diag("decks-bridge-serato-check.txt", &result.report);
        print!("{}", result.report);
        println!("(written to {})", path.display());
        return;
    }

    // rekordbox diagnostic (diagnostic-only; rekordbox is NOT a supported source).
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--check-rekordbox") {
        let result = run_rekordbox_check();
        let path = write_diag("decks-bridge-rekordbox-check.txt", &result.report);
        print!("{}", result.report);
        println!("(written to {})", path.display());
        return;
    }

    tauri::Builder::default()
        .manage(PendingUpdate(Mutex::new(None)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            #[cfg(not(target_os = "windows"))]
            let _ = app;
            if let Err(e) = logging::init() {
                eprintln!("[logging] init failed: {e}");
            }
            sentry::init_if_configured();

            #[cfg(target_os = "windows")]
            setup_tray(app)?;

            logging::write_line("startup", "Decks Bridge ready");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // ONLY the main window is hidden instead of destroyed.
                //
                // Viewer windows must really close: windows.rs/windows.ts closes
                // one and waits for it to disappear before creating its
                // replacement, so intercepting their close would leave the
                // window alive-but-hidden, hang that wait for its full timeout,
                // and abort the switch. Scoping to "main" keeps the viewer
                // lifecycle intact on every platform.
                if window.label() != "main" {
                    return;
                }

                // Closing the main window must never kill the DJ's set. Bridge
                // is a background sync tool: hide the window and keep detecting.
                // Windows users get it back from the tray; macOS users from the
                // Dock icon (RunEvent::Reopen below). Cmd+Q / Quit still exits.
                let _ = window.hide();
                api.prevent_close();
                logging::write_line("window", "main window hidden — sync continues");
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_now_playing,
            get_now_playing_source,
            debug_now_playing,
            check_djay,
            check_serato,
            check_rekordbox,
            check_for_update,
            install_update,
            log_diagnostic,
            get_log_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Decks Bridge")
        .run(|_app, _event| {
            // macOS: the window is hidden rather than destroyed on close (see
            // on_window_event), so clicking the Dock icon must bring it back —
            // otherwise a DJ who closed the window has a running, unreachable
            // app and no tray to recover from.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = _event {
                // Only restore main when nothing is on screen. If a mini/pill
                // viewer is up, that IS the DJ's chosen surface and main is
                // hidden deliberately — don't fight their layout.
                if !has_visible_windows {
                    show_main_window(_app);
                }
            }
        });
}
