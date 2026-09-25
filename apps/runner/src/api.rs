//! Runner REST surface: thin handlers grouped by domain; routes live in
//! `main.rs`, which keeps addressing `api::X` through the re-exports below.
pub mod admin;
pub mod apps;
pub mod deploys;
pub mod domains;
pub mod env;
pub mod events;
pub mod git;
pub mod observe;
pub mod rpc;
pub mod source;
pub mod storage;

pub use admin::snapshot;
pub use apps::{
    create_app, delete_app, get_app, health, list_apps, patch_app, ready, rename_app,
};
pub use deploys::{list_deploys, list_deploys_stream, rollback};
pub use domains::{add_domain, list_domains, remove_domain};
pub use env::{delete_env, list_env, set_env};
pub use events::{get_user_props, identify_user, list_channels, list_events, list_events_stream, list_insights, log_event, set_insight};
pub use git::{git_remote, webhook};
pub use observe::{app_devices, app_logs, app_logs_stream, app_metrics, app_paths, app_refs, app_spans};
pub use rpc::handle_rpc;
pub use source::{app_source_commit, source_blob, source_diff, source_tree};
pub use storage::{
    app_d1, app_d1_write, app_do, app_r2, app_r2_delete, app_r2_object, app_r2_raw, app_storage,
};
