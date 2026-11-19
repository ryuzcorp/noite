//! Tenant D1 `migrations_dir` apply (SPEC, Deploy pipeline): a Worker that
//! declares a D1 binding with `migrations_dir` expects `wrangler d1 migrations
//! apply` semantics — ordered `NNNN_name.sql` files from `migrations_dir`
//! (default `migrations`), tracked in a `d1_migrations` table so each file
//! applies once, each file in its own transaction. cello records the
//! declaration but only its manual CLI applies migrations, so a deploy that
//! skipped this step left the Worker's tables missing. The deploy now runs
//! `cello d1 migrations apply` once per D1 binding, reusing cello's own
//! migrator (same ordering, same bookkeeping table, same per-file
//! transactions as wrangler) instead of a second implementation.
//!
//! Ordering: a redeploy runs this step between `stage` and `activate`, before
//! the new generation takes traffic — a failed migration fails the deploy
//! with nothing activated, so the previous generation keeps serving. A first
//! deploy (no previous generation, or a fleet that cannot boot to serve one)
//! has nothing to protect, so it runs after activation, against the adopted
//! fleet, before the deploy is marked success. Either way applied migrations
//! stay applied (forward-only): a rollback to an older sha never un-applies
//! or re-applies — already-applied rows in `d1_migrations` are skipped — it
//! only applies what is pending, and a `0002` added after `0001` applies just
//! `0002` on the next deploy.
//!
/// The bookkeeping table cello tracks applied migrations in (`d1_migrations`
/// by default, `migrations_table` when the binding sets it).
pub const DEFAULT_MIGRATIONS_TABLE: &str = "d1_migrations";

/// True when `name` is a plain SQLite identifier (what cello accepts for
/// `migrations_table`): letters, digits and underscores, not starting with a
/// digit. Anything else fails the deploy before it reaches SQL.
pub fn is_plain_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

use std::path::{Component, Path, PathBuf};

use anyhow::Context;

/// One D1 binding's migration source: the `database_name` cello's positional
/// names, the declared `migrations_dir` (default `migrations`), and the
/// bookkeeping table (default `d1_migrations`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantD1Binding {
    pub database_name: String,
    pub migrations_dir: String,
    pub migrations_table: String,
}

/// Read the deploy root's `d1_databases` (the config `cello deploy` uploads).
/// TOML-only roots have no JSON to read: cello refuses them at stage time, so
/// there is nothing to migrate here.
pub fn collect_d1_bindings(deploy_root: &Path) -> anyhow::Result<Vec<TenantD1Binding>> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let Ok(text) = std::fs::read_to_string(deploy_root.join(name)) else {
            continue;
        };
        let value =
            crate::host::storage::parse_wrangler(&text).with_context(|| format!("parse {name}"))?;
        let Some(obj) = value.as_object() else {
            continue;
        };
        let Some(dbs) = obj.get("d1_databases") else {
            return Ok(Vec::new());
        };
        let arr = dbs
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("config `d1_databases` must be an array"))?;
        let mut out = Vec::with_capacity(arr.len());
        for (index, entry) in arr.iter().enumerate() {
            let Some(map) = entry.as_object() else {
                anyhow::bail!("config `d1_databases[{index}]` must be an object");
            };
            let binding = map
                .get("binding")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let database_name = map
                .get("database_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            if database_name.is_empty() {
                anyhow::bail!("d1 binding {binding:?} has an empty `database_name`");
            }
            if database_name.starts_with('-') {
                anyhow::bail!("d1 database {database_name:?} is not a valid migration target");
            }
            let migrations_table = match map.get("migrations_table") {
                None => DEFAULT_MIGRATIONS_TABLE.to_string(),
                Some(table) => {
                    let Some(table) = table.as_str() else {
                        anyhow::bail!(
                            "d1 database {database_name:?} has a non-string `migrations_table`"
                        );
                    };
                    if !is_plain_identifier(table) {
                        anyhow::bail!(
                            "d1 database {database_name:?} has a `migrations_table` that is not a plain identifier: {table:?}"
                        );
                    }
                    table.to_string()
                }
            };
            if let Some(dir) = map.get("migrations_dir") {
                let Some(dir) = dir.as_str() else {
                    anyhow::bail!(
                        "d1 database {database_name:?} has a non-string `migrations_dir`"
                    );
                };
                if dir.is_empty() {
                    anyhow::bail!("d1 database {database_name:?} has an empty `migrations_dir`");
                }
                let rel = Path::new(dir);
                if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir))
                {
                    anyhow::bail!(
                        "d1 database {database_name:?} `migrations_dir` {dir:?} escapes the project"
                    );
                }
                out.push(TenantD1Binding {
                    database_name,
                    migrations_dir: dir.to_string(),
                    migrations_table,
                });
            } else {
                out.push(TenantD1Binding {
                    database_name,
                    migrations_dir: "migrations".to_string(),
                    migrations_table,
                });
            }
        }
        return Ok(out);
    }
    Ok(Vec::new())
}

