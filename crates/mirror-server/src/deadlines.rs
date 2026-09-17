//! Request deadlines, cancellation, and turn timeout tracking.
//! Port of `apps/server/src/deadlines.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// Parses a deadline duration in milliseconds, bounded between 1ms and 3,600,000ms (1 hour).
pub fn deadline_ms(value: Option<&str>, fallback: u64) -> u64 {
    let Some(v) = value else {
        return fallback;
    };
    match v.trim().parse::<u64>() {
        Ok(parsed) if parsed > 0 && parsed <= 3_600_000 => parsed,
        _ => fallback,
    }
}

/// Tracks turn timeouts: both total wall-clock deadline and inactivity (idle) timeout.
pub struct TurnDeadline {
    touch_notify: Arc<Notify>,
    closed: Arc<AtomicBool>,
}

impl TurnDeadline {
    /// Spawns a cooperative deadline watcher. If either the total timeout or idle timeout
    /// expires before `close()` is called, the provided callback is invoked.
    pub fn new<F>(on_timeout: F) -> Self
    where
        F: FnOnce() + Send + 'static,
    {
        let total_ms = deadline_ms(std::env::var("MIRROR_TURN_TIMEOUT_MS").ok().as_deref(), 900_000);
        let idle_ms = deadline_ms(std::env::var("MIRROR_IDLE_TIMEOUT_MS").ok().as_deref(), 120_000);

        let touch_notify = Arc::new(Notify::new());
        let closed = Arc::new(AtomicBool::new(false));

        let touch_clone = touch_notify.clone();
        let closed_clone = closed.clone();

        tokio::spawn(async move {
            let total_sleep = tokio::time::sleep(Duration::from_millis(total_ms));
            tokio::pin!(total_sleep);

            let mut callback = Some(on_timeout);

            loop {
                let idle_sleep = tokio::time::sleep(Duration::from_millis(idle_ms));
                tokio::pin!(idle_sleep);

                tokio::select! {
                    _ = &mut total_sleep => {
                        if !closed_clone.load(Ordering::SeqCst) {
                            if let Some(cb) = callback.take() {
                                cb();
                            }
                        }
                        break;
                    }
                    _ = &mut idle_sleep => {
                        if !closed_clone.load(Ordering::SeqCst) {
                            if let Some(cb) = callback.take() {
                                cb();
                            }
                        }
                        break;
                    }
                    _ = touch_clone.notified() => {
                        if closed_clone.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                }
            }
        });

        Self {
            touch_notify,
            closed,
        }
    }

    /// Resets the idle timeout clock upon receiving streaming chunks from upstream.
    pub fn touch(&self) {
        self.touch_notify.notify_one();
    }

    /// Shuts down the deadline watcher cleanly.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.touch_notify.notify_one();
    }
}

impl Drop for TurnDeadline {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_ms_parses_valid_numbers() {
        assert_eq!(deadline_ms(Some("5000"), 1000), 5000);
        assert_eq!(deadline_ms(Some("3600000"), 1000), 3_600_000);
    }

    #[test]
    fn deadline_ms_rejects_out_of_bounds_or_malformed() {
        assert_eq!(deadline_ms(Some("0"), 1000), 1000);
        assert_eq!(deadline_ms(Some("-50"), 1000), 1000);
        assert_eq!(deadline_ms(Some("3600001"), 1000), 1000);
        assert_eq!(deadline_ms(Some("abc"), 1000), 1000);
        assert_eq!(deadline_ms(None, 1000), 1000);
    }

    #[tokio::test]
    async fn turn_deadline_touch_and_close() {
        let called = Arc::new(AtomicBool::new(false));
        let called_clone = called.clone();
        let deadline = TurnDeadline::new(move || {
            called_clone.store(true, Ordering::SeqCst);
        });
        deadline.touch();
        deadline.close();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!called.load(Ordering::SeqCst));
    }
}
