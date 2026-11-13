//! Service layer: the one implementation behind the runner's HTTP surface.
//!
//! REST handlers (`crate::api::*`) decode path/query/body, call a service
//! function and encode the result (`ApiError` becomes the HTTP status and a
//! plain-text message). Nothing here knows about axum extractors, and nothing
//! in `crate::api` is imported from here.

pub mod apps;
pub mod deploys;
pub(crate) mod detached;
pub mod domains;
pub mod env;
pub mod env_gate;
pub mod environments;
pub mod errors;
pub mod events;
pub mod git;
pub mod limits;
pub mod observe;
pub mod prs;
pub mod source;
pub mod storage;
pub mod telemetry;
pub mod update_check;

#[cfg(test)]
mod queue_tests;
