//! Push-driven tip channel (T2.2): the Git smart-HTTP adapter and web
//! commits already know when `main` moves, so they notify the reconcile loop
//! directly instead of making it poll S3. `head_main_bundle` stays as the
//! fallback sweep for bundles written behind the runner's back.
use crate::host::cmd::TipBundle;

/// One moved tip: which app, and the bundle key + sha the push wrote.
#[derive(Debug, Clone)]
pub struct TipNotify {
    pub app_id: String,
    pub tip: TipBundle,
}

pub type TipSender = tokio::sync::mpsc::UnboundedSender<TipNotify>;
pub type TipReceiver = tokio::sync::mpsc::UnboundedReceiver<TipNotify>;

pub fn channel() -> (TipSender, TipReceiver) {
    tokio::sync::mpsc::unbounded_channel()
}
