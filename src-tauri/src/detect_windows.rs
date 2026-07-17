//! Windows Now Playing via System Media Transport Controls (SMTC).
//! Reads metadata from Spotify, Rekordbox, djay, browsers, and other SMTC publishers.

use crate::logging;
use crate::NowPlayingTrack;

pub fn detect() -> NowPlayingTrack {
    let mut diag: Vec<String> = Vec::new();
    match read_smtc(&mut diag) {
        Ok(track) => track,
        Err(e) => {
            logging::write_line("detect", &format!("SMTC error: {e}"));
            NowPlayingTrack {
                error: Some(e),
                diagnostics: Some(diag.join(" | ")),
                source: Some("none".into()),
                ..Default::default()
            }
        }
    }
}

fn read_smtc(diag: &mut Vec<String>) -> Result<NowPlayingTrack, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e}"))?
        .get()
        .map_err(|e| format!("session manager unavailable: {e}"))?;

    let sessions = manager
        .GetSessions()
        .map_err(|e| format!("GetSessions failed: {e}"))?;

    let count = sessions.Size().unwrap_or(0);
    diag.push(format!("smtc_sessions={count}"));

    let mut best: Option<(NowPlayingTrack, u8)> = None;

    for i in 0..count {
        let session = match sessions.GetAt(i) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let playback = match session.GetPlaybackInfo() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let status = match playback.PlaybackStatus() {
            Ok(s) => s,
            Err(_) => continue,
        };

        let priority = playback_priority(status);
        if priority == 0 {
            continue;
        }

        let props = match session.TryGetMediaPropertiesAsync() {
            Ok(op) => match op.get() {
                Ok(p) => p,
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        let title = props
            .Title()
            .ok()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        let artist = props
            .Artist()
            .ok()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        let album = props
            .AlbumTitle()
            .ok()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let app_id = session
            .SourceAppUserModelId()
            .ok()
            .map(|s| s.to_string());

        let track = NowPlayingTrack {
            title: title.clone(),
            artist,
            album,
            is_playing: status
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
            source: Some("smtc".into()),
            playback_app: app_id.as_deref().map(friendly_app_name),
            diagnostics: Some(diag.join(" | ")),
            ..Default::default()
        };

        if title.is_some()
            && best
                .as_ref()
                .map(|(_, p)| priority > *p)
                .unwrap_or(true)
        {
            best = Some((track, priority));
        }
    }

    if let Some((track, _)) = best {
        logging::write_line(
            "detect",
            &format!(
                "SMTC ok title={:?} app={:?}",
                track.title, track.playback_app
            ),
        );
        return Ok(track);
    }

    diag.push("source=none".into());
    Ok(NowPlayingTrack {
        source: Some("none".into()),
        diagnostics: Some(diag.join(" | ")),
        ..Default::default()
    })
}

fn playback_priority(
    status: windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus,
) -> u8 {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus::*;
    match status {
        Playing => 3,
        Paused => 2,
        Opened => 1,
        _ => 0,
    }
}

fn friendly_app_name(app_id: &str) -> String {
    // Known app model IDs → friendly names.
    let lower = app_id.to_lowercase();
    if lower.contains("spotify") { return "Spotify".into(); }
    if lower.contains("applemusic") || lower.contains("apple.music") { return "Apple Music".into(); }
    if lower.contains("serato") { return "Serato DJ Pro".into(); }
    if lower.contains("rekordbox") { return "Rekordbox".into(); }
    if lower.contains("virtualdj") || lower.contains("virtual.dj") { return "VirtualDJ".into(); }
    if lower.contains("djay") { return "djay Pro".into(); }
    if lower.contains("chrome") { return "Chrome".into(); }
    if lower.contains("firefox") { return "Firefox".into(); }
    if lower.contains("msedge") || lower.contains("edge") { return "Edge".into(); }
    if lower.contains("opera") { return "Opera".into(); }
    if lower.contains("brave") { return "Brave".into(); }

    // Strip trailing ".exe" (common for Win32 apps in SMTC).
    let trimmed = app_id.trim_end_matches(|c: char| c.is_ascii_alphanumeric() || c == '.');
    let name = if app_id.to_ascii_lowercase().ends_with(".exe") {
        &app_id[..app_id.len() - 4]
    } else {
        // Reverse-domain style: take last segment (e.g. "com.foo.Bar" → "Bar").
        app_id.rsplit('.').find(|s| !s.is_empty()).unwrap_or(app_id)
    };
    let _ = trimmed; // suppress warning
    name.to_string()
}
