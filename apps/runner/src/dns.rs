//! DNS TXT ownership proofs for custom domains (SPEC, Custom domains).
//!
//! A claim is proven by a TXT record at `_noite-challenge.<hostname>`
//! containing the claim's token — the same shape ACME's `dns-01` challenge
//! uses (`_acme-challenge`), under our own label so a Noite proof can never
//! be mistaken for (or satisfied by) a certificate-issuance record.
//!
//! The resolver is injectable: production resolves through the system
//! resolver (hickory), tests substitute [`FakeResolver`]. No polling loop:
//! the control UI's Verify button triggers one lookup per click, and the
//! failure reason names what was missing.

#[cfg(test)]
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

/// TXT owner label: the proof lives at `<CHALLENGE_LABEL>.<hostname>`.
pub const CHALLENGE_LABEL: &str = "_noite-challenge";

/// The TXT owner name a hostname's proof must appear at.
pub fn challenge_name(hostname: &str) -> String {
    format!("{CHALLENGE_LABEL}.{hostname}")
}

/// Random per-claim token (256 bits, URL-safe base64): the value the TXT
/// record must contain. Unpredictable, so only someone who controls the
/// hostname's DNS can publish it.
pub fn new_token() -> String {
    use base64::Engine as _;
    use rand::TryRng as _;
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Why a TXT lookup failed. `Unavailable` means this runner cannot resolve
/// at all (the system resolver failed to build at boot); `Lookup` is one
/// failed query. Both render as the readable reason the Verify button shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsError {
    Unavailable(String),
    Lookup(String),
}

impl std::fmt::Display for DnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DnsError::Unavailable(reason) => {
                write!(f, "DNS resolver unavailable: {reason}")
            }
            DnsError::Lookup(reason) => write!(f, "DNS lookup failed: {reason}"),
        }
    }
}

impl std::error::Error for DnsError {}

/// One TXT lookup: the record strings at `name`, or a [`DnsError`]. A boxed
/// future (not `async fn`: that is not object-safe, so
/// `Arc<dyn TxtResolver>` would not compile) so [`FakeResolver`] can stand
/// in for the network in tests, which must never dial DNS.
pub trait TxtResolver: Send + Sync {
    fn txt_records<'a>(
        &'a self,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, DnsError>> + Send + 'a>>;
}

/// Production resolver: the system resolver via hickory (Tokio).
pub struct SystemResolver {
    inner: hickory_resolver::TokioResolver,
}

impl SystemResolver {
    pub fn new() -> anyhow::Result<Self> {
        let inner = hickory_resolver::TokioResolver::builder_tokio()
            .and_then(|builder| builder.build())
            .map_err(|e| anyhow::anyhow!("dns resolver: {e}"))?;
        Ok(Self { inner })
    }
}

/// Upper bound on one Verify lookup, owned by this code: a wedged resolver
/// must not hold the HTTP handler past this, no matter hickory's own
/// retries. The timeout test advances past exactly this long.
pub(crate) const TXT_LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// One lookup under the Verify bound: elapsed time becomes a readable
/// `DnsError::Lookup("timed out")`, an inner failure keeps its own message.
/// Split out so tests can drive it with a future that never answers.
async fn with_lookup_timeout<F, T, E>(lookup: F) -> Result<T, DnsError>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    tokio::time::timeout(TXT_LOOKUP_TIMEOUT, lookup)
        .await
        .map_err(|_| DnsError::Lookup("timed out".to_owned()))?
        .map_err(|e| DnsError::Lookup(e.to_string()))
}

impl TxtResolver for SystemResolver {
    fn txt_records<'a>(
        &'a self,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, DnsError>> + Send + 'a>> {
        Box::pin(async move {
            let lookup = with_lookup_timeout(self.inner.txt_lookup(name)).await?;
            let mut out = Vec::new();
            for record in lookup.answers() {
                let hickory_resolver::proto::rr::RData::TXT(txt) = &record.data else {
                    continue;
                };
                let mut joined = Vec::new();
                for chunk in txt.txt_data.iter() {
                    joined.extend_from_slice(chunk);
                }
                if let Ok(text) = String::from_utf8(joined) {
                    out.push(text);
                }
            }
            Ok(out)
        })
    }
}

