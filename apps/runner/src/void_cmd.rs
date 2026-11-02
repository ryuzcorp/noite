//! `noite-runner void rotate-proxy-token --slug <slug> [--env <label>]`:
//! mint a fresh per-fleet `__VOID_PROXY_TOKEN`.
//!
//! The token authenticates a Void Worker's calls to its own fleet's proxy;
//! it is stored as a runner-provisioned setting and injected at deploy
//! time, so rotation takes effect on the fleet's next deploy (redeploy to
//! apply it — until then the old token keeps serving). The value is never
//! printed: nothing outside the fleet needs it.
//!
//! ```text
//! docker exec noite noite-runner void rotate-proxy-token --slug blog
//! docker exec noite noite-runner void rotate-proxy-token --slug blog --env staging
//! ```

use anyhow::{bail, Context};

use crate::config::Config;
use crate::db;
use crate::host::void_deploy;

const USAGE: &str = "usage: noite-runner void rotate-proxy-token --slug <slug> [--env <label>]

Mints a fresh __VOID_PROXY_TOKEN for one fleet: production, or the preview
named by --env. The next deploy of that fleet injects it (until then the
old token keeps serving), so redeploy to apply the rotation.

  --slug <slug>     The app whose fleet rotates.
  --env <label>     Rotate a preview fleet instead of production.";

#[derive(Debug, PartialEq, Eq)]
struct Args {
    slug: String,
    env: Option<String>,
}

/// Parse what follows the `void` word.
fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut rest = args.iter().map(String::as_str).peekable();
    if rest.next() != Some("rotate-proxy-token") {
        bail!("{USAGE}");
    }
    let mut slug = None;
    let mut env = None;
    while let Some(flag) = rest.next() {
        match flag {
            "--slug" => slug = Some(rest.next().context(USAGE)?.to_string()),
            "--env" => env = Some(rest.next().context(USAGE)?.to_string()),
            _ => bail!("{USAGE}"),
        }
    }
    let Some(slug) = slug else {
        bail!("{USAGE}");
    };
    Ok(Args { slug, env })
}

pub async fn run(cfg: &Config, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let pool = db::connect(&cfg.database_url).await?;
    let app = db::get_app_by_slug(&pool, &args.slug)
        .await?
        .with_context(|| format!("no app with slug {:?}", args.slug))?;
    let environment_id = match &args.env {
        None => None,
        Some(label) => {
            let env = db::get_environment_by_label(&pool, &app.id, label)
                .await?
                .with_context(|| format!("no environment {label:?} on {:?}", args.slug))?;
            Some(env.id)
        }
    };
    void_deploy::rotate_proxy_token(&pool, &app.id, environment_id.as_deref()).await?;
    match &args.env {
        None => println!(
            "Rotated __VOID_PROXY_TOKEN for {:?} (production). Redeploy to apply it.",
            args.slug
        ),
        Some(label) => println!(
            "Rotated __VOID_PROXY_TOKEN for {:?} environment {label:?}. Redeploy it to apply it.",
            args.slug
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_args;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parses_slug_and_optional_env() {
        assert_eq!(
            parse_args(&args(&["rotate-proxy-token", "--slug", "blog"])).unwrap(),
            super::Args {
                slug: "blog".to_string(),
                env: None,
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "rotate-proxy-token",
                "--slug",
                "blog",
                "--env",
                "staging"
            ]))
            .unwrap(),
            super::Args {
                slug: "blog".to_string(),
                env: Some("staging".to_string()),
            }
        );
    }

    #[test]
    fn rejects_a_missing_command_slug_or_flag() {
        for words in [
            vec![],
            vec!["rotate"],
            vec!["rotate-proxy-token"],
            vec!["rotate-proxy-token", "--slug"],
            vec!["rotate-proxy-token", "--slug", "blog", "--env"],
            vec!["rotate-proxy-token", "--slug", "blog", "--since", "7d"],
        ] {
            assert!(parse_args(&args(&words)).is_err(), "{words:?}");
        }
    }
}
