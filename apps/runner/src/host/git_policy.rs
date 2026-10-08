//! Push-request parsing + per-role push policy (walgit-inspired).
//!
//! The runner shells out to `git receive-pack` for the actual pack work, but
//! it parses the request head itself first so policy can reject a push before
//! git mutates anything:
//! - `admin` may do anything (force-push, delete, move tags).
//! - `push` may create refs and fast-forward-update them; deletes and
//!   non-fast-forward updates are denied with the naming rule.
//!   Anything else is denied. A body we cannot parse fails open (warn + let git
//!   decide) — git itself re-validates old OIDs, so parsing is policy-only.

/// All-zero OID: ref deletion (`new`) or ref creation (`old`).
pub fn is_zero_oid(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b == b'0')
}

/// One `<old> <new> <ref>` command from a receive-pack request.
pub struct PushCommand {
    pub old: String,
    pub new: String,
    pub refname: String,
}

/// Parse receive-pack command pkt-lines from a stateless-rpc body.
///
/// Reads `<old> <new> <ref>[\0caps]` lines until the flush packet; the pack
/// bytes that follow are left untouched. Errors on malformed input — callers
/// fail open (git is the final validator).
pub fn parse_receive_commands(body: &[u8]) -> anyhow::Result<Vec<PushCommand>> {
    let mut cmds = Vec::new();
    let mut i = 0;
    while i + 4 <= body.len() {
        let len_hex = std::str::from_utf8(&body[i..i + 4])
            .map_err(|_| anyhow::anyhow!("receive-pack: pkt length not utf8"))?;
        let len = usize::from_str_radix(len_hex.trim(), 16)
            .map_err(|_| anyhow::anyhow!("receive-pack: bad pkt length {len_hex:?}"))?;
        if len == 0 {
            break; // flush: commands done, pack bytes follow
        }
        if len < 4 || i + len > body.len() {
            anyhow::bail!("receive-pack: pkt length {len} out of bounds");
        }
        let payload = &body[i + 4..i + len];
        i += len;
        let line = payload.strip_suffix(b"\n").unwrap_or(payload);
        let cmd_part = match line.iter().position(|&c| c == 0) {
            Some(nul) => &line[..nul], // first line carries NUL + caps
            None => line,
        };
        let text = std::str::from_utf8(cmd_part)
            .map_err(|_| anyhow::anyhow!("receive-pack: command not utf8"))?;
        let mut parts = text.splitn(3, ' ');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(old), Some(new), Some(name)) if !name.is_empty() => {
                cmds.push(PushCommand {
                    old: old.to_string(),
                    new: new.to_string(),
                    refname: name.to_string(),
                });
            }
            _ => anyhow::bail!("receive-pack: malformed command line"),
        }
    }
    Ok(cmds)
}

pub enum PolicyDecision {
    Allow,
    Deny(String),
}

/// Structural policy: deletes need `admin`; anything below `push` is denied.
/// Fast-forward checks need the repo and run separately via [`updates_needing_ff`].
pub fn check_push_policy(role: &str, cmds: &[PushCommand]) -> PolicyDecision {
    if role == "admin" {
        return PolicyDecision::Allow;
    }
    if role != "push" {
        return PolicyDecision::Deny(format!(
            "rule push-policy: role {role:?} may not push (need push or admin)"
        ));
    }
    for cmd in cmds {
        if is_zero_oid(&cmd.new) {
            return PolicyDecision::Deny(format!(
                "rule push-policy: 'push' may not delete {} (admin only)",
                cmd.refname
            ));
        }
    }
    PolicyDecision::Allow
}

/// Non-create, non-delete updates: (refname, old, new). Callers verify `old`
/// is an ancestor of `new` for non-admin roles before running git.
pub fn updates_needing_ff(cmds: &[PushCommand]) -> Vec<(&str, &str, &str)> {
    cmds.iter()
        .filter(|c| !is_zero_oid(&c.old) && !is_zero_oid(&c.new))
        .map(|c| (c.refname.as_str(), c.old.as_str(), c.new.as_str()))
        .collect()
}