/// Test resolver: canned TXT answers per owner name, no network. Awaits
/// nothing and holds no clock, so tests stay deterministic. Test-only: the
/// production fallback for a missing system resolver is
/// [`UnavailableResolver`], never this.
#[derive(Debug, Default)]
#[cfg(test)]
pub struct FakeResolver {
    records: Mutex<HashMap<String, Vec<String>>>,
}

#[cfg(test)]
impl FakeResolver {
    pub fn with_record(name: &str, value: &str) -> Arc<Self> {
        let fake = Arc::new(Self::default());
        fake.set(name, vec![value.to_owned()]);
        fake
    }

    pub fn set(&self, name: &str, values: Vec<String>) {
        self.records
            .lock()
            .expect("fake dns lock")
            .insert(name.to_owned(), values);
    }
}

#[cfg(test)]
impl TxtResolver for FakeResolver {
    fn txt_records<'a>(
        &'a self,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, DnsError>> + Send + 'a>> {
        let records = self
            .records
            .lock()
            .expect("fake dns lock")
            .get(name)
            .cloned()
            .unwrap_or_default();
        Box::pin(async move { Ok(records) })
    }
}

/// The resolver [`system()`] falls back to when the system resolver cannot
/// be built: every lookup fails as [`DnsError::Unavailable`], so Verify
/// answers a readable "DNS resolver unavailable: …" instead of hanging or
/// silently failing. Boot logs a warning naming the cause.
#[derive(Debug)]
pub struct UnavailableResolver {
    reason: String,
}

impl UnavailableResolver {
    pub fn new(reason: String) -> Self {
        Self { reason }
    }
}

impl TxtResolver for UnavailableResolver {
    fn txt_records<'a>(
        &'a self,
        _name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, DnsError>> + Send + 'a>> {
        let reason = self.reason.clone();
        Box::pin(async move { Err(DnsError::Unavailable(reason)) })
    }
}

/// Shared handle carried on [`crate::AppState`].
pub fn system() -> Arc<dyn TxtResolver> {
    match SystemResolver::new() {
        Ok(resolver) => Arc::new(resolver),
        Err(e) => {
            tracing::warn!(error = %e, "system DNS resolver unavailable; TXT verification will fail");
            Arc::new(UnavailableResolver::new(e.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_name_prefixes_the_label() {
        assert_eq!(
            challenge_name("app.example.com"),
            "_noite-challenge.app.example.com"
        );
    }

    #[test]
    fn tokens_are_unique_and_textsafe() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert!(a.len() >= 43, "256 bits base64: {a}");
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "url-safe: {a}"
        );
    }

    #[tokio::test]
    async fn fake_resolver_answers_what_was_set() {
        let fake = FakeResolver::with_record("_noite-challenge.x.test", "tok");
        assert_eq!(
            fake.txt_records("_noite-challenge.x.test").await,
            Ok(vec!["tok".to_owned()])
        );
        assert_eq!(
            fake.txt_records("_noite-challenge.other.test").await,
            Ok(Vec::new())
        );
    }

    #[tokio::test]
    async fn unavailable_resolver_fails_readably() {
        let resolver = UnavailableResolver::new("no nameservers".to_owned());
        let err = resolver
            .txt_records("_noite-challenge.x.test")
            .await
            .expect_err("unavailable must fail");
        assert_eq!(err, DnsError::Unavailable("no nameservers".to_owned()));
        assert_eq!(err.to_string(), "DNS resolver unavailable: no nameservers");
    }

    #[tokio::test]
    async fn wedged_lookup_times_out_readably() {
        tokio::time::pause();
        // A lookup that never answers: the Verify bound, not the wall
        // clock, ends it — paused time advances deterministically.
        let wedged = with_lookup_timeout(std::future::pending::<Result<Vec<String>, DnsError>>());
        tokio::time::advance(TXT_LOOKUP_TIMEOUT + std::time::Duration::from_secs(1)).await;
        let err = wedged.await.expect_err("a wedged lookup must fail");
        assert_eq!(err, DnsError::Lookup("timed out".to_owned()));
    }
}