/// Resolve the binding's migrations directory against the deploy root:
/// canonicalize the root and the joined dir (a missing dir is `Ok(None)` —
/// a Worker with a D1 binding and no migration files deploys green with
/// nothing to apply), then require the result to stay under the root. The dir
/// itself may not be a symlink — not even one pointing inside the tree:
/// cello follows it when reading, and the deploy must never execute SQL from
/// outside the pushed tree (host paths, another tenant's checkout) with the
/// results landing in the tenant-readable deploy log. A dir outside the root
/// fails the deploy loudly, never a silent skip.
pub fn resolve_migrations_dir(
    deploy_root: &Path,
    binding: &TenantD1Binding,
) -> anyhow::Result<Option<PathBuf>> {
    let root = deploy_root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", deploy_root.display()))?;
    let joined = root.join(&binding.migrations_dir);
    // `symlink_metadata` follows nothing: a symlink reports as one here even
    // when its target is a directory, where `is_dir` would say yes.
    if std::fs::symlink_metadata(&joined).is_ok_and(|meta| meta.file_type().is_symlink()) {
        anyhow::bail!(
            "refusing D1 `{}` migrations_dir {:?}: is a symlink",
            binding.database_name,
            binding.migrations_dir
        );
    }
    let dir = match joined.canonicalize() {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", joined.display())),
    };
    if !dir.starts_with(&root) {
        anyhow::bail!(
            "d1 database {:?} `migrations_dir` {:?} escapes the project",
            binding.database_name,
            binding.migrations_dir
        );
    }
    if !dir.is_dir() {
        return Ok(None);
    }
    Ok(Some(dir))
}

