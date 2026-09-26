//! In-app updates: check the published release manifest, then download, verify
//! and install the update the DJ accepted.
//!
//! Signature verification is done by tauri-plugin-updater inside
//! `Update::download`: the downloaded bytes are checked against
//! `plugins.updater.pubkey` (tauri.conf.json) before `install` ever sees them.
//! Nothing in this module can skip or weaken that check.
//!
//! Only stable releases are offered. A version with a pre-release tag
//! (`1.3.0-beta.1`) never replaces an installed build, even if a manifest
//! advertises one.

use std::cmp::Ordering;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, Updater, UpdaterExt};

use crate::logging;

/// Whole-request timeout for the manifest check (a small JSON file).
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Connection and stall timeouts for both the check and the download. The
/// download deliberately has no whole-request timeout: a slow venue connection
/// may need minutes, but a connection that stops delivering bytes must fail
/// instead of leaving "Downloading…" on screen forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Emit a progress event at most once per this many downloaded bytes.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

pub const PROGRESS_EVENT: &str = "update://progress";
pub const INSTALLING_EVENT: &str = "update://installing";

/// The update found by the last successful check, so `install_update` installs
/// exactly what the DJ was shown without fetching the manifest again.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

impl PendingUpdate {
    // A poisoned lock only means another thread panicked while holding it; an
    // Option<Update> has no invariant a panic could break, so recover the value
    // instead of turning an unrelated panic into a crash mid-set.
    fn set(&self, update: Option<Update>) {
        match self.0.lock() {
            Ok(mut guard) => *guard = update,
            Err(poisoned) => *poisoned.into_inner() = update,
        }
    }

    fn take(&self) -> Option<Update> {
        match self.0.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }
}

/// What the frontend shows for an available update.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes from the manifest, shown as plain text.
    pub body: Option<String>,
}

/// Why a check or install failed. `kind` picks the DJ-facing wording in the
/// frontend; `message` is the raw detail for logs and diagnostics.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateError {
    pub kind: UpdateErrorKind,
    pub message: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateErrorKind {
    /// The release server could not be reached, or the download stalled.
    Network,
    /// The endpoint answered without a usable manifest (404/5xx), e.g. no
    /// release has been published yet.
    NoRelease,
    /// The manifest is malformed or has no entry for this platform.
    InvalidRelease,
    /// The download did not match the release signing key. It was not installed.
    Signature,
    /// macOS refused to replace the app (admin prompt cancelled, no rights).
    Permission,
    /// Another install is already running.
    Busy,
    /// Anything else (disk full, corrupt archive, nothing left to install…).
    Failed,
}

impl UpdateError {
    fn new(kind: UpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<&UpdaterError> for UpdateError {
    fn from(err: &UpdaterError) -> Self {
        Self::new(classify(err), err.to_string())
    }
}

/// Maps a plugin error to the kind of failure the DJ should be told about.
/// Matches on variants, never on message text, which the plugin may reword.
fn classify(err: &UpdaterError) -> UpdateErrorKind {
    match err {
        // A body that is not JSON (e.g. an HTML error page) is a bad manifest,
        // not a connectivity problem.
        UpdaterError::Reqwest(e) if e.is_decode() => UpdateErrorKind::InvalidRelease,
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => UpdateErrorKind::Network,
        UpdaterError::ReleaseNotFound => UpdateErrorKind::NoRelease,
        UpdaterError::Serialization(_)
        | UpdaterError::Semver(_)
        | UpdaterError::UrlParse(_)
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_) => UpdateErrorKind::InvalidRelease,
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            UpdateErrorKind::Signature
        }
        UpdaterError::AuthenticationFailed => UpdateErrorKind::Permission,
        UpdaterError::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            UpdateErrorKind::Permission
        }
        _ => UpdateErrorKind::Failed,
    }
}

/// True when `candidate` should replace `current`: it must be a stable release
/// (no pre-release tag) with higher SemVer precedence. Build metadata is
/// ignored, as SemVer requires.
pub fn is_newer_stable(current: &Version, candidate: &Version) -> bool {
    candidate.pre.is_empty() && candidate.cmp_precedence(current) == Ordering::Greater
}

fn build_updater(app: &AppHandle) -> Result<Updater, UpdaterError> {
    app.updater_builder()
        .version_comparator(|current, release| is_newer_stable(&current, &release.version))
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
}

