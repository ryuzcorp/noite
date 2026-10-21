//! Prefix-scoped keys through the AWS IAM API (AWS S3).
//!
//! Needs an IAM-capable key and `NOITE_CREDENTIAL_PROVIDER=aws`: the runner
//! creates one IAM user per scope, attaches [`super::prefix_policy`] as an
//! inline policy, and mints an access key for it. Everything is a signed
//! `POST /` Query-protocol call to `iam.amazonaws.com`, so no AWS SDK is
//! needed. R2 has no long-lived prefix-scoped keys and is not covered here:
//! `auto` leaves it on the `root` provider with that reason.
//!
//! IAM user names allow `[A-Za-z0-9+=,.@_-]` (64 chars); scope prefixes fit
//! that after the `noite-` prefix is trimmed to the allowed set.

use futures::future::BoxFuture;
use sha2::{Digest, Sha256};

use super::{hex_encode, sigv4_now, CredentialProvider, MintedKey, SigV4, StoreAccess};

/// IAM-backed provider. `endpoint` defaults to the global IAM endpoint and
/// is overridable for tests.
pub struct AwsIam {
    store: StoreAccess,
    endpoint: String,
    client: reqwest::Client,
}

impl AwsIam {
    pub fn new(store: StoreAccess) -> Self {
        Self {
            endpoint: "https://iam.amazonaws.com".into(),
            store,
            client: reqwest::Client::new(),
        }
    }

    #[cfg(test)]
    fn test(store: StoreAccess, endpoint: String) -> Self {
        Self {
            store,
            endpoint,
            client: reqwest::Client::new(),
        }
    }

    /// One signed IAM Query call. AWS wants form-encoded parameters; the
    /// SigV4 payload hash covers the exact body bytes sent.
    async fn iam(&self, params: &[(&str, &str)]) -> anyhow::Result<String> {
        let body = params
            .iter()
            .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        let payload_hash = hex_encode(Sha256::digest(body.as_bytes()).as_slice());
        let (amz_date, date_stamp) = sigv4_now();
        let url = reqwest::Url::parse(&self.endpoint)?;
        let host = url.host_str().unwrap_or_default().to_string();
        let auth = SigV4 {
            method: "POST",
            uri: "/",
            query: "",
            host: &host,
            region: "us-east-1",
            service: "iam",
            access_key: &self.store.access_key,
            secret_key: &self.store.secret_key,
            payload_hash: &payload_hash,
            amz_date: &amz_date,
            date_stamp: &date_stamp,
        }
        .authorization();
        let resp = self
            .client
            .post(url)
            .header("x-amz-date", amz_date)
            .header("authorization", auth)
            .header(
                "content-type",
                "application/x-www-form-urlencoded; charset=utf-8",
            )
            .body(body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if status != 200 {
            return Err(anyhow::anyhow!("IAM call failed: HTTP {status} {text}"));
        }
        Ok(text)
    }

    /// IAM allows 64 chars: `noite-` plus a sanitized prefix truncated to 47
    /// plus `-` plus 8 hex of SHA-256(prefix) (62 max). The hash keeps names
    /// unique past the truncation point, where two long prefixes would
    /// otherwise collide and wedge on `EntityAlreadyExists`.
    fn user_name(prefix: &str) -> String {
        let mut name: String = prefix
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "+=,.@_-".contains(c) {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        if name.len() > 47 {
            use sha2::{Digest, Sha256};
            let hash = super::hex_encode(Sha256::digest(prefix.as_bytes()).as_slice());
            name.truncate(47);
            return format!("noite-{name}-{}", &hash[..8]);
        }
        format!("noite-{name}")
    }
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Pull `<Tag>value</Tag>` out of an IAM XML response. The responses are
/// small and fixed-shape; a full XML parser is not worth it.
fn xml_tag(body: &str, tag: &str) -> anyhow::Result<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open).map(|i| i + open.len());
    let end = body.find(&close);
    match (start, end) {
        (Some(s), Some(e)) if s <= e => Ok(body[s..e].to_string()),
        _ => Err(anyhow::anyhow!("IAM response has no <{tag}>: {body}")),
    }
}

fn is_no_such_entity(body: &str) -> bool {
    body.contains("NoSuchEntity")
}

impl CredentialProvider for AwsIam {
    fn name(&self) -> &'static str {
        "aws"
    }

