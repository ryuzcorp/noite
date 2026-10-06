//! `noite-runner telemetry reingest [--since <RFC3339|duration>] [--slug <slug>]`:
//! replay a window of fleet telemetry into `metrics.sqlite`.
//!
//! The ingest REPLACES a window's aggregates instead of adding to them, so a
//! replay is exact — it recovers rows a failed pass (or the pre-alpha.2 ingest
//! bug) skipped, wherever the bucket still holds them. Data older than
//! `RUNNER_TELEMETRY_RETENTION_DAYS` has been pruned by celld and cannot be
//! recovered.
//!
//! This command does not read Parquet itself: it writes one request row and
//! the running runner's metrics tick consumes it, rewinding the target fleets'
//! watermarks and clearing the row once every fleet has caught up. Nothing is
//! read or written in the bucket.
//!
//! ```text
//! docker exec noite noite-runner telemetry reingest --since 7d
//! ```

use std::time::Duration;

use anyhow::{bail, Context};

use crate::config::Config;
use crate::db;
use crate::host::metrics::now_us;

const USAGE: &str = "usage: noite-runner telemetry reingest [--since <RFC3339|duration>] [--slug <slug>] [--no-wait] [--timeout <seconds>]

Replays fleet telemetry into metrics.sqlite so rows a failed ingest pass (or the
pre-alpha.2 ingest bug) skipped are recovered. The replay is exact: the ingest
replaces a window's aggregates, it never adds to them twice.

  --since <when>   RFC3339 timestamp, or a duration back from now (24h, 7d, 30m).
                   Default: the whole retention window (RUNNER_TELEMETRY_RETENTION_DAYS).
  --slug <slug>    Replay one fleet. Default: every fleet.
  --no-wait        Return as soon as the request is queued.
  --timeout <s>    With the wait (default), give up after this many seconds (default 1800).

Data older than the retention window has been pruned from the bucket and is
gone; the replay is clamped to what is still there.";

const DEFAULT_WAIT_S: u64 = 1800;
const POLL: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub since: Option<String>,
    pub slug: Option<String>,
    pub wait: bool,
    pub timeout_s: u64,
}

/// Parse what follows the `telemetry` word.
pub fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut out = Args {
        since: None,
        slug: None,
        wait: true,
        timeout_s: DEFAULT_WAIT_S,
    };
    let mut rest = args.iter();
    match rest.next().map(String::as_str) {
        Some("reingest") => {}
        Some("--help" | "-h") | None => bail!("{USAGE}"),
        Some(other) => bail!("unknown telemetry command `{other}`\n\n{USAGE}"),
    }
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--since" | "-s" => {
                let v = rest.next().context("--since needs a value")?;
                if v.trim().is_empty() {
                    bail!("--since needs a value");
                }
                out.since = Some(v.trim().to_string());
            }
            "--slug" => {
                let v = rest.next().context("--slug needs a slug")?;
                if v.trim().is_empty() {
                    bail!("--slug needs a slug");
                }
                out.slug = Some(v.trim().to_string());
            }
            "--no-wait" => out.wait = false,
            "--timeout" => {
                let v = rest.next().context("--timeout needs seconds")?;
                out.timeout_s = v
                    .trim()
                    .parse()
                    .context("--timeout must be a number of seconds")?;
            }
            "--help" | "-h" => bail!("{USAGE}"),
            other => bail!("unexpected argument `{other}`\n\n{USAGE}"),
        }
    }
    Ok(out)
}

/// Resolve `--since` to an absolute unix-microsecond floor. A bare duration is
/// measured back from `now_us`; anything date-shaped goes through RFC3339.
pub fn parse_since(since: &str, now_us: i64) -> anyhow::Result<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(since) {
        return Ok(dt.timestamp_micros());
    }
    let Some((num, unit)) = since.split_at_checked(since.len().saturating_sub(1)) else {
        bail!("--since must be RFC3339 or a duration like 24h, 7d, 30m");
    };
    if num.is_empty() {
        bail!("--since must be RFC3339 or a duration like 24h, 7d, 30m");
    }
    let n: i64 = num
        .parse()
        .with_context(|| format!("--since `{since}` is not a duration like 24h, 7d, 30m"))?;
    let secs = match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3_600,
        "d" => n * 86_400,
        "w" => n * 604_800,
        _ => bail!("--since unit must be s, m, h, d or w (got `{since}`)"),
    };
    if secs < 0 {
        bail!("--since cannot be in the future");
    }
    Ok(now_us - secs * 1_000_000)
}