/// Checks the release manifest. `Ok(None)` means this build is up to date.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let current = app.package_info().version.to_string();
    let result = match build_updater(&app) {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };

    match result {
        Ok(Some(update)) => {
            logging::write_line(
                "update",
                &format!(
                    "update available: {current} -> {} ({})",
                    update.version, update.download_url
                ),
            );
            let info = UpdateInfo {
                version: update.version.clone(),
                current_version: current,
                body: update.body.clone(),
            };
            pending.set(Some(update));
            Ok(Some(info))
        }
        Ok(None) => {
            logging::write_line("update", &format!("up to date ({current})"));
            pending.set(None);
            Ok(None)
        }
        Err(err) => {
            // Keep any previously found update: a failed re-check (offline at
            // the venue) does not make an already-found update invalid.
            let err = UpdateError::from(&err);
            logging::write_line(
                "update",
                &format!("check failed [{:?}]: {}", err.kind, err.message),
            );
            Err(err)
        }
    }
}

/// Downloads, verifies and installs the update found by the last check.
///
/// Emits `update://progress` (`{ downloaded, total }`, cumulative bytes) while
/// downloading and `update://installing` once the signature has been verified.
/// On macOS it returns after the new app bundle is in place and the frontend
/// restarts the app. On Windows the plugin launches the NSIS installer and
/// exits this process, so it never returns on success.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), UpdateError> {
    let Some(_guard) = InstallGuard::acquire() else {
        return Err(UpdateError::new(
            UpdateErrorKind::Busy,
            "An update is already being installed.",
        ));
    };

    let update = match pending.take() {
        Some(update) => update,
        // Nothing cached (e.g. the webview reloaded, or a previous attempt
        // failed): check again under the same stable-only policy rather than
        // installing whatever the caller asks for.
        None => build_updater(&app)
            .map_err(|err| UpdateError::from(&err))?
            .check()
            .await
            .map_err(|err| UpdateError::from(&err))?
            .ok_or_else(|| {
                UpdateError::new(
                    UpdateErrorKind::Failed,
                    "No update is available to install.",
                )
            })?,
    };

    logging::write_line(
        "update",
        &format!(
            "downloading {} from {}",
            update.version, update.download_url
        ),
    );

    let progress_app = app.clone();
    let mut progress = DownloadProgress::default();
    let downloaded = update
        .download(
            move |chunk_len, total| {
                if let Some(payload) = progress.record(chunk_len, total) {
                    let _ = progress_app.emit(PROGRESS_EVENT, payload);
                }
            },
            || {},
        )
        .await;

    // `download` has already verified the signature when it returns Ok.
    let bytes = downloaded.map_err(|err| install_failed(&update, &err))?;
    logging::write_line(
        "update",
        &format!(
            "{} downloaded ({} bytes), signature verified; installing",
            update.version,
            bytes.len()
        ),
    );
    let _ = app.emit(INSTALLING_EVENT, ());

    update
        .install(bytes)
        .map_err(|err| install_failed(&update, &err))?;

    logging::write_line(
        "update",
        &format!("{} installed; restart required", update.version),
    );
    Ok(())
}

fn install_failed(update: &Update, err: &UpdaterError) -> UpdateError {
    let err = UpdateError::from(err);
    logging::write_line(
        "update",
        &format!(
            "install of {} failed [{:?}]: {}",
            update.version, err.kind, err.message
        ),
    );
    err
}

/// Allows one install at a time, released when the command finishes.
struct InstallGuard;

static INSTALLING: AtomicBool = AtomicBool::new(false);