/// The migration file names in an already-vetted directory, sorted as
/// wrangler applies them — a flat directory, ASCII case-insensitive `.sql`.
/// Every `*.sql` entry must be a regular file and never a symlink (a
/// symlinked, fifo, device or directory `*.sql` fails the deploy loudly
/// instead of reaching cello, which would follow the link and execute
/// out-of-tree SQL). Anything else in the directory is ignored.
pub fn collect_migration_files(dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("read {}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.len() >= 4 && name[name.len() - 4..].eq_ignore_ascii_case(".sql")) {
            continue;
        }
        // `DirEntry::file_type` traverses nothing: a symlink reports as one
        // even when its target is a regular file.
        let file_type = entry.file_type().with_context(|| format!("read {name}"))?;
        if file_type.is_symlink() {
            anyhow::bail!("refusing D1 migration {name}: is a symlink");
        }
        if !file_type.is_file() {
            anyhow::bail!("refusing D1 migration {name}: not a regular file");
        }
        names.push(name);
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_root(files: &[(&str, &str)]) -> crate::testutil::TempDir {
        let dir = crate::testutil::TempDir::new("noite-tenant-d1");
        for (rel, contents) in files {
            let path = dir.path().join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&path, contents).expect("write");
        }
        dir
    }

    #[test]
    fn no_config_means_no_bindings() {
        let dir = write_root(&[]);
        assert!(collect_d1_bindings(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn collects_defaults_and_declared_dirs() {
        let dir = write_root(&[(
            "wrangler.json",
            r#"{"name":"a","d1_databases":[{"binding":"DB","database_name":"demo"},{"binding":"B2","database_name":"other","migrations_dir":"db/migrations"}]}"#,
        )]);
        let bindings = collect_d1_bindings(dir.path()).unwrap();
        assert_eq!(
            bindings,
            vec![
                TenantD1Binding {
                    database_name: "demo".to_string(),
                    migrations_dir: "migrations".to_string(),
                    migrations_table: "d1_migrations".to_string(),
                },
                TenantD1Binding {
                    database_name: "other".to_string(),
                    migrations_dir: "db/migrations".to_string(),
                    migrations_table: "d1_migrations".to_string(),
                },
            ]
        );
    }

    #[test]
    fn invalid_bindings_fail_the_deploy() {
        for config in [
            r#"{"d1_databases":{}}"#,
            r#"{"d1_databases":[42]}"#,
            r#"{"d1_databases":[{"binding":"DB"}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":""}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"-evil"}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_dir":42}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_dir":""}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_dir":"../escape"}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_dir":"/absolute"}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_table":42}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_table":"has space"}]}"#,
            r#"{"d1_databases":[{"binding":"DB","database_name":"d","migrations_table":"9starts-digit"}]}"#,
        ] {
            let dir = write_root(&[("wrangler.json", config)]);
            assert!(
                collect_d1_bindings(dir.path()).is_err(),
                "accepted {config}"
            );
        }
    }

    #[test]
    fn missing_dir_is_nothing_to_apply() {
        let dir = write_root(&[("wrangler.json", r#"{"d1_databases":[]}"#)]);
        let binding = TenantD1Binding {
            database_name: "demo".to_string(),
            migrations_dir: "migrations".to_string(),
            migrations_table: "d1_migrations".to_string(),
        };
        assert!(resolve_migrations_dir(dir.path(), &binding)
            .unwrap()
            .is_none());
    }

    #[test]
    fn file_names_are_sorted_sql_only() {
        let dir = write_root(&[
            ("migrations/0002_second.sql", "x"),
            ("migrations/0001_first.SQL", "x"),
            ("migrations/notes.txt", "x"),
        ]);
        let resolved = resolve_migrations_dir(
            dir.path(),
            &TenantD1Binding {
                database_name: "demo".to_string(),
                migrations_dir: "migrations".to_string(),
                migrations_table: "d1_migrations".to_string(),
            },
        )
        .unwrap()
        .expect("migrations dir resolves");
        assert_eq!(
            collect_migration_files(&resolved).unwrap(),
            vec!["0001_first.SQL", "0002_second.sql"]
        );
    }

    #[test]
    fn symlinked_migrations_dir_is_refused() {
        use std::os::unix::fs::symlink;
        let outside = crate::testutil::TempDir::new("noite-tenant-d1-outside");
        std::fs::write(
            outside.path().join("evil.sql"),
            "CREATE TABLE t (id INTEGER);",
        )
        .unwrap();
        let dir = write_root(&[("wrangler.json", "{}")]);
        symlink(outside.path(), dir.path().join("migrations")).expect("symlink");
        let binding = TenantD1Binding {
            database_name: "demo".to_string(),
            migrations_dir: "migrations".to_string(),
            migrations_table: "d1_migrations".to_string(),
        };
        let err = resolve_migrations_dir(dir.path(), &binding)
            .unwrap_err()
            .to_string();
        assert!(err.contains("is a symlink"), "{err}");
    }

    #[test]
    fn symlinked_migration_file_is_refused() {
        use std::os::unix::fs::symlink;
        let dir = write_root(&[
            ("migrations/0001_init.sql", "CREATE TABLE t (id INTEGER);"),
            ("real.sql", "SELECT 1;"),
        ]);
        symlink(
            dir.path().join("real.sql"),
            dir.path().join("migrations/0002_link.sql"),
        )
        .expect("symlink");
        let resolved = resolve_migrations_dir(
            dir.path(),
            &TenantD1Binding {
                database_name: "demo".to_string(),
                migrations_dir: "migrations".to_string(),
                migrations_table: "d1_migrations".to_string(),
            },
        )
        .unwrap()
        .expect("migrations dir resolves");
        let err = collect_migration_files(&resolved).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{err}");
    }

    #[test]
    fn non_regular_migration_file_is_refused() {
        let dir = write_root(&[("wrangler.json", "{}")]);
        std::fs::create_dir_all(dir.path().join("migrations/0001_dir.sql")).expect("mkdir");
        let resolved = resolve_migrations_dir(
            dir.path(),
            &TenantD1Binding {
                database_name: "demo".to_string(),
                migrations_dir: "migrations".to_string(),
                migrations_table: "d1_migrations".to_string(),
            },
        )
        .unwrap()
        .expect("migrations dir resolves");
        let err = collect_migration_files(&resolved).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{err}");
    }
}
