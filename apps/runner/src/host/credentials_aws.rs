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
    tag: String,
    endpoint: String,
    client: reqwest::Client,
}

impl AwsIam {
    /// `bucket` feeds the install tag (see [`super::install_tag`]): the tag
    /// must survive DB loss, so it derives from the configured store, never
    /// from a row.
    pub fn new(store: StoreAccess, bucket: &str) -> Self {
        Self {
            tag: super::install_tag(&store.endpoint, bucket, &store.region),
            endpoint: "https://iam.amazonaws.com".into(),
            store,
            client: reqwest::Client::new(),
        }
    }

    #[cfg(test)]
    fn test(store: StoreAccess, bucket: &str, endpoint: String) -> Self {
        Self {
            tag: super::install_tag(&store.endpoint, bucket, &store.region),
            endpoint,
            store,
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

    /// This install's users live under one IAM path. IAM user names are
    /// unique per account regardless of path, so the tag goes in the name
    /// too: two installs on one account mint different names.
    fn iam_path(&self) -> String {
        format!("/noite/{}/", self.tag)
    }

    /// IAM allows 64 chars: `noite-<tag>-` plus a sanitized prefix, truncated
    /// past 49 chars to 40 plus `-` plus 8 hex of SHA-256(prefix) (64 max).
    /// The hash keeps names unique past the truncation point, where two long
    /// prefixes would otherwise collide and wedge on `EntityAlreadyExists`;
    /// the tag keeps two installs (or buckets) on one account from minting
    /// the same name in the first place.
    fn user_name(&self, prefix: &str) -> String {
        let name: String = prefix
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "+=,.@_-".contains(c) {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        // Sanitized prefixes are ASCII (`/` becomes `-`), so byte slicing is
        // char-safe.
        if name.len() > 49 {
            use sha2::{Digest, Sha256};
            let hash = super::hex_encode(Sha256::digest(prefix.as_bytes()).as_slice());
            return format!("noite-{}-{}-{}", self.tag, &name[..40], &hash[..8]);
        }
        format!("noite-{}-{name}", self.tag)
    }

    /// The `<Path>` of the IAM user `user`, or an error when the user (or
    /// its path) cannot be read: callers must prove ownership before
    /// touching a colliding name.
    async fn user_path(&self, user: &str) -> anyhow::Result<String> {
        let body = self
            .iam(&[
                ("Action", "GetUser"),
                ("UserName", user),
                ("Version", "2010-05-08"),
            ])
            .await?;
        xml_tag(&body, "Path").map_err(|e| anyhow::anyhow!("{e:#}"))
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

/// The `<Users>…</Users>` block of a `ListUsers` response, if present.
fn users_block(body: &str) -> Option<&str> {
    let start = body.find("<Users>")? + "<Users>".len();
    let end = body[start..].find("</Users>").map(|i| start + i)?;
    Some(&body[start..end])
}

/// Whether this IAM user is one this install minted: the tagged `noite-`
/// name [`AwsIam::user_name`] produces, under exactly the install's path.
/// Anything else — the operator's own users, another install's users (same
/// account, different tag), keys minted before tags (path `/`) — is never
/// an orphan this sweep may revoke. `manages` applies the name half of this
/// check (the listing has no path); [`AwsIam::list_managed`] requires both
/// halves before returning a name. The configured access key is excluded
/// again in [`AwsIam::manages`], in case it ever matches the shape.
fn is_managed_user(name: &str, path: &str, tag: &str) -> bool {
    if path != format!("/noite/{tag}/") {
        return false;
    }
    managed_name(name, tag)
}

/// The name half of [`is_managed_user`]: the tagged mint shape without the
/// path, for callers (like `manages`) that only have the name.
fn managed_name(name: &str, tag: &str) -> bool {
    let prefix = format!("noite-{tag}-");
    if !name.starts_with(&prefix) || name.len() > 64 {
        return false;
    }
    let rest = &name[prefix.len()..];
    if rest.is_empty()
        || !rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+=,.@_-".contains(&b))
    {
        return false;
    }
    // Minted names are the tagged prefix plus the sanitized scope prefix
    // (which always ends in `/`, sanitized to `-`), or the truncated form:
    // 40 chars plus `-` plus 8 hex of the prefix hash.
    if rest.ends_with('-') {
        return true;
    }
    rest.len() == 49
        && rest.as_bytes()[40] == b'-'
        && rest[41..].bytes().all(|b| b.is_ascii_hexdigit())
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
            let user = self.user_name(prefix);
            let policy = super::prefix_policy(bucket, prefix);
            let path = self.iam_path();
            if let Err(e) = self
                .iam(&[
                    ("Action", "CreateUser"),
                    ("Path", &path),
                    ("UserName", &user),
                    ("Version", "2010-05-08"),
                ])
                .await
            {
                // A half-minted user from a crashed mint (user without key):
                // clear it and retry once, so a scope can't wedge until
                // someone cleans up IAM by hand — but only after proving
                // the colliding user is ours. A foreign user under this name
                // (another account's user, an operator-made user) must fail
                // the mint loudly instead of being deleted.
                if !format!("{e:#}").contains("EntityAlreadyExists") {
                    return Err(e);
                }
                match self.user_path(&user).await {
                    Ok(actual) if actual == path => {}
                    Ok(actual) => anyhow::bail!(
                        "IAM user {user} already exists under foreign path {actual}; refusing to clear it"
                    ),
                    Err(e) => {
                        return Err(anyhow::anyhow!(
                            "IAM user {user} already exists and its path could not be read: {e:#}"
                        ));
                    }
                }
                self.revoke(&user).await?;
                self.iam(&[
                    ("Action", "CreateUser"),
                    ("Path", &path),
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
    fn install_tag(&self) -> &str {
        &self.tag
    }

    fn manages(&self, handle: &str) -> bool {
        // Name shape only: the listing has the path, this does not. The
        // install binding is enforced where it is known — `list_managed`
        // requires the exact path, and the orphan sweep only revokes names
        // the listing returned.
        managed_name(handle, &self.tag) && handle != self.store.access_key
    }

    fn list_managed<'a>(&'a self) -> BoxFuture<'a, anyhow::Result<Vec<String>>> {
        Box::pin(async move {
            // `ListUsers` pages (`IsTruncated` + `Marker`): follow every
            // page, or orphans past the first page leak forever.
            let mut out = Vec::new();
            let mut marker: Option<String> = None;
            loop {
                let mut params = vec![("Action", "ListUsers"), ("Version", "2010-05-08")];
                if let Some(next) = marker.as_deref() {
                    params.push(("Marker", next));
                }
                let body = self.iam(&params).await?;
                let users = match users_block(&body) {
                    Some(block) => block,
                    None => break,
                };
                let mut rest = users;
                while let Some(start) = rest.find("<member>") {
                    rest = &rest[start + "<member>".len()..];
                    let Some(end) = rest.find("</member>") else {
                        break;
                    };
                    let member = &rest[..end];
                    rest = &rest[end + "</member>".len()..];
                    let Ok(name) = xml_tag(member, "UserName") else {
                        continue;
                    };
                    // A member without a parseable `Path` is skipped, never
                    // defaulted: defaulting to `/` would fail open toward
                    // revocation.
                    let Ok(path) = xml_tag(member, "Path") else {
                        continue;
                    };
                    if is_managed_user(&name, &path, &self.tag) && name != self.store.access_key {
                        out.push(name);
                    }
                }
                if !body.contains("<IsTruncated>true</IsTruncated>") {
                    break;
                }
                marker = Some(xml_tag(&body, "Marker")?);
            }
            Ok(out)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::credentials::prefix_policy;

    fn test_store() -> StoreAccess {
        StoreAccess {
            endpoint: "https://s3.us-east-1.amazonaws.com".into(),
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        }
    }

    fn test_provider(endpoint: String, bucket: &str) -> AwsIam {
        AwsIam::test(test_store(), bucket, endpoint)
    }

    /// Minted names carry the install tag and stay in the IAM alphabet
    /// within 64 chars: `noite-<tag>-<sanitized prefix>`.
    #[test]
    fn user_name_stays_in_iam_alphabet() {
        let provider = test_provider("http://127.0.0.1:1".into(), "noite");
        assert_eq!(
            provider.user_name("fleets/my.app/"),
            format!("noite-{}-fleets-my.app-", provider.install_tag())
        );
        assert!(provider.user_name("envs/a/b/").len() < 64);
        assert!(provider.user_name("fleets/my.app/").len() <= 64);
    }

    /// Maximum-length environment prefixes stay within IAM's 64 chars and
    /// stay distinct past the truncation point.
    #[test]
    fn user_name_bounds_long_prefixes() {
        let provider = test_provider("http://127.0.0.1:1".into(), "noite");
        let a = format!("envs/{}/{}", "a".repeat(64), "x".repeat(64));
        let b = format!("envs/{}/{}", "a".repeat(64), "y".repeat(64));
        let na = provider.user_name(&a);
        let nb = provider.user_name(&b);
        assert!(na.len() <= 64, "{na}");
        assert!(nb.len() <= 64, "{nb}");
        assert_ne!(na, nb, "tails must differ: {na} vs {nb}");
        assert_eq!(provider.user_name(&a), na, "deterministic");
    }

    /// Different buckets (hence different tags) on one account mint
    /// different names for the same prefix: no cross-install collision.
    #[test]
    fn user_names_differ_across_install_tags() {
        let a = test_provider("http://127.0.0.1:1".into(), "alpha");
        let b = test_provider("http://127.0.0.1:1".into(), "beta");
        assert_ne!(a.install_tag(), b.install_tag());
        assert_ne!(a.user_name("fleets/shop/"), b.user_name("fleets/shop/"));
        assert_ne!(a.iam_path(), b.iam_path());
    }

    /// A stateful stub: the first CreateUser reports a half-minted user,
    /// and GetUser reports the path this install owns.
    async fn recovery_stub(
        own_path: String,
    ) -> (
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
                let own_path = own_path.clone();
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
                    let (status, body): (u16, String) = match action.as_str() {
                        "CreateUser" if creates.fetch_add(1, Ordering::SeqCst) == 0 => (
                            400,
                            "<ErrorResponse><Error><Code>EntityAlreadyExists</Code></Error></Error>"
                                .into(),
                        ),
                        "CreateUser" => (
                            200,
                            "<CreateUserResponse><User><UserName>u</UserName></User></CreateUserResponse>"
                                .into(),
                        ),
                        "GetUser" => (
                            200,
                            format!(
                                "<GetUserResponse><GetUserResult><User><Path>{own_path}</Path></User></GetUserResult></GetUserResponse>"
                            ),
                        ),
                        "CreateAccessKey" => (
                            200,
                            "<CreateAccessKeyResponse><AccessKey><AccessKeyId>AKNEW</AccessKeyId><SecretAccessKey>SKNEW</SecretAccessKey></AccessKey></CreateAccessKeyResponse>"
                                .into(),
                        ),
                        "ListAccessKeys" => (
                            200,
                            "<ListAccessKeysResponse><AccessKeyMetadata><AccessKeyId>AKOLD</AccessKeyId></AccessKeyMetadata></ListAccessKeysResponse>"
                                .into(),
                        ),
                        _ => (200, "<Response/>".into()),
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

    /// A self-owned half-minted user (EntityAlreadyExists on create, GetUser
    /// proving our path) is cleared and retried instead of wedging the scope.
    #[tokio::test]
    async fn mint_recovers_from_half_minted_user() {
        let own_tag =
            super::super::install_tag("https://s3.us-east-1.amazonaws.com", "noite", "us-east-1");
        let (_handle, endpoint, actions) = recovery_stub(format!("/noite/{own_tag}/")).await;
        let provider = test_provider(endpoint, "noite");
        let minted = provider
            .mint("noite", "fleets/a/")
            .await
            .expect("mint recovers");
        assert_eq!(minted.access_key, "AKNEW");
        let actions = actions.lock().expect("actions lock");
        for expected in [
            "CreateUser",
            "GetUser",
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

    /// A colliding user the install cannot prove is its own is never
    /// cleared: the mint fails loudly and `revoke` is never called.
    #[tokio::test]
    async fn mint_refuses_to_clear_a_foreign_user() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let seen_task = seen.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let seen_task = seen_task.clone();
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
                    seen_task.lock().expect("seen lock").push(action.clone());
                    let (status, body) = match action.as_str() {
                        "CreateUser" => (
                            400,
                            "<ErrorResponse><Error><Code>EntityAlreadyExists</Code></Error></Error>",
                        ),
                        "GetUser" => (
                            200,
                            "<GetUserResponse><GetUserResult><User><Path>/admin/</Path></User></GetUserResult></GetUserResponse>",
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
        let provider = test_provider(format!("http://127.0.0.1:{}", addr.port()), "noite");
        let err = provider
            .mint("noite", "fleets/a/")
            .await
            .expect_err("a foreign colliding user must fail the mint");
        handle.abort();
        assert!(
            format!("{err:#}").contains("foreign path"),
            "names the foreign ownership: {err:#}"
        );
        let seen = seen.lock().expect("seen lock");
        assert!(
            seen.contains(&"GetUser".to_string()),
            "ownership was checked first: {seen:?}"
        );
        for destructive in ["DeleteUser", "DeleteAccessKey", "CreateAccessKey"] {
            assert!(
                !seen.contains(&destructive.to_string()),
                "revoke never ran ({destructive}): {seen:?}"
            );
        }
    }

    /// The provider speaks the IAM Query protocol: user under the install
    /// path, inline prefix policy, access key — and revokes every key it
    /// finds. The create carries the install path.
    #[tokio::test]
    async fn mint_and_revoke_against_stub() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let seen_task = seen.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let seen_task = seen_task.clone();
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
                    seen_task.lock().expect("seen lock").push(req.clone());
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
        let provider = test_provider(format!("http://127.0.0.1:{}", addr.port()), "noite");
        let minted = provider.mint("noite", "fleets/a/").await.expect("mint");
        assert_eq!(minted.access_key, "AKTEST");
        assert_eq!(minted.secret_key, "SKTEST");
        assert!(minted
            .handle
            .starts_with(&format!("noite-{}-", provider.install_tag())));
        // The policy attached is exactly the shared prefix policy.
        assert!(prefix_policy("noite", "fleets/a/").contains("fleets/a/*"));
        provider.revoke(&minted.handle).await.expect("revoke");
        handle.abort();
        let seen = seen.lock().expect("seen lock");
        assert!(
            seen.iter()
                .any(|r| r.contains("Action=CreateUser") && r.contains("Path=")),
            "the create carries the install path: {seen:?}"
        );
    }

    /// Only this install's tagged name under exactly its path counts as
    /// managed: another install's names (same account, different tag), the
    /// pre-tag path `/`, and hand-made names are never sweep candidates,
    /// while the real mint shape round-trips — short and truncated.
    #[test]
    fn managed_shape_excludes_foreign_users_and_paths() {
        let provider = test_provider("http://127.0.0.1:1".into(), "noite");
        let tag = provider.install_tag().to_string();
        let own_path = format!("/noite/{tag}/");
        let short = provider.user_name("fleets/shop/");
        let long = format!("envs/{}/{}/", "a".repeat(64), "b".repeat(64));
        let truncated = provider.user_name(&long);
        assert!(is_managed_user(&short, &own_path, &tag));
        assert!(is_managed_user(&truncated, &own_path, &tag));
        assert!(truncated.len() <= 64, "{truncated}");
        assert!(!is_managed_user("noite-backup", &own_path, &tag), "no tag");
        assert!(!is_managed_user(&short, "/admin/", &tag), "foreign path");
        assert!(
            !is_managed_user(&short, "/", &tag),
            "pre-tag path never matches"
        );
        // The pre-tag alpha.8 shape under the old default path: the new
        // sweep never revokes it (the safe direction).
        assert!(!is_managed_user("noite-fleets-shop-", "/", &tag));
        assert!(!is_managed_user("attacker", &own_path, &tag));
        assert!(
            !is_managed_user(&format!("noite-{tag}-"), &own_path, &tag),
            "bare prefix"
        );
        assert!(
            !is_managed_user(&format!("noite-{tag}-fleets-shop!"), &own_path, &tag),
            "bad charset"
        );
        assert!(
            !is_managed_user(&format!("noite-{tag}-{}", "x".repeat(59)), &own_path, &tag),
            "over IAM's 64 chars"
        );
        // Another install's user, even under its own path: the tag binds it
        // to the other install.
        let other = test_provider("http://127.0.0.1:1".into(), "other-bucket");
        let other_path = format!("/noite/{}/", other.install_tag());
        let other_user = other.user_name("fleets/shop/");
        assert!(is_managed_user(
            &other_user,
            &other_path,
            other.install_tag()
        ));
        assert!(!is_managed_user(&other_user, &other_path, &tag));
        // `manages` is the name half: without the path it still binds the
        // tag, and the listing (which has the path) enforces the rest.
        assert!(provider.manages(&short));
        assert!(!provider.manages(&other_user));
        assert!(!provider.manages("noite-fleets-shop-"));
    }

    /// `manages` excludes the configured access key even if it ever matched
    /// the naming shape.
    #[test]
    fn manages_excludes_the_configured_access_key() {
        let provider = test_provider("http://127.0.0.1:1".into(), "noite");
        let mut store = test_store();
        store.access_key = provider.user_name("fleets/shop/");
        assert!(!AwsIam::test(store, "noite", "http://127.0.0.1:1".into())
            .manages(&provider.user_name("fleets/shop/")));
    }

    /// `ListUsers` is followed across pages: the orphan on page two is
    /// listed (foreign users are not), and the second page is fetched with
    /// the first page's marker. Members bind this install's tagged name to
    /// exactly its path.
    #[tokio::test]
    async fn list_users_follows_pagination() {
        use std::sync::{Arc, Mutex};
        let markers: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let provider_probe = test_provider("http://127.0.0.1:1".into(), "noite");
        let tag = provider_probe.install_tag().to_string();
        let own_path = format!("/noite/{tag}/");
        let shop = format!("noite-{tag}-fleets-shop-");
        let env = format!("noite-{tag}-envs-shop-x-");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let markers_task = markers.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let markers_task = markers_task.clone();
                let (shop, env, own_path) = (shop.clone(), env.clone(), own_path.clone());
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let marker = req.split("Marker=").nth(1).and_then(|rest| {
                        rest.split(['&', ' ', '\r', '\n'])
                            .next()
                            .map(str::to_string)
                            .filter(|m| !m.is_empty())
                    });
                    // Percent-decoding is unnecessary: the stub's own marker
                    // is alphanumeric.
                    markers_task
                        .lock()
                        .expect("markers lock")
                        .push(marker.clone());
                    let body = match marker.as_deref() {
                        None => {
                            format!(
                                "<ListUsersResponse><ListUsersResult><Users>\
                            <member><Path>{own_path}</Path><UserName>{shop}</UserName></member>\
                            <member><Path>{own_path}</Path><UserName>attacker</UserName></member>\
                            </Users><IsTruncated>true</IsTruncated><Marker>page2</Marker>\
                            </ListUsersResult></ListUsersResponse>"
                            )
                        }
                        Some(_) => {
                            format!(
                                "<ListUsersResponse><ListUsersResult><Users>\
                            <member><Path>{own_path}</Path><UserName>{env}</UserName></member>\
                            <member><Path>/admin/</Path><UserName>noite-backup</UserName></member>\
                            <member><Path>/</Path><UserName>noite-fleets-shop-</UserName></member>\
                            </Users><IsTruncated>false</IsTruncated>\
                            </ListUsersResult></ListUsersResponse>"
                            )
                        }
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let provider = test_provider(format!("http://127.0.0.1:{}", addr.port()), "noite");
        let listed = provider.list_managed().await.expect("list");
        handle.abort();
        assert_eq!(
            listed,
            vec![format!("noite-{tag}-fleets-shop-"), format!("noite-{tag}-envs-shop-x-"),],
            "both pages' managed users: no foreign ones, no legacy path, no missing-path defaults: {listed:?}"
        );
        let markers = markers.lock().expect("markers lock");
        assert_eq!(
            markers.as_slice(),
            &[None, Some("page2".to_string())],
            "second page carries the first page's marker: {markers:?}"
        );
    }

    /// A member without a parseable `Path` is skipped, never defaulted: with
    /// a managed-shaped name it would otherwise fail open toward revocation.
    #[tokio::test]
    async fn list_users_skips_members_without_a_path() {
        let provider_probe = test_provider("http://127.0.0.1:1".into(), "noite");
        let tag = provider_probe.install_tag().to_string();
        let own_path = format!("/noite/{tag}/");
        let name = provider_probe.user_name("fleets/shop/");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let stub_name = name.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let (name, own_path) = (stub_name.clone(), own_path.clone());
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let _ = sock.read(&mut buf).await.unwrap_or(0);
                    let body = format!(
                        "<ListUsersResponse><ListUsersResult><Users>\
                        <member><Path>{own_path}</Path><UserName>{name}</UserName></member>\
                        <member><UserName>{name}</UserName></member>\
                        </Users><IsTruncated>false</IsTruncated>\
                        </ListUsersResult></ListUsersResponse>"
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let provider = test_provider(format!("http://127.0.0.1:{}", addr.port()), "noite");
        let listed = provider.list_managed().await.expect("list");
        handle.abort();
        assert_eq!(
            listed,
            vec![name],
            "only the pathed member lists: {listed:?}"
        );
    }

    /// Two installs sharing one stub store partition by path: each lists
    /// only its own tagged users, and the pre-tag alpha.8 user under `/` is
    /// never a candidate even with no row naming it.
    #[tokio::test]
    async fn list_users_partitions_two_installs_by_path() {
        let install_a = test_provider("http://127.0.0.1:1".into(), "bucket-a");
        let install_b = test_provider("http://127.0.0.1:1".into(), "bucket-b");
        let (tag_a, tag_b) = (
            install_a.install_tag().to_string(),
            install_b.install_tag().to_string(),
        );
        let (path_a, path_b) = (format!("/noite/{tag_a}/"), format!("/noite/{tag_b}/"));
        let (user_a, user_b) = (
            install_a.user_name("fleets/shop/"),
            install_b.user_name("fleets/shop/"),
        );
        assert_ne!(user_a, user_b, "names differ across installs");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let (user_a, user_b, path_a, path_b) = (
                    user_a.clone(),
                    user_b.clone(),
                    path_a.clone(),
                    path_b.clone(),
                );
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let _ = sock.read(&mut buf).await.unwrap_or(0);
                    let body = format!(
                        "<ListUsersResponse><ListUsersResult><Users>\
                        <member><Path>{path_a}</Path><UserName>{user_a}</UserName></member>\
                        <member><Path>{path_b}</Path><UserName>{user_b}</UserName></member>\
                        <member><Path>/</Path><UserName>noite-fleets-shop-</UserName></member>\
                        <member><Path>{path_a}</Path><UserName>attacker</UserName></member>\
                        </Users><IsTruncated>false</IsTruncated>\
                        </ListUsersResult></ListUsersResponse>"
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let endpoint = format!("http://127.0.0.1:{}", addr.port());
        let listed_a = test_provider(endpoint.clone(), "bucket-a")
            .list_managed()
            .await
            .expect("list A");
        let listed_b = test_provider(endpoint, "bucket-b")
            .list_managed()
            .await
            .expect("list B");
        handle.abort();
        assert_eq!(listed_a, vec![install_a.user_name("fleets/shop/")]);
        assert_eq!(listed_b, vec![install_b.user_name("fleets/shop/")]);
    }

    /// End to end at the sweep: a shared stub holds this install's live key
    /// (row present), this install's orphan (no row), another install's live
    /// key, and a pre-tag alpha.8 key. The sweep revokes exactly the orphan.
    #[tokio::test]
    async fn orphan_sweep_ignores_other_install_and_legacy_users() {
        use crate::config::config_for_tests;
        use crate::host::credentials::{orphan_sweep, Credentials};
        use std::sync::Arc;
        let install_a = test_provider("http://127.0.0.1:1".into(), "bucket-a");
        let install_b = test_provider("http://127.0.0.1:1".into(), "bucket-b");
        let (tag_a, tag_b) = (
            install_a.install_tag().to_string(),
            install_b.install_tag().to_string(),
        );
        let (path_a, path_b) = (format!("/noite/{tag_a}/"), format!("/noite/{tag_b}/"));
        let live_a = install_a.user_name("fleets/shop/");
        let orphan_a = install_a.user_name("fleets/orphan/");
        let live_b = install_b.user_name("fleets/shop/");
        let removed: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let removed_task = removed.clone();
        let (stub_live_a, stub_orphan_a, stub_live_b) =
            (live_a.clone(), orphan_a.clone(), live_b.clone());
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let (live_a, orphan_a, live_b, path_a, path_b) = (
                    stub_live_a.clone(),
                    stub_orphan_a.clone(),
                    stub_live_b.clone(),
                    path_a.clone(),
                    path_b.clone(),
                );
                let removed_task = removed_task.clone();
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
                    let user = req
                        .split("UserName=")
                        .nth(1)
                        .unwrap_or_default()
                        .split(['&', ' ', '\r', '\n'])
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    if action == "DeleteUser" {
                        removed_task.lock().expect("removed lock").push(user);
                    }
                    let body = match action.as_str() {
                        "ListUsers" => format!(
                            "<ListUsersResponse><ListUsersResult><Users>\
                            <member><Path>{path_a}</Path><UserName>{live_a}</UserName></member>\
                            <member><Path>{path_a}</Path><UserName>{orphan_a}</UserName></member>\
                            <member><Path>{path_b}</Path><UserName>{live_b}</UserName></member>\
                            <member><Path>/</Path><UserName>noite-fleets-shop-</UserName></member>\
                            </Users><IsTruncated>false</IsTruncated>\
                            </ListUsersResult></ListUsersResponse>"
                        ),
                        "ListAccessKeys" => "<ListAccessKeysResponse/>".to_string(),
                        _ => "<Response/>".to_string(),
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        sqlx::query(include_str!("../../schema.sql"))
            .execute(&pool)
            .await
            .expect("test schema");
        // This install's live key has a row; everything else rowless.
        let (nonce, ciphertext) = (b"nonce12bytes".as_slice(), b"ct".as_slice());
        crate::db::insert_scoped_credential(
            &pool,
            &crate::db::NewScopedCredential {
                app_id: "app-1",
                ciphertext,
                handle: &live_a,
                nonce,
                prefix: "fleets/shop/",
                scope: "app:app-1",
                store: "test-store",
            },
        )
        .await
        .expect("row");
        let endpoint = format!("http://127.0.0.1:{}", addr.port());
        let provider = test_provider(endpoint, "bucket-a");
        let mut cfg = config_for_tests();
        cfg.credentials = Credentials::Scoped(Arc::new(provider));
        let report = orphan_sweep(&pool, &cfg).await;
        handle.abort();
        pool.close().await;
        assert!(
            report.error.is_none(),
            "unexpected error: {:?}",
            report.error
        );
        assert_eq!(
            report.listed, 2,
            "only this install's users list: {report:?}"
        );
        assert_eq!(report.revoked, 1, "exactly the orphan revokes: {report:?}");
        assert_eq!(
            removed.lock().expect("removed lock").as_slice(),
            &[orphan_a],
            "the other install's key and the legacy key survive"
        );
    }
}
