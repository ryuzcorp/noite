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
fn env_reserved(name: &str) -> bool {
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
}

/// Tenant env ready to inject, minus reserved names. Feature flags are
/// plain `FLAG_<NAME>` rows (`1`/`0`) and flow through like any other var.
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
