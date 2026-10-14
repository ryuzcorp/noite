use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use thiserror::Error;

/// HTTP-facing runner errors. Internal causes use `{:#}` so clients see the
/// chain (celld stderr, aws rm, etc.) instead of a bare context label.
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }
    /// Authenticated, but the caller's app role does not allow this. The role
    /// is resolved by the control UI and re-checked here.
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::Forbidden(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::Conflict(msg.into())
    }
    pub fn too_large(msg: impl Into<String>) -> Self {
        Self::TooLarge(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
    pub fn from_anyhow(e: anyhow::Error) -> Self {
        Self::Internal(format!("{e:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.to_string()).into_response()
    }
}
