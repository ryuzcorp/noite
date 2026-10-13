//! Server-made commit identity: the account a commit is attributed to when
//! the runner writes it (browser commits, template imports, merges).
//!
//! Noite never asks a user for a git identity. Every server-made commit is
//! authored and committed as `<account name> <userId>@users.noreply.<domain>`,
//! which is stable, reveals no address, and keeps the repository's history
//! attributable to a real account.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::Config;

/// Git author/committer pair for a server-made commit.
pub struct Identity {
    pub name: String,
    pub email: String,
}

/// The `actor` every commit-making RPC takes (camelCase JSON): the session
/// user the commit is attributed to. The UI fills it from `sessionUser()`;
/// creation stores it on the app row, so it serializes too.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Actor {
    pub user_id: String,
    pub name: String,
}

/// `<user_id>@users.noreply.<cfg.base_domain>`; the name is stripped of
/// `<>`, `\n` and `\r`, trimmed to 100 chars, and "Noite user" when empty.
pub fn noreply(cfg: &Config, user_id: &str, display_name: &str) -> Identity {
    Identity {
        name: sanitize_name(display_name),
        email: format!("{}@users.noreply.{}", user_id.trim(), cfg.base_domain),
    }
}

/// The display name as git may store it: without the characters that break
/// the `Name <email>` header, and never empty.
fn sanitize_name(display_name: &str) -> String {
    let cleaned: String = display_name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '\n' | '\r'))
        .collect();
    let name: String = cleaned.trim().chars().take(100).collect();
    let name = name.trim_end().to_string();
    if name.is_empty() {
        "Noite user".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        let mut cfg = crate::config::config_for_tests();
        cfg.base_domain = "noite.now".to_string();
        cfg
    }

    #[test]
    fn email_is_the_noreply_address() {
        let id = noreply(&cfg(), "user_123", "Ada");
        assert_eq!(id.email, "user_123@users.noreply.noite.now");
        assert_eq!(id.name, "Ada");
    }

    #[test]
    fn name_is_stripped_and_bounded() {
        let id = noreply(&cfg(), "u", "  Ada <ada@example.com>\n");
        assert_eq!(id.name, "Ada ada@example.com");
        let long = noreply(&cfg(), "u", &"x".repeat(300));
        assert_eq!(long.name.chars().count(), 100);
        let blank = noreply(&cfg(), "u", "  \n ");
        assert_eq!(blank.name, "Noite user");
        let punctuation = noreply(&cfg(), "u", "<>");
        assert_eq!(punctuation.name, "Noite user");
    }
}
