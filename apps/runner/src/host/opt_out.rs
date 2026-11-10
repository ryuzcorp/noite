//! The opt-out switch shared by the instance heartbeat (`telemetry_report`)
//! and the release check (`update_check`).
//!
//! Both machines have the same gating shape: a stored preference (absent =
//! on), an environment lock that beats everything, and a "last success"
//! timestamp that arms a daily cadence. Keeping one type means the two cannot
//! drift again (they had two copies of `due` and `parse_iso`).
//!
//! stateDiagram-v2
//!   [*] --> Enabled
//!   [*] --> Disabled: stored "0"
//!   [*] --> Locked: env lock
//!   Enabled --> Disabled: SetEnabled(false)
//!   Disabled --> Enabled: SetEnabled(true)
//!   Enabled --> Due: no success yet / a day elapsed
//!   Due --> Enabled: RecordedSuccess(now)

use chrono::{DateTime, Utc};

/// The effective gate: what the operator stored, and the reason the
/// environment forces it off (which wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptOutSwitch {
    setting: bool,
    lock: Option<String>,
}

impl OptOutSwitch {
    /// `stored` is the raw `instance_setting` value (absent or `"0"` off,
    /// anything else on); `lock` is the config's lock reason.
    pub fn from_setting(stored: Option<&str>, lock: Option<&str>) -> Self {
        Self {
            setting: stored != Some("0"),
            lock: lock.map(str::to_string),
        }
    }

    /// What the operator stored, ignoring the lock (the `setting` wire field).
    pub fn setting(&self) -> bool {
        self.setting
    }

    /// Effective state: stored preference AND not locked off. Drives `enabled`.
    pub fn enabled(&self) -> bool {
        self.setting && self.lock.is_none()
    }

    pub fn lock_reason(&self) -> Option<&str> {
        self.lock.as_deref()
    }

    /// Whether a tick at `now` runs: enabled, and the last success is absent
    /// or at least `every_hours` old.
    pub fn due(
        &self,
        last_success: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
        every_hours: i64,
    ) -> bool {
        if !self.enabled() {
            return false;
        }
        match last_success {
            None => true,
            Some(at) => now.signed_duration_since(at) >= chrono::Duration::hours(every_hours),
        }
    }
}

/// An RFC3339 stamp as UTC; an unparsable one (hand-edited row) reads as
/// never.
pub fn parse_iso(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("valid instant")
    }

    #[test]
    fn the_lock_beats_the_stored_preference() {
        let switch = OptOutSwitch::from_setting(None, Some("DO_NOT_TRACK"));
        assert!(switch.setting());
        assert!(!switch.enabled());
        assert_eq!(switch.lock_reason(), Some("DO_NOT_TRACK"));
        let switch = OptOutSwitch::from_setting(Some("0"), None);
        assert!(!switch.setting());
        assert!(!switch.enabled());
    }

    #[test]
    fn due_needs_enabled_and_a_stale_or_absent_success() {
        let switch = OptOutSwitch::from_setting(None, None);
        let now = at(100 * 86_400);
        assert!(switch.due(None, now, 24));
        assert!(!switch.due(Some(now - chrono::Duration::hours(23)), now, 24));
        assert!(switch.due(Some(now - chrono::Duration::hours(24)), now, 24));
        let off = OptOutSwitch::from_setting(Some("0"), None);
        assert!(!off.due(None, now, 24), "disabled never runs");
        let locked = OptOutSwitch::from_setting(None, Some("X"));
        assert!(!locked.due(None, now, 24), "locked never runs");
    }
}
