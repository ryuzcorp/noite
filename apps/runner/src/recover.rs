//! `noite-runner recover [--email <address>]`: the operator's way back in.
//!
//! A lost passkey is normally recovered with an emailed code, which needs
//! `NOITE_EMAIL_WEBHOOK_URL`. An operator without one (or whose webhook is
//! down) runs this inside the container instead:
//!
//! ```text
//! docker exec noite noite-runner recover
//! ```
//!
//! It asks the control worker on loopback, with the runner token the process
//! already holds, for a one-time sign-in code and prints it. The code goes
//! through the same "Lost passkey?" screen as an emailed one: it expires, has
//! a few attempts, and ends on the account page where a new passkey is
//! enrolled. Nothing here reads or writes a database.

use std::time::Duration;

use anyhow::{bail, Context};
use serde::Deserialize;

use crate::config::{Config, CONTROL_UPSTREAM_URL};

const USAGE: &str = "usage: noite-runner recover [--email <address>]

Mints a one-time sign-in code for the control UI's \"Lost passkey?\" screen.
Without --email it is minted for the instance owner (the oldest admin).";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct Minted {
    code: String,
    email: String,
    #[serde(rename = "expiresInSeconds")]
    expires_in_seconds: u64,
}

#[derive(Deserialize)]
struct Refusal {
    error: Option<String>,
}

/// Parse what follows the `recover` word.
pub fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut email = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--email" | "-e" => {
                let value = rest.next().context("--email needs an address")?;
                email = Some(value.trim().to_string());
            }
            "--help" | "-h" => bail!("{USAGE}"),
            other => bail!("unexpected argument `{other}`\n\n{USAGE}"),
        }
    }
    if email.as_deref() == Some("") {
        bail!("--email needs an address");
    }
    Ok(Args { email })
}

/// Where the operator signs in: the configured public URL, else the control host.
fn sign_in_hint(cfg: &Config) -> String {
    if !cfg.better_auth_url.is_empty() {
        return cfg.better_auth_url.clone();
    }
    let host = cfg.control_hosts().into_iter().next().unwrap_or_default();
    let scheme = if cfg.base_domain == "localhost" { "http" } else { "https" };
    format!("{scheme}://{host}")
}

pub async fn run(cfg: &Config, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("build http client")?;
    let response = client
        .post(format!("{CONTROL_UPSTREAM_URL}/internal/recovery"))
        .bearer_auth(&cfg.runner_token)
        .json(&serde_json::json!({ "email": args.email }))
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
        bail!("{reason}");
    }
    let minted: Minted = response.json().await.context("read the control UI's answer")?;
    println!(
        "Recovery code for {email}: {code}\n\n\
         1. Open {url}\n\
         2. Choose \"Lost passkey?\", enter {email} and the code.\n\
         3. On the account page, add a new passkey.\n\n\
         The code works once and expires in {minutes} minutes. Anyone holding it can sign in as {email}.",
        email = minted.email,
        code = minted.code,
        url = sign_in_hint(cfg),
        minutes = minted.expires_in_seconds / 60,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_means_the_instance_owner() {
        assert_eq!(parse_args(&args(&[])).unwrap(), Args { email: None });
    }

    #[test]
    fn email_is_taken_from_the_flag() {
        let parsed = parse_args(&args(&["--email", " me@example.com "])).unwrap();
        assert_eq!(parsed.email.as_deref(), Some("me@example.com"));
    }

    #[test]
    fn bad_arguments_are_refused_with_usage() {
        assert!(parse_args(&args(&["--email"])).is_err());
        assert!(parse_args(&args(&["--email", "  "])).is_err());
        let err = parse_args(&args(&["--nope"])).unwrap_err().to_string();
        assert!(err.contains("usage: noite-runner recover"), "{err}");
    }
}