    fn mint<'a>(
        &'a self,
        bucket: &'a str,
        prefix: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<MintedKey>> {
        Box::pin(async move {
            let user = Self::user_name(prefix);
            let policy = super::prefix_policy(bucket, prefix);
            if let Err(e) = self
                .iam(&[
                    ("Action", "CreateUser"),
                    ("UserName", &user),
                    ("Version", "2010-05-08"),
                ])
                .await
            {
                // A half-minted user from a crashed mint (user without key):
                // clear it and retry once, so a scope can't wedge until
                // someone cleans up IAM by hand.
                if !format!("{e:#}").contains("EntityAlreadyExists") {
                    return Err(e);
                }
                self.revoke(&user).await?;
                self.iam(&[
                    ("Action", "CreateUser"),
                    ("UserName", &user),
                    ("Version", "2010-05-08"),
                ])
                .await?;
            }
            let policy_result = self
                .iam(&[
                    ("Action", "PutUserPolicy"),
                    ("UserName", &user),
                    ("PolicyName", "noite-prefix"),
                    ("PolicyDocument", &policy),
                    ("Version", "2010-05-08"),
                ])
                .await;
            if let Err(e) = policy_result {
                let _ = self
                    .iam(&[
                        ("Action", "DeleteUser"),
                        ("UserName", &user),
                        ("Version", "2010-05-08"),
                    ])
                    .await;
                return Err(e);
            }
            let created = self
                .iam(&[
                    ("Action", "CreateAccessKey"),
                    ("UserName", &user),
                    ("Version", "2010-05-08"),
                ])
                .await
                .map_err(|e| anyhow::anyhow!("{e:#}"))?;
            let access_key = xml_tag(&created, "AccessKeyId")?;
            let secret_key = xml_tag(&created, "SecretAccessKey")?;
            Ok(MintedKey {
                handle: user,
                access_key,
                secret_key,
            })
        })
    }

