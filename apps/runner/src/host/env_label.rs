//! Environment labels: the DNS label that is one environment's identity
//! (ROADMAP, Preview environments).
//!
//! The host is `<label>.<slug>.<base>` and the bucket prefix is
//! `envs/<slug>/<label>`, so a label is a DNS label: lowercase letters,
//! digits and single `-` separators, at most 40 characters, never leading or
//! trailing `-`.

/// Longest label, in bytes: a DNS label is 63, but 40 leaves room for the
/// collision suffix and reads better in a hostname.
pub const MAX_LABEL: usize = 40;

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

fn free(label: &str, taken: &[String]) -> bool {
    !taken.iter().any(|t| t == label)
}

/// The first free label at or after `candidate`: the candidate itself, else
/// `candidate-2`, `candidate-3`, … (the candidate is trimmed to make room for
/// the suffix, so the result is always ≤ [`MAX_LABEL`]).
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
    fn any_free_platform_adjacent_label_is_handed_out() {
        // The pod and preview hosts are gone, so their old labels are ordinary
        // branch labels now: only a real collision gets a suffix.
        assert_eq!(unique_label("preview", &[]), "preview");
        assert_eq!(unique_label("app-0", &[]), "app-0");
        assert_eq!(unique_label("pod-abc", &[]), "pod-abc");
        assert_eq!(unique_label("preview", &taken(&["preview"])), "preview-2");
    }
}
