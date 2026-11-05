//! Noite's Void platform proxy as a cohosted script (SPEC, Void platform
//! proxy): the embedded worker sources plus the per-fleet render.
//!
//! Each Void fleet carries one runner-owned `noite-void-proxy` script next
//! to the tenant app, reachable only through the app's in-fleet
//! `__VOID_PROXY` service binding. The proxy is self-sufficient
//! (fleet-local KV plus direct egress) and never calls the runner.
//!
//! Sources: `apps/void-proxy/worker.ts` (the celld `main` entry) plus the
//! whole `src/` tree it imports, embedded with `include_str!` — the same
//! compile-time pattern as the `cf-config.mjs` converter
//! ([`super::deploy`] embeds it; the control bundle instead ships on disk
//! because it is built inside the image, while the proxy's dependency-free
//! modules compile straight in). Tests, `test-helpers.ts` and
//! `sockets.d.ts` never ship: the embedded set is an explicit list, pinned
//! by test. celld bundles the `.ts` entry with esbuild at deploy, so
//! there is no build step. The image build copies the same files where the
//! includes resolve (`docker/Dockerfile`, `compose.dev.yaml`).
//!
//! Render ([`render_proxy`]): `wrangler.json` with the proxy's name, main,
//! the `ISR_CACHE` binding (the same namespace id the app's own injection
//! uses, so the proxy purges what the app caches) and the fixed-id
//! `MAIL_IDEMPOTENCY` binding, plus vars per the SPEC Env contract:
//! identity (app id, slug, the fleet's token), the operator's email/AI
//! section, and the fleet's proxy-only settings. Unset optionals are
//! omitted (the worker treats missing and empty identically); the token,
//! SMTP credential and AI key are [`RenderedCohost`] secrets, so a
//! rotation flips the content hash and redeploys the proxy.
//!
//! Proxy-only settings (`VOID_PROXY_SMTP_USERNAME`,
//! `VOID_PROXY_SMTP_PASSWORD`, `VOID_PROXY_AI_API_KEY`) are ordinary
//! Settings rows (served like any other setting — single-operator premise,
//! the control worker redacts values for the UI — inheritable and
//! per-environment overridable) that [`split_proxy_settings`] pulls out of
//! the Worker-vars input before the merges — they only ever reach the
//! proxy render, never the app's vars or any process env (the names are
//! [`crate::host::worker_vars`]-reserved on Void apps and process-reserved
//! everywhere). No operator-wide secret ever lands in proxy vars: SMTP/AI
//! credentials are per-app by construction.

use serde_json::{json, Value};

use crate::config::VoidProxyConfig;
use crate::host::void_cohost::{CohostSource, CohostedScript, RenderedCohost};
use crate::host::void_deploy;

/// The mail-idempotency KV namespace id. Fixed across apps: celld scopes
/// the id to the fleet bucket, so each app and each preview gets its own.
pub const MAIL_IDEMPOTENCY_BINDING: &str = "MAIL_IDEMPOTENCY";
pub const MAIL_IDEMPOTENCY_NAMESPACE_ID: &str = "noite-void-proxy-mail";

/// Proxy-only setting names: per-app credentials that only the proxy
/// render consumes. Reserved as Worker vars on Void apps, so on a Void
/// app these names can only mean the proxy — any other use fails the
/// deploy naming them.
pub const SMTP_USERNAME_SETTING: &str = "VOID_PROXY_SMTP_USERNAME";
pub const SMTP_PASSWORD_SETTING: &str = "VOID_PROXY_SMTP_PASSWORD";
pub const AI_API_KEY_SETTING: &str = "VOID_PROXY_AI_API_KEY";

/// Deploy order among cohosted scripts: the proxy deploys after the
/// sandbox controller ([`super::void_sandbox::SANDBOX_ORDER`]) and before
/// the tenant app (which always deploys last).
pub const PROXY_ORDER: u32 = 10;

