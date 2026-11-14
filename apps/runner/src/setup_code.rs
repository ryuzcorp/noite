//! `noite-runner setup-code`: the first-admin setup code, on demand.
//!
//! On a public install without `NOITE_ADMIN_EMAIL`, the first registration
//! must present the one-time setup code (audit N-3). The control database
//! holds only its hash, so a lost code cannot be read back — this asks the
//! control worker on loopback, with the runner token the process already
//! holds, to rotate it and prints the fresh one:
//!
//! ```text
//! docker exec noite noite-runner setup-code
//! ```
//!
//! Rotation kills the previous code. Once an admin exists the control worker
//! refuses (`claimed`) and this says so instead of printing anything.
//! Nothing here reads or writes a database; the boot path (`ensure_at_boot`)
//! uses the same endpoint in `ensure` mode, which never rotates.

use std::time::Duration;

use anyhow::{bail, Context};
use serde::Deserialize;

use crate::config::{Config, CONTROL_UPSTREAM_URL};

const USAGE: &str = "usage: noite-runner setup-code

Prints a fresh one-time setup code for this install's first admin.
The previous code stops working. Refused once an admin exists.";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Parse what follows the `setup-code` word: no arguments.
pub fn parse_args(args: &[String]) -> anyhow::Result<()> {
    if let Some(other) = args.first() {
        if other == "--help" || other == "-h" {
            bail!("{USAGE}");
        }
        bail!("unexpected argument `{other}`\n\n{USAGE}");
    }
    Ok(())
}

#[derive(Deserialize)]
struct Issued {
    status: String,
    code: Option<String>,
}

#[derive(Deserialize)]
struct Refusal {
    error: Option<String>,
}

/// The control worker's answer, in one closed vocabulary.
#[derive(Debug, PartialEq, Eq)]
pub enum SetupStatus {
    /// No admin yet and no pending code: one was just minted.
    Generated(String),
    /// No admin yet and a code is already pending (not shown: only its hash
    /// is stored, so it cannot be read back — rotate for a fresh one).
    Pending,
    /// An admin exists: setup codes are meaningless.
    Claimed,
    /// The control worker did not answer.
    Unreachable(String),
}

/// Ask the control worker on loopback to rotate the setup code and print the
/// fresh one with the steps that redeem it.
pub async fn run(cfg: &Config, args: &[String]) -> anyhow::Result<()> {
    parse_args(args)?;
    let issued = post_setup_code(cfg, "rotate").await?;
    match issued {
        SetupStatus::Generated(code) => {
            println!(
                "Setup code for this install's first admin: {code}\n\n\
                 1. Open {url}\n\
                 2. Create the first account with the code above.\n\
                 3. Keep it private: anyone holding it owns the instance.\n\n\
                 The code works once. Lost it? Run this command again for a fresh one.",
                url = sign_in_hint(cfg),
            );
            Ok(())
        }
        SetupStatus::Pending => {
            // `rotate` never answers pending; a pending row here means the
            // worker is older than the rotate mode. Unreachable in practice,
            // answered rather than assumed.
            bail!("the control worker kept its pending code; upgrade the image")
        }
        SetupStatus::Claimed => {
            bail!("an admin already exists: no setup code is needed")
        }
        SetupStatus::Unreachable(reason) => bail!("{reason}"),
    }
}

/// Boot path: make sure a pending code exists while no admin does, and report
/// what the control worker says. Never rotates (a restart must not kill the
/// code the installer printed), never fails the boot — the lazy issue on the
/// signup-policy route covers an unreachable worker.
pub async fn ensure_at_boot(cfg: &Config) -> SetupStatus {
    post_setup_code(cfg, "ensure")
        .await
        .unwrap_or_else(|error| SetupStatus::Unreachable(format!("{error:#}")))
}

async fn post_setup_code(cfg: &Config, mode: &str) -> anyhow::Result<SetupStatus> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("build http client")?;
    let response = client
        .post(format!("{CONTROL_UPSTREAM_URL}/internal/setup-code"))
        .bearer_auth(&cfg.runner_token)
        .json(&serde_json::json!({ "mode": mode }))
        .send()
        .await
        .context(
            "could not reach the control UI on 127.0.0.1:8090 (is the noite container up and past boot?)",
        )?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let reason = serde_json::from_str::<Refusal>(&body)
            .ok()
            .and_then(|r| r.error)
            .unwrap_or_else(|| format!("control UI answered {status}"));
        anyhow::bail!("{reason}");
    }
    let issued: Issued = response
        .json()
        .await
        .context("read the control UI's answer")?;
    match issued.status.as_str() {
        "generated" => issued.code.map_or_else(
            || anyhow::bail!("the control UI answered generated without a code"),
            |code| Ok(SetupStatus::Generated(code)),
        ),
        "pending" => Ok(SetupStatus::Pending),
        "claimed" => Ok(SetupStatus::Claimed),
        other => anyhow::bail!("the control UI answered unknown status `{other}`"),
    }
}

/// Where the operator redeems the code: the configured public URL, else the
/// control host.
fn sign_in_hint(cfg: &Config) -> String {
    use crate::config::is_localhost_domain;
    if !cfg.better_auth_url.is_empty() {
        return cfg.better_auth_url.clone();
    }
    let host = cfg.control_hosts().into_iter().next().unwrap_or_default();
    let scheme = if is_localhost_domain(&cfg.base_domain) {
        "http"
    } else {
        "https"
    };
    format!("{scheme}://{host}")
}

/// The boot log line for a freshly minted code: loud, greppable, complete —
/// an operator with only `docker compose logs` gets everything here.
pub fn generated_banner(code: &str) -> String {
    format!(
        "FIRST ADMIN SETUP CODE: {code} — the first account must present it (one-time, keep it private)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_are_accepted() {
        assert!(parse_args(&args(&[])).is_ok());
    }

    #[test]
    fn help_prints_usage() {
        for flag in ["--help", "-h"] {
            let err = parse_args(&args(&[flag])).unwrap_err().to_string();
            assert!(err.contains("usage: noite-runner setup-code"), "{err}");
        }
    }

    #[test]
    fn extra_arguments_are_refused_with_usage() {
        let err = parse_args(&args(&["--rotate"])).unwrap_err().to_string();
        assert!(err.contains("usage: noite-runner setup-code"), "{err}");
    }

    #[test]
    fn the_boot_banner_names_the_code() {
        let banner = generated_banner("ABCD-EFGH");
        assert!(banner.contains("ABCD-EFGH"), "{banner}");
        assert!(banner.contains("FIRST ADMIN"), "{banner}");
    }
}