/// Branch protection (`app_branch_rule.require_pr`): with the rule on, only
/// `admin` may move `refs/heads/main`; a `push` caller must open a pull request
/// instead. Off by default, and admins always bypass.
pub fn check_branch_protection(
    role: &str,
    cmds: &[PushCommand],
    require_pr: bool,
) -> PolicyDecision {
    if !require_pr || role == "admin" {
        return PolicyDecision::Allow;
    }
    for cmd in cmds {
        if cmd.refname == "refs/heads/main" {
            return PolicyDecision::Deny(
                "rule branch-protection: refs/heads/main is protected; \
                 open a pull request instead of pushing directly"
                    .to_string(),
            );
        }
    }
    PolicyDecision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(payload: &[u8]) -> Vec<u8> {
        let total = payload.len() + 4;
        let mut out = format!("{total:04x}").into_bytes();
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn parses_commands_with_caps_and_flush() {
        let old = "a".repeat(40);
        let new = "b".repeat(40);
        let mut body =
            pkt(format!("{old} {new} refs/heads/main\0report-status side-band-64k\n").as_bytes());
        body.extend_from_slice(&pkt(format!(
            "{} {} refs/heads/other\n",
            "c".repeat(40),
            "d".repeat(40)
        )
        .as_bytes()));
        body.extend_from_slice(b"0000");
        body.extend_from_slice(b"PACKExtraBytesIgnored");
        let Ok(cmds) = parse_receive_commands(&body) else {
            panic!("test body must parse");
        };
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].refname, "refs/heads/main");
        assert_eq!(cmds[0].old, old);
        assert_eq!(cmds[1].refname, "refs/heads/other");
    }

    #[test]
    fn rejects_malformed_command() {
        let body = pkt(b"not-a-command\n");
        assert!(parse_receive_commands(&body).is_err());
    }

    #[test]
    fn policy_allows_push_ff_and_creates() {
        let cmds = vec![
            PushCommand {
                old: "a".repeat(40),
                new: "b".repeat(40),
                refname: "refs/heads/main".into(),
            },
            PushCommand {
                old: "0".repeat(40),
                new: "b".repeat(40),
                refname: "refs/heads/feat".into(),
            },
        ];
        assert!(matches!(
            check_push_policy("push", &cmds),
            PolicyDecision::Allow
        ));
        assert!(matches!(
            check_push_policy("admin", &cmds),
            PolicyDecision::Allow
        ));
    }

    #[test]
    fn policy_denies_deletes_for_push() {
        let cmds = vec![PushCommand {
            old: "a".repeat(40),
            new: "0".repeat(40),
            refname: "refs/heads/main".into(),
        }];
        match check_push_policy("push", &cmds) {
            PolicyDecision::Deny(msg) => assert!(msg.contains("may not delete")),
            PolicyDecision::Allow => panic!("delete allowed for push"),
        }
        assert!(matches!(
            check_push_policy("admin", &cmds),
            PolicyDecision::Allow
        ));
    }

    #[test]
    fn policy_denies_non_push_roles() {
        let cmds = vec![];
        assert!(matches!(
            check_push_policy("view", &cmds),
            PolicyDecision::Deny(_)
        ));
    }

    #[test]
    fn ff_filter_skips_creates_and_deletes() {
        let cmds = vec![
            PushCommand {
                old: "0".repeat(40),
                new: "b".repeat(40),
                refname: "refs/heads/new".into(),
            },
            PushCommand {
                old: "a".repeat(40),
                new: "b".repeat(40),
                refname: "refs/heads/main".into(),
            },
            PushCommand {
                old: "a".repeat(40),
                new: "0".repeat(40),
                refname: "refs/heads/gone".into(),
            },
        ];
        let ff = updates_needing_ff(&cmds);
        assert_eq!(ff.len(), 1);
        assert_eq!(ff[0].0, "refs/heads/main");
    }

    #[test]
    fn branch_protection_rejects_push_role_main_only() {
        let main = vec![PushCommand {
            old: "a".repeat(40),
            new: "b".repeat(40),
            refname: "refs/heads/main".into(),
        }];
        let feat = vec![PushCommand {
            old: "0".repeat(40),
            new: "b".repeat(40),
            refname: "refs/heads/feat".into(),
        }];
        // Rule off: everything is allowed.
        assert!(matches!(
            check_branch_protection("push", &main, false),
            PolicyDecision::Allow
        ));
        // Rule on: push may not touch main, but may push other branches.
        match check_branch_protection("push", &main, true) {
            PolicyDecision::Deny(msg) => assert!(msg.contains("protected")),
            PolicyDecision::Allow => panic!("main push allowed under require_pr"),
        }
        assert!(matches!(
            check_branch_protection("push", &feat, true),
            PolicyDecision::Allow
        ));
        // Admins bypass.
        assert!(matches!(
            check_branch_protection("admin", &main, true),
            PolicyDecision::Allow
        ));
    }
}
