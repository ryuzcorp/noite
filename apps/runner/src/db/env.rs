//! Tenant env vars, minus the platform-reserved names.
//!
//! Provenance is one closed type ([`EnvSource`]) rather than free-form text:
//! `''` is an operator's row, the three markers are the runner's provisioning
//! paths, and each merge asks the type which rows it may take. A marker the
//! type does not know cannot be read at all, so a hand-edited `source` can
//! never be silently treated as a user value.

use sqlx::SqlitePool;

use crate::models::{now_iso, AppEnv, EnvSource};

/// Tenant env vars (CF `.dev.vars` model: local file for dev, fleet env in
/// prod). Plaintext in SQLite like the other single-operator secrets — no
/// vault. Names are validated at the API layer; values capped at 32 KiB.
///
/// `source` marks runner-provisioned rows ([`EnvSource`]); user rows carry
/// `''`. The listing serves every row with its value (single-operator
/// premise; the control worker redacts values for the UI), while each deploy
/// input filters on the source (see [`worker_settings`] and [`tenant_env`]).
pub async fn list_env(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<AppEnv>> {
    sqlx::query_as::<_, AppEnv>(
        "SELECT app_id, name, value, updated_at, source FROM app_env WHERE app_id = ? ORDER BY name",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// One row with its source marker, for the provision helpers.
pub async fn get_env(pool: &SqlitePool, app_id: &str, name: &str) -> sqlx::Result<Option<AppEnv>> {
    sqlx::query_as::<_, AppEnv>(
        "SELECT app_id, name, value, updated_at, source FROM app_env WHERE app_id = ? AND name = ?",
    )
    .bind(app_id)
    .bind(name)
    .fetch_optional(pool)
    .await
}

pub async fn set_env(pool: &SqlitePool, app_id: &str, name: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_env (app_id, name, value, updated_at, source) VALUES (?, ?, ?, ?, '')
           ON CONFLICT (app_id, name) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at, source = ''"#,
    )
    .bind(app_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

/// Store a runner-provisioned value, never overwriting: an existing row —
/// user-written or already provisioned — wins, and the caller reuses it.
/// Returns whether this call inserted the row.
pub async fn insert_provisioned(
    pool: &SqlitePool,
    app_id: &str,
    name: &str,
    value: &str,
    source: EnvSource,
) -> sqlx::Result<bool> {
    let done = sqlx::query(
        "INSERT INTO app_env (app_id, name, value, updated_at, source) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (app_id, name) DO NOTHING",
    )
    .bind(app_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
    .bind(source.as_str())
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Overwrite a row with a provisioned value (token rotation): the value and
/// the marker are the runner's again, whatever the row held before.
pub async fn set_provisioned(
    pool: &SqlitePool,
    app_id: &str,
    name: &str,
    value: &str,
    source: EnvSource,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_env (app_id, name, value, updated_at, source) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (app_id, name) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at, source = excluded.source"#,
    )
    .bind(app_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
    .bind(source.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_env(pool: &SqlitePool, app_id: &str, name: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM app_env WHERE app_id = ? AND name = ?")
        .bind(app_id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reserved prefixes/names the platform owns — tenant values for these are
/// dropped (logged) rather than injected into fleet/build/release env.
pub(crate) fn env_reserved(name: &str) -> bool {
    name == "PORT"
        || name == "HOST"
        || name.starts_with("AWS_")
        || name.starts_with("S3_")
        || name.starts_with("CELLD_")
        || name.starts_with("RUNNER_")
        || name.starts_with("NOITE_")
        || name.starts_with("BETTER_AUTH_")
        || name.starts_with("CADDY_")
        || name.starts_with("LD_")
        || name == "NODE_OPTIONS"
        || (name.starts_with("BUN_") && name != "BUN_INSTALL_CACHE_DIR")
        // Engine selection is per-fleet proxy plumbing: a tenant override
        // would steer fleet celld at another engine than its own proxy
        // socket (or at the host socket directly).
        || name == "DOCKER_HOST"
        // Fleet TLS trust and proxy routing: the platform passes these
        // only when the operator set them (`fleet_env::INHERITED`), so
        // ordering alone cannot win them, and a tenant row would survive
        // verbatim into fleet process env (store-TLS anchors via
        // rustls-native-certs; store, peer and control traffic via
        // reqwest's proxy autodetect). Both cases: the toolchains read
        // lowercase too. Dropped, not refused, like every reserved name,
        // from fleet, build and release env alike.
        || name == "SSL_CERT_FILE"
        || name == "SSL_CERT_DIR"
        || name == "HTTP_PROXY"
        || name == "HTTPS_PROXY"
        || name == "ALL_PROXY"
        || name == "NO_PROXY"
        || name == "http_proxy"
        || name == "https_proxy"
        || name == "all_proxy"
        || name == "no_proxy"
        // The Void proxy's namespace: per-app credentials that only the
        // proxy render consumes. Never process env — like `BETTER_AUTH_*`,
        // process-reserved but (on non-Void apps) Worker-allowed.
        || name.starts_with("VOID_PROXY_")
}

/// All settings as stored, unfiltered: the Worker-vars merge
/// (`host::worker_vars`) refuses its own reserved names loudly instead of
/// dropping them, and allows every process-reserved prefix there. A read
/// failure is an error, not an empty list: deploying without the app's
/// settings would ship a Worker missing its secrets.
///
/// The filter is the runner-owned rows (`void-proxy-token`,
/// `void-sandbox-admission`): their names are reserved in the merge, so
/// the runner-owned merge (proxy token) and the sandbox controller render
/// (admission name) inject them alone. The auto-provisioned
/// `BETTER_AUTH_SECRET` (`auth-default`) stays in: it is an ordinary var
/// under an allowed name.
pub async fn worker_settings(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    Ok(list_env(pool, app_id)
        .await?
        .into_iter()
        .filter(|r| !r.source.is_runner_owned())
        .map(|r| (r.name, r.value))
        .collect())
}

/// Tenant env ready to inject into build, release and fleet process env,
/// minus reserved names. Feature flags are plain `FLAG_<NAME>` rows (`1`/`0`)
/// and flow through like any other var. Worker `vars` come from
/// [`worker_settings`] instead (different reserved set, refused not dropped).
///
/// Provisioned rows never reach process env: the proxy token
/// authenticates the Worker to its own fleet's proxy, the admission name
/// addresses the fleet's sandbox admission cell, and the auth secret is a
/// Worker secret. The proxy-only credential rows (`VOID_PROXY_*`) are
/// dropped by the process-reserved prefix rule — only the proxy render
/// consumes them.
/// (A user row under a reserved name fails the deploy at the Worker-vars
/// merge, before any fleet sees process env.)
pub async fn tenant_env(pool: &SqlitePool, app_id: &str) -> Vec<(String, String)> {
    match list_env(pool, app_id).await {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|r| {
                if r.source.is_provisioned() {
                    None
                } else if env_reserved(&r.name) {
                    tracing::warn!(app_id, name = %r.name, "tenant env reserved; skipping");
                    None
                } else {
                    Some((r.name, r.value))
                }
            })
            .collect(),
        Err(e) => {
            tracing::warn!(app_id, error = %e, "tenant env list failed; deploying without");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        env_reserved, get_env, insert_provisioned, list_env, set_env, set_provisioned, tenant_env,
        worker_settings,
    };
    use crate::models::EnvSource;

    /// The Worker-vars input is unfiltered: process-reserved names
    /// (`BETTER_AUTH_*` for Void auth, `PORT`, …) reach the merge, which
    /// refuses only its own runner-owned names.
    #[tokio::test]
    async fn worker_settings_keep_process_reserved_names() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let cfg = crate::config::config_for_tests();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "env-app",
                slug: "env-app",
                user_id: "local",
                subdomain: "env-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        for (name, value) in [
            ("BETTER_AUTH_SECRET", "s3cret"),
            ("PORT", "9999"),
            ("MODEL", "x"),
            ("VOID_PROXY_SMTP_PASSWORD", "cred"),
        ] {
            set_env(&pool, &app.id, name, value).await.unwrap();
        }
        assert_eq!(list_env(&pool, &app.id).await.unwrap().len(), 4);
        // The proxy-only row rides the settings load: the deploy flow
        // splits it out for the proxy render before the app merges.
        assert_eq!(
            worker_settings(&pool, &app.id).await.unwrap(),
            vec![
                ("BETTER_AUTH_SECRET".to_string(), "s3cret".to_string()),
                ("MODEL".to_string(), "x".to_string()),
                ("PORT".to_string(), "9999".to_string()),
                ("VOID_PROXY_SMTP_PASSWORD".to_string(), "cred".to_string()),
            ]
        );
        // The process input still drops the reserved three.
        assert_eq!(
            tenant_env(&pool, &app.id).await,
            vec![("MODEL".to_string(), "x".to_string())]
        );
    }

    /// Provisioned rows route by marker: the auth secret rides the settings
    /// merges, the proxy token rides the runner-owned merge only, the
    /// sandbox admission name rides the controller render only, and none
    /// reaches process env. The listing keeps every row with its value
    /// (the control worker redacts values for the UI).
    #[tokio::test]
    async fn provisioned_rows_route_by_source_marker() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let cfg = crate::config::config_for_tests();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "prov-app",
                slug: "prov-app",
                user_id: "local",
                subdomain: "prov-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        assert!(insert_provisioned(
            &pool,
            &app.id,
            "BETTER_AUTH_SECRET",
            "minted",
            EnvSource::AuthDefault
        )
        .await
        .unwrap());
        assert!(insert_provisioned(
            &pool,
            &app.id,
            "__VOID_PROXY_TOKEN",
            "tok",
            EnvSource::VoidProxyToken
        )
        .await
        .unwrap());
        assert!(insert_provisioned(
            &pool,
            &app.id,
            "__VOID_SANDBOX_ADMISSION_NAME",
            "admission",
            EnvSource::VoidSandboxAdmission
        )
        .await
        .unwrap());
        set_env(&pool, &app.id, "MODEL", "x").await.unwrap();

        assert_eq!(
            worker_settings(&pool, &app.id).await.unwrap(),
            vec![
                ("BETTER_AUTH_SECRET".to_string(), "minted".to_string()),
                ("MODEL".to_string(), "x".to_string()),
            ]
        );
        assert_eq!(
            tenant_env(&pool, &app.id).await,
            vec![("MODEL".to_string(), "x".to_string())]
        );
        assert_eq!(list_env(&pool, &app.id).await.unwrap().len(), 4);

        // Never overwriting: a second insert loses, whatever the marker.
        assert!(!insert_provisioned(
            &pool,
            &app.id,
            "BETTER_AUTH_SECRET",
            "other",
            EnvSource::AuthDefault
        )
        .await
        .unwrap());
        assert!(
            !insert_provisioned(&pool, &app.id, "MODEL", "other", EnvSource::AuthDefault)
                .await
                .unwrap()
        );
        assert_eq!(
            get_env(&pool, &app.id, "BETTER_AUTH_SECRET")
                .await
                .unwrap()
                .unwrap()
                .value,
            "minted"
        );
        // A user write over a provisioned row makes it a user row.
        set_env(&pool, &app.id, "BETTER_AUTH_SECRET", "mine")
            .await
            .unwrap();
        let row = get_env(&pool, &app.id, "BETTER_AUTH_SECRET")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.value, "mine");
        assert_eq!(row.source, EnvSource::User);
        // Rotation overwrites unconditionally and re-marks the row.
        set_provisioned(&pool, &app.id, "MODEL", "rot", EnvSource::VoidProxyToken)
            .await
            .unwrap();
        let row = get_env(&pool, &app.id, "MODEL").await.unwrap().unwrap();
        assert_eq!(row.value, "rot");
        assert_eq!(row.source, EnvSource::VoidProxyToken);
    }

    #[test]
    fn platform_names_stay_reserved() {
        for name in [
            "PORT",
            "HOST",
            "AWS_REGION",
            "S3_ENDPOINT",
            "CELLD_WATCH",
            // The fleet's auth token and network/memory fence: tenant rows
            // under these names must never reach fleet process env (the
            // spawn also applies tenant vars before platform knobs, so
            // platform wins by construction even so).
            "CELLD_OPERATOR_TOKEN",
            "CELLD_EGRESS",
            "CELLD_EGRESS_ALLOW",
            "CELLD_MEMORY_SCOPE",
            "CELLD_CACHE_SCOPE",
            "RUNNER_TOKEN",
            "NOITE_IMAGE",
            "BETTER_AUTH_URL",
            "CADDY_ADMIN",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "BUN_BEACON",
            // Engine selection is per-fleet proxy plumbing: a tenant override
            // would steer fleet celld at another engine than its own proxy
            // socket (or at the host socket directly).
            "DOCKER_HOST",
            // Fleet TLS trust and proxy routing (see `env_reserved`): the
            // platform wins these by refusal, not by ordering.
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            // The Void proxy's namespace: proxy-render input only.
            "VOID_PROXY_SMTP_PASSWORD",
            "VOID_PROXY_AI_API_KEY",
        ] {
            assert!(env_reserved(name), "{name} reserved");
        }
        assert!(!env_reserved("BUN_INSTALL_CACHE_DIR"));
        assert!(!env_reserved("MODEL"));
        assert!(!env_reserved("OPENAI_API_KEY"));
    }
}
