//! Environment labels: the DNS label that is one environment's identity
//! (ROADMAP, Preview environments).
//!
//! The host is `<label>.<slug>.<base>` and the bucket prefix is
//! `envs/<slug>/<label>`, so a label is a DNS label: lowercase letters,
//! digits and single `-` separators, at most 40 characters, never leading or
//! trailing `-`, and never one of the platform's own labels (`preview`,
//! `app-0` — the pod host and the in-browser preview host).

/// Longest label, in bytes: a DNS label is 63, but 40 leaves room for the
/// collision suffix and reads better in a hostname.
pub const MAX_LABEL: usize = 40;

/// Labels the platform itself serves at `<slug>.<base>` scope-adjacent hosts
/// (`app-0.preview.<slug>.<base>` is the pod host). An environment may never
/// take one.
pub const RESERVED_LABELS: &[&str] = &["preview", "app-0"];

/// A branch name or arbitrary string as a DNS label: lowercased, every run of
/// anything else folded to one `-`, trimmed to [`MAX_LABEL`], no leading or
/// trailing `-`. Never empty (`env` is the floor).
pub fn sanitize_label(raw: &str) -> String {
    let mut out = String::new();
    let mut dash = true; // starts true so a leading separator is dropped
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    truncate(out)
}

fn truncate(mut out: String) -> String {
    // Every pushed character is ASCII (`to_ascii_lowercase` of an ASCII
    // alphanumeric, or `-`), so a byte cut is a char boundary.
    out.truncate(MAX_LABEL);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "env".to_string()
    } else {
        out
    }
}

fn reserved(label: &str) -> bool {
    RESERVED_LABELS.contains(&label)
}

fn free(label: &str, taken: &[String]) -> bool {
    !reserved(label) && !taken.iter().any(|t| t == label)
}

/// The first free label at or after `candidate`: the candidate itself, else
/// `candidate-2`, `candidate-3`, … (the candidate is trimmed to make room for
/// the suffix, so the result is always ≤ [`MAX_LABEL`]). Reserved labels count
/// as taken, so a branch literally named `preview` never takes the pod host.
pub fn unique_label(candidate: &str, taken: &[String]) -> String {
    if free(candidate, taken) {
        return candidate.to_string();
    }
    let mut n = 2u32;
    loop {
        let suffix = format!("-{n}");
        let head: String = candidate
            .chars()
            .take(MAX_LABEL.saturating_sub(suffix.len()))
            .collect();
        let head = head.trim_end_matches('-');
        let label = format!("{head}{suffix}");
        if free(&label, taken) {
            return label;
        }
        n += 1;
    }
}

/// Short, stable, human-readable stand-in for a user id: the first six
/// alphanumerics of it, lowercased (`anon` when there are none).
pub fn short_user(user_id: &str) -> String {
    let short: String = user_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(6)
        .collect::<String>()
        .to_ascii_lowercase();
    if short.is_empty() {
        "anon".to_string()
    } else {
        short
    }
}

/// A workspace preview's label: `<branch>-<user short id>`, so each (user,
/// branch) pair is one environment and the owner is visible in the host.
pub fn workspace_label(branch: &str, user_id: &str) -> String {
    let suffix = format!("-{}", short_user(user_id));
    let head: String = sanitize_label(branch)
        .chars()
        .take(MAX_LABEL.saturating_sub(suffix.len()))
        .collect();
    format!("{}{suffix}", head.trim_end_matches('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|l| (*l).to_string()).collect()
    }

    #[test]
    fn separators_fold_to_single_dashes() {
        assert_eq!(sanitize_label("Feature/New Thing"), "feature-new-thing");
        assert_eq!(sanitize_label("fix__a--b"), "fix-a-b");
        assert_eq!(sanitize_label("release/2026.10"), "release-2026-10");
        // Leading and trailing separators never survive.
        assert_eq!(sanitize_label("-nope-"), "nope");
        assert_eq!(sanitize_label("///"), "env");
        assert_eq!(sanitize_label(""), "env");
        // Non-ASCII is not a DNS label character; it folds like any separator.
        assert_eq!(sanitize_label("café/fix"), "caf-fix");
    }

    #[test]
    fn labels_are_capped_at_the_dns_length() {
        let long = "a".repeat(120);
        assert_eq!(sanitize_label(&long).len(), MAX_LABEL);
        // The truncation never leaves a trailing dash.
        let dashed = format!("{}{}", "a".repeat(39), "-tail");
        let label = sanitize_label(&dashed);
        assert_eq!(label.len(), 39);
        assert!(!label.ends_with('-'));
        assert_eq!(sanitize_label(&"b".repeat(40)).len(), 40);
    }

    #[test]
    fn collisions_get_a_numeric_suffix() {
        assert_eq!(unique_label("feature", &[]), "feature");
        assert_eq!(unique_label("feature", &taken(&["feature"])), "feature-2");
        assert_eq!(
            unique_label("feature", &taken(&["feature", "feature-2"])),
            "feature-3"
        );
        // The suffix never pushes the label past the cap.
        let long = "c".repeat(MAX_LABEL);
        let label = unique_label(&long, &taken(&[&long]));
        assert_eq!(label.len(), MAX_LABEL);
        assert!(label.ends_with("-2"));
    }

    #[test]
    fn reserved_labels_are_never_handed_out() {
        // The pod host (`app-0.preview.<slug>.<base>`) owns both names, with
        // nothing else taken.
        assert_eq!(unique_label("preview", &[]), "preview-2");
        assert_eq!(unique_label("app-0", &[]), "app-0-2");
        // A branch that sanitizes onto a reserved label gets the suffix too.
        assert_eq!(unique_label(&sanitize_label("APP-0"), &[]), "app-0-2");
        assert_eq!(sanitize_label("Preview"), "preview");
    }

    #[test]
    fn workspace_labels_carry_the_owner() {
        assert_eq!(
            workspace_label("feature/login", "3f1a9c22-0000-4000-8000-000000000001"),
            "feature-login-3f1a9c"
        );
        // A short or unusable id still yields a label.
        assert_eq!(workspace_label("main", "u1"), "main-u1");
        assert_eq!(workspace_label("main", "-"), "main-anon");
        // The cap holds with both halves at their worst.
        let label = workspace_label(&"x".repeat(80), &"y".repeat(40));
        assert!(label.len() <= MAX_LABEL, "{label}");
        assert!(!label.ends_with('-'));
    }
}