impl InstallGuard {
    fn acquire() -> Option<Self> {
        INSTALLING
            .compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
            .ok()
            .map(|_| InstallGuard)
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, AtomicOrdering::SeqCst);
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgressPayload {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Turns the plugin's per-chunk callbacks into cumulative, throttled progress.
#[derive(Default)]
struct DownloadProgress {
    downloaded: u64,
    last_emitted: Option<u64>,
}

impl DownloadProgress {
    /// Records a chunk and returns the progress to emit, if one is due.
    fn record(&mut self, chunk_len: usize, total: Option<u64>) -> Option<ProgressPayload> {
        self.downloaded += chunk_len as u64;
        let finished = total.is_some_and(|total| self.downloaded >= total);
        let due = match self.last_emitted {
            None => true,
            Some(last) => self.downloaded - last >= PROGRESS_STEP_BYTES,
        };
        if !(finished || due) {
            return None;
        }
        self.last_emitted = Some(self.downloaded);
        Some(ProgressPayload {
            downloaded: self.downloaded,
            total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn offers_only_newer_versions() {
        assert!(is_newer_stable(&v("0.1.0"), &v("0.2.0")));
        assert!(is_newer_stable(&v("0.1.0"), &v("0.1.1")));
        assert!(is_newer_stable(&v("1.9.0"), &v("1.10.0")));
        assert!(!is_newer_stable(&v("0.2.0"), &v("0.2.0")));
        assert!(!is_newer_stable(&v("0.2.0"), &v("0.1.9")));
    }

    #[test]
    fn never_offers_prereleases() {
        assert!(!is_newer_stable(&v("0.1.0"), &v("0.2.0-beta.1")));
        assert!(!is_newer_stable(&v("0.1.0"), &v("1.0.0-rc.1")));
    }

    #[test]
    fn prerelease_installs_move_to_the_matching_stable_release() {
        assert!(is_newer_stable(&v("0.2.0-beta.1"), &v("0.2.0")));
        assert!(!is_newer_stable(&v("0.2.0-beta.1"), &v("0.1.9")));
    }

    #[test]
    fn build_metadata_does_not_make_a_version_newer() {
        assert!(!is_newer_stable(&v("0.2.0"), &v("0.2.0+build.7")));
    }

    #[test]
    fn classifies_errors_by_variant() {
        assert_eq!(
            classify(&UpdaterError::ReleaseNotFound),
            UpdateErrorKind::NoRelease
        );
        assert_eq!(
            classify(&UpdaterError::Network(
                "Download request failed with status: 404".into()
            )),
            UpdateErrorKind::Network
        );
        assert_eq!(
            classify(&UpdaterError::TargetsNotFound(
                vec!["darwin-aarch64".into()]
            )),
            UpdateErrorKind::InvalidRelease
        );
        let bad_json = serde_json::from_str::<serde_json::Value>("<html>").unwrap_err();
        assert_eq!(
            classify(&UpdaterError::Serialization(bad_json)),
            UpdateErrorKind::InvalidRelease
        );
        assert_eq!(
            classify(&UpdaterError::SignatureUtf8("not base64".into())),
            UpdateErrorKind::Signature
        );
        assert_eq!(
            classify(&UpdaterError::AuthenticationFailed),
            UpdateErrorKind::Permission
        );
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(
            classify(&UpdaterError::Io(denied)),
            UpdateErrorKind::Permission
        );
        let disk_full = std::io::Error::other("disk full");
        assert_eq!(
            classify(&UpdaterError::Io(disk_full)),
            UpdateErrorKind::Failed
        );
        assert_eq!(
            classify(&UpdaterError::EmptyEndpoints),
            UpdateErrorKind::Failed
        );
    }

    #[test]
    fn serializes_errors_for_the_frontend() {
        let err = UpdateError::from(&UpdaterError::ReleaseNotFound);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "no-release");
        assert!(!json["message"].as_str().unwrap().is_empty());
        let json =
            serde_json::to_value(UpdateError::new(UpdateErrorKind::InvalidRelease, "x")).unwrap();
        assert_eq!(json["kind"], "invalid-release");
    }

    #[test]
    fn progress_is_cumulative_and_throttled() {
        let total = Some(3 * PROGRESS_STEP_BYTES);
        let chunk = 16 * 1024;
        let mut progress = DownloadProgress::default();

        let first = progress.record(chunk, total).unwrap();
        assert_eq!(first.downloaded, chunk as u64);

        let mut emitted = vec![first];
        let mut received = chunk as u64;
        while received < 3 * PROGRESS_STEP_BYTES {
            received += chunk as u64;
            if let Some(payload) = progress.record(chunk, total) {
                emitted.push(payload);
            }
        }

        // One event per step plus the first and the final one, not one per chunk.
        assert!(emitted.len() <= 5, "too many events: {}", emitted.len());
        assert!(emitted
            .windows(2)
            .all(|w| w[0].downloaded < w[1].downloaded));
        assert_eq!(emitted.last().unwrap().downloaded, 3 * PROGRESS_STEP_BYTES);
        assert_eq!(emitted.last().unwrap().total, total);
    }

    #[test]
    fn progress_without_content_length_still_reports() {
        let mut progress = DownloadProgress::default();
        assert!(progress.record(10, None).is_some());
        assert!(progress.record(10, None).is_none());
        let payload = progress.record(PROGRESS_STEP_BYTES as usize, None).unwrap();
        assert_eq!(payload.downloaded, 20 + PROGRESS_STEP_BYTES);
        assert_eq!(payload.total, None);
    }

    #[test]
    fn only_one_install_at_a_time() {
        let first = InstallGuard::acquire().expect("first install starts");
        assert!(InstallGuard::acquire().is_none());
        drop(first);
        assert!(InstallGuard::acquire().is_some());
    }
}