/// Vars holding secrets: substituted by their hashes for the content
/// hash, so a rotation redeploys the proxy.
const SECRET_VARS: &[&str] = &[
    void_deploy::PROXY_TOKEN_VAR,
    SMTP_USERNAME_SETTING,
    SMTP_PASSWORD_SETTING,
    AI_API_KEY_SETTING,
];

/// The embedded proxy worker: `worker.ts` plus the `src/` tree it
/// imports. The list is explicit (and pinned by test) so tests, helpers
/// and type shims can never ship.
const PROXY_SOURCES: &[CohostSource] = &[
    CohostSource {
        path: "worker.ts",
        contents: include_str!("../../../void-proxy/worker.ts"),
    },
    CohostSource {
        path: "src/env.ts",
        contents: include_str!("../../../void-proxy/src/env.ts"),
    },
    CohostSource {
        path: "src/isr-keys.ts",
        contents: include_str!("../../../void-proxy/src/isr-keys.ts"),
    },
    CohostSource {
        path: "src/auth.ts",
        contents: include_str!("../../../void-proxy/src/auth.ts"),
    },
    CohostSource {
        path: "src/revalidate.ts",
        contents: include_str!("../../../void-proxy/src/revalidate.ts"),
    },
    CohostSource {
        path: "src/ai.ts",
        contents: include_str!("../../../void-proxy/src/ai.ts"),
    },
    CohostSource {
        path: "src/email/validate.ts",
        contents: include_str!("../../../void-proxy/src/email/validate.ts"),
    },
    CohostSource {
        path: "src/email/smtp.ts",
        contents: include_str!("../../../void-proxy/src/email/smtp.ts"),
    },
    CohostSource {
        path: "src/email/send.ts",
        contents: include_str!("../../../void-proxy/src/email/send.ts"),
    },
];

/// The proxy as a cohosted script.
pub const PROXY_SCRIPT: CohostedScript = CohostedScript {
    name: void_deploy::PROXY_SCRIPT_NAME,
    main: "worker.ts",
    sources: PROXY_SOURCES,
    order: PROXY_ORDER,
};

/// One fleet's proxy-only settings, split out of the Worker-vars input.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProxySettings {
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub ai_api_key: Option<String>,
}

/// Split the proxy-only settings out of the merged Worker settings (app
/// settings with the environment's overrides applied): the three
/// credential names become the proxy render's input, everything else
/// flows to the app merges untouched and in order. Empty values read as
/// unset (the worker treats missing and empty identically).
pub fn split_proxy_settings(
    settings: Vec<(String, String)>,
) -> (ProxySettings, Vec<(String, String)>) {
    let mut proxy = ProxySettings::default();
    let mut rest = Vec::with_capacity(settings.len());
    for (name, value) in settings {
        let some = (!value.is_empty()).then(|| value.clone());
        match name.as_str() {
            SMTP_USERNAME_SETTING => proxy.smtp_username = some,
            SMTP_PASSWORD_SETTING => proxy.smtp_password = some,
            AI_API_KEY_SETTING => proxy.ai_api_key = some,
            _ => rest.push((name, value)),
        }
    }
    (proxy, rest)
}

/// What one fleet's proxy renders from: identity, the operator section
/// and the fleet's proxy-only settings.
pub struct ProxyRenderCtx<'a> {
    pub app_id: &'a str,
    pub app_slug: &'a str,
    pub proxy_token: &'a str,
    pub operator: &'a VoidProxyConfig,
    pub settings: &'a ProxySettings,
}

/// Render one fleet's proxy project: the cohosted script plus its
/// `wrangler.json` (name, main, KV bindings, vars per the SPEC Env
/// contract). Unset optionals are omitted.
/// Insert a var unless its value is empty (the worker treats missing
/// and empty identically, so unset optionals stay out of the config).
fn put(vars: &mut serde_json::Map<String, Value>, name: &str, value: &str) {
    if !value.is_empty() {
        vars.insert(name.to_string(), Value::String(value.to_string()));
    }
}