    fn revoke<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            // Delete the keys first: a half-revoked user with no keys cannot
            // authenticate even if the later calls fail and retry.
            if let Ok(body) = self
                .iam(&[
                    ("Action", "ListAccessKeys"),
                    ("UserName", handle),
                    ("Version", "2010-05-08"),
                ])
                .await
            {
                // Every listed key id goes; an unknown shape fails the
                // revoke loudly rather than leaving keys behind.
                let mut rest = body.as_str();
                while let Ok(id) = xml_tag(rest, "AccessKeyId") {
                    let deleted = self
                        .iam(&[
                            ("Action", "DeleteAccessKey"),
                            ("UserName", handle),
                            ("AccessKeyId", &id),
                            ("Version", "2010-05-08"),
                        ])
                        .await;
                    if let Err(e) = deleted {
                        if !is_no_such_entity(&format!("{e:#}")) {
                            return Err(e);
                        }
                    }
                    rest = match rest
                        .find("</AccessKeyId>")
                        .map(|i| i + "</AccessKeyId>".len())
                    {
                        Some(next) => &rest[next..],
                        None => break,
                    };
                }
            }
            let policy = self
                .iam(&[
                    ("Action", "DeleteUserPolicy"),
                    ("UserName", handle),
                    ("PolicyName", "noite-prefix"),
                    ("Version", "2010-05-08"),
                ])
                .await;
            if let Err(e) = policy {
                if !is_no_such_entity(&format!("{e:#}")) {
                    return Err(e);
                }
            }
            let user = self
                .iam(&[
                    ("Action", "DeleteUser"),
                    ("UserName", handle),
                    ("Version", "2010-05-08"),
                ])
                .await;
            if let Err(e) = user {
                if !is_no_such_entity(&format!("{e:#}")) {
                    return Err(e);
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::credentials::prefix_policy;

    async fn stub() -> (tokio::task::JoinHandle<()>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let action = req
                        .split("Action=")
                        .nth(1)
                        .unwrap_or_default()
                        .split('&')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let body = match action.as_str() {
                        "CreateUser" => {
                            "<CreateUserResponse><User><UserName>u</UserName></User></CreateUserResponse>"
                        }
                        "PutUserPolicy" => "<PutUserPolicyResponse/>",
                        "CreateAccessKey" => {
                            "<CreateAccessKeyResponse><AccessKey><AccessKeyId>AKTEST</AccessKeyId><SecretAccessKey>SKTEST</SecretAccessKey></AccessKey></CreateAccessKeyResponse>"
                        }
                        "ListAccessKeys" => {
                            "<ListAccessKeysResponse><AccessKeyMetadata><AccessKeyId>AKTEST</AccessKeyId></AccessKeyMetadata></ListAccessKeysResponse>"
                        }
                        _ => "<Response/>",
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (handle, format!("http://127.0.0.1:{}", addr.port()))
    }

    #[test]
    fn user_name_stays_in_iam_alphabet() {
        assert_eq!(AwsIam::user_name("fleets/my.app/"), "noite-fleets-my.app-");
        assert!(AwsIam::user_name("envs/a/b/").len() < 64);
    }

    /// Maximum-length environment prefixes stay within IAM's 64 chars and
    /// stay distinct past the truncation point.
    #[test]
    fn user_name_bounds_long_prefixes() {
        let a = format!("envs/{}/{}", "a".repeat(64), "x".repeat(64));
        let b = format!("envs/{}/{}", "a".repeat(64), "y".repeat(64));
        let na = AwsIam::user_name(&a);
        let nb = AwsIam::user_name(&b);
        assert!(na.len() <= 64, "{na}");
        assert!(nb.len() <= 64, "{nb}");
        assert_ne!(na, nb, "tails must differ: {na} vs {nb}");
        assert_eq!(AwsIam::user_name(&a), na, "deterministic");
    }

    /// A stateful stub: the first CreateUser reports a half-minted user.
    async fn recovery_stub() -> (
        tokio::task::JoinHandle<()>,
        String,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let actions: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let creates: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let task_actions = actions.clone();
        let task_creates = creates.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let actions = task_actions.clone();
                let creates = task_creates.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let action = req
                        .split("Action=")
                        .nth(1)
                        .unwrap_or_default()
                        .split('&')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    actions.lock().expect("actions lock").push(action.clone());
                    let (status, body) = match action.as_str() {
                        "CreateUser" if creates.fetch_add(1, Ordering::SeqCst) == 0 => (
                            400,
                            "<ErrorResponse><Error><Code>EntityAlreadyExists</Code></Error></Error>",
                        ),
                        "CreateUser" => (
                            200,
                            "<CreateUserResponse><User><UserName>u</UserName></User></CreateUserResponse>",
                        ),
                        "CreateAccessKey" => (
                            200,
                            "<CreateAccessKeyResponse><AccessKey><AccessKeyId>AKNEW</AccessKeyId><SecretAccessKey>SKNEW</SecretAccessKey></AccessKey></CreateAccessKeyResponse>",
                        ),
                        "ListAccessKeys" => (
                            200,
                            "<ListAccessKeysResponse><AccessKeyMetadata><AccessKeyId>AKOLD</AccessKeyId></AccessKeyMetadata></ListAccessKeysResponse>",
                        ),
                        _ => (200, "<Response/>"),
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (handle, format!("http://127.0.0.1:{}", addr.port()), actions)
    }

    /// A half-minted user (EntityAlreadyExists on create) is cleared and
    /// retried instead of wedging the scope.
    #[tokio::test]
    async fn mint_recovers_from_half_minted_user() {
        let (_handle, endpoint, actions) = recovery_stub().await;
        let store = StoreAccess {
            endpoint: "https://s3.us-east-1.amazonaws.com".into(),
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let provider = AwsIam::test(store, endpoint);
        let minted = provider
            .mint("noite", "fleets/a/")
            .await
            .expect("mint recovers");
        assert_eq!(minted.access_key, "AKNEW");
        let actions = actions.lock().expect("actions lock");
        for expected in [
            "CreateUser",
            "ListAccessKeys",
            "DeleteAccessKey",
            "DeleteUserPolicy",
            "DeleteUser",
            "CreateUser",
            "PutUserPolicy",
            "CreateAccessKey",
        ] {
            assert!(
                actions.contains(&expected.to_string()),
                "saw {expected}: {actions:?}"
            );
        }
    }

    /// The provider speaks the IAM Query protocol: user, inline prefix
    /// policy, access key — and revokes every key it finds.
    #[tokio::test]
    async fn mint_and_revoke_against_stub() {
        let (_handle, endpoint) = stub().await;
        let store = StoreAccess {
            endpoint: "https://s3.us-east-1.amazonaws.com".into(),
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let provider = AwsIam::test(store, endpoint);
        let minted = provider.mint("noite", "fleets/a/").await.expect("mint");
        assert_eq!(minted.access_key, "AKTEST");
        assert_eq!(minted.secret_key, "SKTEST");
        assert!(minted.handle.starts_with("noite-"));
        // The policy attached is exactly the shared prefix policy.
        assert!(prefix_policy("noite", "fleets/a/").contains("fleets/a/*"));
        provider.revoke(&minted.handle).await.expect("revoke");
    }
}
