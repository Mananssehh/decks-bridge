//! Optional Sentry crash reporting — disabled until SENTRY_DSN is configured.

pub fn init_if_configured() {
    match std::env::var("SENTRY_DSN") {
        Ok(dsn) if !dsn.is_empty() => {
            crate::logging::write_line(
                "sentry",
                "SENTRY_DSN is set but Sentry SDK is not bundled yet — enable in a future release",
            );
        }
        _ => {
            crate::logging::write_line("sentry", "disabled (set SENTRY_DSN to enable later)");
        }
    }
}