pub fn render_proxy(ctx: &ProxyRenderCtx<'_>) -> RenderedCohost {
    let mut vars = serde_json::Map::new();
    put(&mut vars, void_deploy::PROJECT_ID_VAR, ctx.app_id);
    put(&mut vars, void_deploy::PROJECT_SLUG_VAR, ctx.app_slug);
    // The token is minted non-empty; `put` still guards the render.
    put(&mut vars, void_deploy::PROXY_TOKEN_VAR, ctx.proxy_token);
    let operator = ctx.operator;
    put(
        &mut vars,
        void_deploy::EMAIL_DOMAIN_VAR,
        &operator.email_domain,
    );
    put(&mut vars, "VOID_PROXY_SMTP_HOST", &operator.smtp_host);
    if let Some(port) = operator.smtp_port {
        vars.insert(
            "VOID_PROXY_SMTP_PORT".to_string(),
            Value::String(port.to_string()),
        );
    }
    vars.insert(
        "VOID_PROXY_SMTP_MODE".to_string(),
        Value::String(operator.smtp_mode.as_str().to_string()),
    );
    if operator.smtp_allow_plaintext {
        vars.insert(
            "VOID_PROXY_SMTP_ALLOW_PLAINTEXT".to_string(),
            Value::String("1".to_string()),
        );
    }
    if let Some(username) = &ctx.settings.smtp_username {
        put(&mut vars, SMTP_USERNAME_SETTING, username);
    }
    if let Some(password) = &ctx.settings.smtp_password {
        put(&mut vars, SMTP_PASSWORD_SETTING, password);
    }
    if !operator.email_allowlist.is_empty() {
        vars.insert(
            "VOID_PROXY_EMAIL_ALLOWLIST".to_string(),
            Value::String(operator.email_allowlist.join(",")),
        );
    }
    if operator.ai_enabled {
        vars.insert(
            "VOID_PROXY_AI_ENABLED".to_string(),
            Value::String("1".to_string()),
        );
    }
    put(&mut vars, "VOID_PROXY_AI_MODELS", &operator.ai_models);
    if let Some(key) = &ctx.settings.ai_api_key {
        put(&mut vars, AI_API_KEY_SETTING, key);
    }
    RenderedCohost {
        script: &PROXY_SCRIPT,
        secret_vars: SECRET_VARS,
        config: json!({
            "name": void_deploy::PROXY_SCRIPT_NAME,
            "main": PROXY_SCRIPT.main,
            "compatibility_date": "2026-09-01",
            "kv_namespaces": [
                {"binding": void_deploy::ISR_CACHE_BINDING, "id": void_deploy::ISR_CACHE_NAMESPACE_ID},
                {"binding": MAIL_IDEMPOTENCY_BINDING, "id": MAIL_IDEMPOTENCY_NAMESPACE_ID},
            ],
            "vars": Value::Object(vars),
        }),
        // Fully embedded, config-carried, containerless: the proxy needs
        // none of the runtime render inputs.
        extra_sources: Vec::new(),
        extra_hash_input: Vec::new(),
        declares_containers: false,
        read_root: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operator() -> VoidProxyConfig {
        VoidProxyConfig {
            email_domain: "mail.example.com".to_string(),
            smtp_host: "smtp.example.com".to_string(),
            smtp_port: Some(2525),
            smtp_mode: crate::config::VoidSmtpMode::Implicit,
            smtp_allow_plaintext: false,
            email_allowlist: vec!["ops@example.com".to_string(), "@example.com".to_string()],
            ai_enabled: true,
            ai_models: r#"{"@cf/m": {"endpoint": "https://ai.example.com/v1", "model": "m"}}"#
                .to_string(),
            ai_allow_plaintext: false,
        }
    }

    fn settings() -> ProxySettings {
        ProxySettings {
            smtp_username: Some("app-a-smtp-user".to_string()),
            smtp_password: Some("app-a-smtp-pass".to_string()),
            ai_api_key: Some("app-a-ai-key".to_string()),
        }
    }

    /// The embedded set is exactly SPEC's list — the entry plus the `src/`
    /// tree — and the entry is the configured `main`. Tests, helpers and
    /// the socket types cannot ship: they are not in the list, and
    /// `include_str!` fails the build if a listed file is missing.
    #[test]
    fn embedded_sources_are_exactly_the_shipped_tree() {
        let paths: Vec<&str> = PROXY_SCRIPT.sources.iter().map(|s| s.path).collect();
        assert_eq!(
            paths,
            [
                "worker.ts",
                "src/env.ts",
                "src/isr-keys.ts",
                "src/auth.ts",
                "src/revalidate.ts",
                "src/ai.ts",
                "src/email/validate.ts",
                "src/email/smtp.ts",
                "src/email/send.ts",
            ]
        );
        assert!(
            PROXY_SCRIPT
                .sources
                .iter()
                .any(|s| s.path == PROXY_SCRIPT.main),
            "main must be an embedded source"
        );
        for source in PROXY_SCRIPT.sources {
            assert!(
                !source.contents.is_empty(),
                "{} embedded empty",
                source.path
            );
            assert!(
                !source.contents.contains("test-helpers"),
                "{} imports test helpers",
                source.path
            );
        }
    }

    /// The golden render: name, main, both KV bindings and every var the
    /// SPEC Env contract names — identity, operator section, per-app
    /// credentials — with nothing else.
    #[test]
    fn golden_render_carries_the_env_contract() {
        let ctx = ProxyRenderCtx {
            app_id: "app-1",
            app_slug: "blog",
            proxy_token: "fleet-token",
            operator: &operator(),
            settings: &settings(),
        };
        let rendered = render_proxy(&ctx);
        assert_eq!(rendered.script.name, "noite-void-proxy");
        assert_eq!(
            rendered.config,
            json!({
                "name": "noite-void-proxy",
                "main": "worker.ts",
                "compatibility_date": "2026-09-01",
                "kv_namespaces": [
                    {"binding": "ISR_CACHE", "id": "noite-isr-cache"},
                    {"binding": "MAIL_IDEMPOTENCY", "id": "noite-void-proxy-mail"},
                ],
                "vars": {
                    "__PROJECT_ID": "app-1",
                    "__VOID_PROJECT_SLUG": "blog",
                    "__VOID_PROXY_TOKEN": "fleet-token",
                    "__VOID_EMAIL_DOMAIN": "mail.example.com",
                    "VOID_PROXY_SMTP_HOST": "smtp.example.com",
                    "VOID_PROXY_SMTP_PORT": "2525",
                    "VOID_PROXY_SMTP_MODE": "implicit",
                    "VOID_PROXY_SMTP_USERNAME": "app-a-smtp-user",
                    "VOID_PROXY_SMTP_PASSWORD": "app-a-smtp-pass",
                    "VOID_PROXY_EMAIL_ALLOWLIST": "ops@example.com,@example.com",
                    "VOID_PROXY_AI_ENABLED": "1",
                    "VOID_PROXY_AI_MODELS": r#"{"@cf/m": {"endpoint": "https://ai.example.com/v1", "model": "m"}}"#,
                    "VOID_PROXY_AI_API_KEY": "app-a-ai-key",
                },
            })
        );
        // No plaintext flag when the operator leaves it off.
        assert!(rendered.config["vars"]
            .as_object()
            .is_some_and(|vars| !vars.contains_key("VOID_PROXY_SMTP_ALLOW_PLAINTEXT")));
    }

    /// The disabled-operator golden: no email/AI section, no credentials —
    /// identity, the SMTP mode default and the bindings only. The proxy
    /// still deploys: `/revalidate` needs no operator config.
    #[test]
    fn golden_render_with_everything_unset_is_identity_only() {
        let ctx = ProxyRenderCtx {
            app_id: "app-1",
            app_slug: "blog",
            proxy_token: "fleet-token",
            operator: &VoidProxyConfig::default(),
            settings: &ProxySettings::default(),
        };
        let rendered = render_proxy(&ctx);
        assert_eq!(
            rendered.config,
            json!({
                "name": "noite-void-proxy",
                "main": "worker.ts",
                "compatibility_date": "2026-09-01",
                "kv_namespaces": [
                    {"binding": "ISR_CACHE", "id": "noite-isr-cache"},
                    {"binding": "MAIL_IDEMPOTENCY", "id": "noite-void-proxy-mail"},
                ],
                "vars": {
                    "__PROJECT_ID": "app-1",
                    "__VOID_PROJECT_SLUG": "blog",
                    "__VOID_PROXY_TOKEN": "fleet-token",
                    "VOID_PROXY_SMTP_MODE": "starttls",
                },
            })
        );
    }

    /// Isolation, render-level: two fleets' renders share the operator
    /// section but never each other's identity or credentials — A's SMTP
    /// password and AI key appear nowhere in B's config, and B's token
    /// nowhere in A's.
    #[test]
    fn fleet_renders_never_carry_each_others_secrets() {
        let operator = operator();
        let a = render_proxy(&ProxyRenderCtx {
            app_id: "app-a",
            app_slug: "a",
            proxy_token: "token-a",
            operator: &operator,
            settings: &ProxySettings {
                smtp_username: Some("smtp-user-a".to_string()),
                smtp_password: Some("smtp-pass-a".to_string()),
                ai_api_key: Some("ai-key-a".to_string()),
            },
        });
        let b = render_proxy(&ProxyRenderCtx {
            app_id: "app-b",
            app_slug: "b",
            proxy_token: "token-b",
            operator: &operator,
            settings: &ProxySettings {
                smtp_username: Some("smtp-user-b".to_string()),
                smtp_password: Some("smtp-pass-b".to_string()),
                ai_api_key: Some("ai-key-b".to_string()),
            },
        });
        let a_text = serde_json::to_string(&a.config).unwrap();
        let b_text = serde_json::to_string(&b.config).unwrap();
        for secret in ["token-a", "smtp-user-a", "smtp-pass-a", "ai-key-a"] {
            assert!(!b_text.contains(secret), "B's render leaks {}", secret);
        }
        for secret in ["token-b", "smtp-user-b", "smtp-pass-b", "ai-key-b"] {
            assert!(!a_text.contains(secret), "A's render leaks {}", secret);
        }
        // …while the operator section is shared.
        for shared in ["smtp.example.com", "ops@example.com", "ai.example.com"] {
            assert!(a_text.contains(shared), "A lost {}", shared);
            assert!(b_text.contains(shared), "B lost {}", shared);
        }
    }

    /// The split pulls the three credential names out of the Worker-vars
    /// input and leaves everything else — order included — for the app
    /// merges. Empty credential values read as unset.
    #[test]
    fn proxy_only_settings_split_out_of_worker_vars() {
        let (proxy, rest) = split_proxy_settings(vec![
            ("MODEL".to_string(), "x".to_string()),
            (SMTP_USERNAME_SETTING.to_string(), "u".to_string()),
            ("PORT".to_string(), "1".to_string()),
            (SMTP_PASSWORD_SETTING.to_string(), "p".to_string()),
            (AI_API_KEY_SETTING.to_string(), "k".to_string()),
        ]);
        assert_eq!(
            proxy,
            ProxySettings {
                smtp_username: Some("u".to_string()),
                smtp_password: Some("p".to_string()),
                ai_api_key: Some("k".to_string()),
            }
        );
        assert_eq!(
            rest,
            vec![
                ("MODEL".to_string(), "x".to_string()),
                ("PORT".to_string(), "1".to_string()),
            ]
        );

        let (proxy, rest) = split_proxy_settings(vec![
            (SMTP_PASSWORD_SETTING.to_string(), String::new()),
            ("MODEL".to_string(), "x".to_string()),
        ]);
        assert_eq!(proxy.smtp_password, None);
        assert_eq!(rest, vec![("MODEL".to_string(), "x".to_string())]);
    }
}
