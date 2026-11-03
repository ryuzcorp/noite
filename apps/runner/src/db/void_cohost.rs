//! Skip-when-unchanged state for runner-owned cohosted scripts (SPEC,
//! Void platform proxy): one content hash per fleet per script.
//!
//! A Void fleet carries the tenant app plus runner-owned scripts (today
//! `noite-void-proxy`, later `noite-void-sandbox`), each deployed with
//! `celld deploy` before the app. The bundle and rendered config are the
//! runner's own, so a deploy skips a script whose content hash matches the
//! stored one — steady state is one app deploy, zero pointer flapping.
//! Production keys on `environment_id = ''` (as telemetry does); each
//! preview keys on its environment id, so previews never share
//! production's skip state.
//!
//! The hash covers the script's sources and its rendered config with
//! secret values substituted by their hashes (see
//! [`crate::host::void_cohost`]), so a token rotation redeploys the
//! script. The row holds the digest only — never a secret.

use sqlx::SqlitePool;

use crate::models::now_iso;

/// The fleet key for the cohost table: `''` for production (telemetry's
/// convention), the environment id for a preview.
pub fn fleet_key(environment_id: Option<&str>) -> &str {
    environment_id.unwrap_or("")
}

/// The stored content hash for one fleet's script, if the fleet ever
/// deployed it.
pub async fn get_cohost_hash(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    script: &str,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT hash FROM void_cohost_hash WHERE app_id = ? AND environment_id = ? AND script = ?",
    )
    .bind(app_id)
    .bind(fleet_key(environment_id))
    .bind(script)
    .fetch_optional(pool)
    .await
}

/// Record one fleet's script hash after a successful deploy (or refresh
/// it when the script was skipped — the stored value is already it).
pub async fn set_cohost_hash(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    script: &str,
    hash: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO void_cohost_hash (app_id, environment_id, script, hash, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (app_id, environment_id, script) DO UPDATE SET hash = excluded.hash, \
         updated_at = excluded.updated_at",
    )
    .bind(app_id)
    .bind(fleet_key(environment_id))
    .bind(script)
    .bind(hash)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop one environment's cohost state (its teardown path): a reused label
/// gets a fresh environment id and must not inherit skip state.
pub async fn delete_environment_hashes(
    pool: &SqlitePool,
    environment_id: &str,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM void_cohost_hash WHERE environment_id = ?")
        .bind(environment_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed(pool: &SqlitePool) -> (crate::models::App, crate::models::Environment) {
        let cfg = crate::config::config_for_tests();
        let app = crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "cohost-app",
                slug: "cohost-app",
                user_id: "local",
                subdomain: "cohost-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        let env = crate::db::create_environment(
            pool,
            &cfg,
            crate::db::NewEnvironment {
                app_id: &app.id,
                slug: "cohost-app",
                label: "staging",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/staging",
                created_by: "user_1",
                listen: 30010,
                internal: 30011,
            },
        )
        .await
        .expect("seed env");
        (app, env)
    }

    /// One hash per fleet per script: production and a preview track
    /// independently, and a second script tracks beside the first.
    #[tokio::test]
    async fn hashes_are_per_fleet_per_script() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let (app, env) = seed(&pool).await;
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-proxy")
                .await
                .unwrap(),
            None
        );

        set_cohost_hash(&pool, &app.id, None, "noite-void-proxy", "aaa")
            .await
            .unwrap();
        set_cohost_hash(&pool, &app.id, Some(&env.id), "noite-void-proxy", "bbb")
            .await
            .unwrap();
        set_cohost_hash(&pool, &app.id, None, "noite-void-sandbox", "ccc")
            .await
            .unwrap();
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-proxy")
                .await
                .unwrap()
                .as_deref(),
            Some("aaa")
        );
        assert_eq!(
            get_cohost_hash(&pool, &app.id, Some(&env.id), "noite-void-proxy")
                .await
                .unwrap()
                .as_deref(),
            Some("bbb")
        );
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-sandbox")
                .await
                .unwrap()
                .as_deref(),
            Some("ccc")
        );

        // A redeploy overwrites its own row only.
        set_cohost_hash(&pool, &app.id, None, "noite-void-proxy", "aaa2")
            .await
            .unwrap();
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-proxy")
                .await
                .unwrap()
                .as_deref(),
            Some("aaa2")
        );
        assert_eq!(
            get_cohost_hash(&pool, &app.id, Some(&env.id), "noite-void-proxy")
                .await
                .unwrap()
                .as_deref(),
            Some("bbb")
        );
    }

    /// App deletes cascade; an environment delete drops its own rows when
    /// the teardown path calls [`delete_environment_hashes`].
    #[tokio::test]
    async fn hashes_die_with_their_fleet() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let (app, env) = seed(&pool).await;
        set_cohost_hash(&pool, &app.id, None, "noite-void-proxy", "aaa")
            .await
            .unwrap();
        set_cohost_hash(&pool, &app.id, Some(&env.id), "noite-void-proxy", "bbb")
            .await
            .unwrap();

        delete_environment_hashes(&pool, &env.id).await.unwrap();
        assert_eq!(
            get_cohost_hash(&pool, &app.id, Some(&env.id), "noite-void-proxy")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-proxy")
                .await
                .unwrap()
                .as_deref(),
            Some("aaa")
        );

        crate::db::delete_app(&pool, &app.id).await.unwrap();
        assert_eq!(
            get_cohost_hash(&pool, &app.id, None, "noite-void-proxy")
                .await
                .unwrap(),
            None
        );
    }
}
