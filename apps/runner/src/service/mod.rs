//! Service layer: the one implementation behind both transports.
//!
//! REST handlers (`crate::api::*`) decode path/query/body, call a service
//! function and encode the result; the JSON-RPC dispatcher (`crate::api::rpc`)
//! decodes params, calls the *same* function and maps `ApiError` onto a
//! JSON-RPC error. Nothing here knows about axum extractors or JSON-RPC, and
//! nothing in `crate::api` is imported from here — the two transports stay
//! peers over this layer instead of one re-implementing the other.

pub mod apps;
pub mod deploys;
pub mod domains;
pub mod env;
pub mod errors;
pub mod events;
pub mod git;
pub mod limits;
pub mod observe;
pub mod source;
pub mod storage;
pub mod telemetry;
