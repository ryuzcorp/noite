//! Runner REST surface: thin handlers grouped by domain; the route table
//! lives in `api::router`, which addresses every handler through the
//! re-exports below.
//!
//! Where handlers live: edge handlers (`host/edge.rs`: `edge_fallback`,
//! `tls_ask`, `wake`) and git smart-HTTP handlers (`host/git_http.rs`)
//! deliberately live with their host subsystem; everything else lives in
//! `api/`.
pub mod admin;
pub mod apps;
pub mod deploys;
pub mod domains;
pub mod env;
pub mod errors;
pub mod events;
pub mod git;
pub mod observe;
pub mod prs;
pub mod rpc;
pub mod router;
pub mod source;
pub mod sse;
pub mod storage;
pub mod telemetry;

#[cfg(test)]
mod tests;

pub use admin::{snapshot, stats};
pub use apps::{
    create_app, delete_app, get_app, health, list_apps, patch_app, ready, rename_app, retry_import,
    sleep_app,
};
pub use deploys::{deploy_log, list_deploys, list_deploys_stream, rollback};
pub use domains::{add_domain, list_domains, remove_domain};
pub use env::{delete_env, list_env, set_env};
pub use errors::list_errors_stream;
pub use events::{
    get_user_props, identify_user, list_channels, list_events, list_events_stream, list_insights,
    log_event, set_insight,
};
pub use git::{
    git_branch_create, git_branch_delete, git_commit, git_compare, git_log, git_refs, git_remote,
};
pub use observe::{
    app_devices, app_logs, app_logs_stream, app_metrics, app_metrics_version, app_paths, app_refs,
    app_spans,
};
pub use prs::{
    add_comment, add_review, create_pr, delete_comment, edit_comment, get_branch_rules, get_pr,
    list_prs, merge_pr, set_branch_rules, update_pr,
};
pub use rpc::handle_rpc;
pub use source::{app_source_commit, source_blob, source_bundle, source_tree, source_types};
pub use storage::{
    app_d1_delete_rows, app_d1_rows, app_d1_schema, app_d1_tables, app_d1_write, app_do, app_r2,
    app_r2_delete, app_r2_object, app_r2_put, app_r2_raw, app_storage,
};
pub use telemetry::{get_telemetry, set_telemetry};