fn iso(us: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| us.to_string())
}

pub async fn run(cfg: &Config, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let now = now_us();
    let retention_floor = now - cfg.telemetry_retention_days * 86_400_000_000;
    let requested = match &args.since {
        Some(s) => parse_since(s, now)?,
        // 0 asks the runner for the retention floor.
        None => retention_floor,
    };
    let floor = requested.max(retention_floor);
    if floor > requested {
        println!(
            "Note: --since {} is older than the {}-day retention, so it is clamped to {}; \
             older telemetry has been pruned and cannot be recovered.",
            iso(requested),
            cfg.telemetry_retention_days,
            iso(floor),
        );
    }
    let scope = args.slug.as_deref().unwrap_or("every fleet");

    let pool = db::connect(&cfg.database_url).await?;
    db::set_telemetry_replay(&pool, floor, args.slug.as_deref())
        .await
        .context("queue telemetry replay")?;
    println!(
        "Telemetry replay queued for {scope}, since {}. The runner rewinds its watermarks and \
         re-reads the window in hour chunks; replace semantics make it exact.",
        iso(floor),
    );
    if !args.wait {
        println!("Not waiting (--no-wait). It runs within a flush interval.");
        return Ok(());
    }
    println!(
        "Waiting up to {}s for the runner to catch up…",
        args.timeout_s
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(args.timeout_s);
    loop {
        if db::get_telemetry_replay(&pool)
            .await
            .context("read replay request")?
            .is_none()
        {
            println!("Telemetry replay complete for {scope}.");
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            println!(
                "Still replaying after {}s; it continues in the background. Watch the runner log \
                 for \"telemetry replay complete\".",
                args.timeout_s,
            );
            return Ok(());
        }
        tokio::time::sleep(POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_to_the_whole_retention_window_and_waits() {
        let parsed = parse_args(&args(&["reingest"])).unwrap();
        assert_eq!(parsed.since, None);
        assert_eq!(parsed.slug, None);
        assert!(parsed.wait);
        assert_eq!(parsed.timeout_s, 1800);
    }

    #[test]
    fn flags_are_read_in_any_order() {
        let parsed = parse_args(&args(&[
            "reingest",
            "--slug",
            "blog",
            "--since",
            "7d",
            "--no-wait",
            "--timeout",
            "60",
        ]))
        .unwrap();
        assert_eq!(parsed.since.as_deref(), Some("7d"));
        assert_eq!(parsed.slug.as_deref(), Some("blog"));
        assert!(!parsed.wait);
        assert_eq!(parsed.timeout_s, 60);
    }

    #[test]
    fn bad_arguments_are_refused_with_usage() {
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["replay"])).is_err());
        assert!(parse_args(&args(&["reingest", "--since"])).is_err());
        assert!(parse_args(&args(&["reingest", "--slug", "  "])).is_err());
        assert!(parse_args(&args(&["reingest", "--timeout", "soon"])).is_err());
        let err = parse_args(&args(&["reingest", "--nope"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("usage: noite-runner telemetry"), "{err}");
    }

    #[test]
    fn since_parses_durations_and_rfc3339() {
        let now = 10_000_000_000_000_i64; // some unix micros
        assert_eq!(parse_since("24h", now).unwrap(), now - 86_400 * 1_000_000);
        assert_eq!(parse_since("30m", now).unwrap(), now - 1_800 * 1_000_000);
        assert_eq!(
            parse_since("2d", now).unwrap(),
            now - 2 * 86_400 * 1_000_000
        );
        assert_eq!(parse_since("1970-01-01T00:00:01Z", now).unwrap(), 1_000_000);
        assert!(parse_since("tomorrow", now).is_err());
        assert!(parse_since("12q", now).is_err());
        assert!(parse_since("-1h", now).is_err());
    }
}
