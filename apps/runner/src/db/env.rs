//! Tenant env vars, minus the platform-reserved names.

use sqlx::SqlitePool;

use crate::models::{now_iso, AppEnv};

/// Tenant env vars (CF `.dev.vars` model: local file for dev, fleet env in
/// prod). Plaintext in SQLite like the other single-operator secrets — no
/// vault. Names are validated at the API layer; values capped at 32 KiB.
pub async fn list_env(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<AppEnv>> {
    sqlx::query_as::<_, AppEnv>(
        "SELECT app_id, name, value, updated_at FROM app_env WHERE app_id = ? ORDER BY name",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

pub async fn set_env(pool: &SqlitePool, app_id: &str, name: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_env (app_id, name, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, name) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
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
}

/// All settings as stored, unfiltered: the Worker-vars merge
/// (`host::worker_vars`) refuses its own reserved names loudly instead of
/// dropping them, and allows every process-reserved prefix there. A read
/// failure is an error, not an empty list: deploying without the app's
/// settings would ship a Worker missing its secrets.
pub async fn worker_settings(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    Ok(list_env(pool, app_id)
        .await?
        .into_iter()
        .map(|r| (r.name, r.value))
        .collect())
}

/// Tenant env ready to inject into build, release and fleet process env,
/// minus reserved names. Feature flags are plain `FLAG_<NAME>` rows (`1`/`0`)
/// and flow through like any other var. Worker `vars` come from
/// [`worker_settings`] instead (different reserved set, refused not dropped).
pub async fn tenant_env(pool: &SqlitePool, app_id: &str) -> Vec<(String, String)> {
    match list_env(pool, app_id).await {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|r| {
                if env_reserved(&r.name) {
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
    use super::{env_reserved, list_env, set_env, tenant_env, worker_settings};

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
        ] {
            set_env(&pool, &app.id, name, value).await.unwrap();
        }
        assert_eq!(list_env(&pool, &app.id).await.unwrap().len(), 3);
        assert_eq!(
            worker_settings(&pool, &app.id).await.unwrap(),
            vec![
                ("BETTER_AUTH_SECRET".to_string(), "s3cret".to_string()),
                ("MODEL".to_string(), "x".to_string()),
                ("PORT".to_string(), "9999".to_string()),
            ]
        );
        // The process input still drops the reserved two.
        assert_eq!(
            tenant_env(&pool, &app.id).await,
            vec![("MODEL".to_string(), "x".to_string())]
        );
    }

    #[test]
    fn platform_names_stay_reserved() {
        for name in [
            "PORT",
            "HOST",
            "AWS_REGION",
            "S3_ENDPOINT",
            "CELLD_WATCH",
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
        ] {
            assert!(env_reserved(name), "{name} reserved");
        }
        assert!(!env_reserved("BUN_INSTALL_CACHE_DIR"));
        assert!(!env_reserved("MODEL"));
        assert!(!env_reserved("OPENAI_API_KEY"));
    }
}
