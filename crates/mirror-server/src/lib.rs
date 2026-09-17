//! Mirror server — port of `apps/server/` in progress.

pub mod api_errors;
pub mod api_schemas;
pub mod auth;
pub mod deadlines;
pub mod egress;
pub mod preflight;
pub mod proxy_headers;
pub mod response_transform;
pub mod security;
pub mod url_rewrite;

pub use api_errors::{api_error, recent_failures, record_failure};
pub use api_schemas::{
    AssetsQuery, BranchBody, ChatAttachment, ChatBody, ConversationIdParam, ConversationsQuery,
    ModelUpdateBody, NewConversationBody, SetSessionBody,
};
pub use auth::{get_valid_credentials, verify_candidate_session_token};
pub use deadlines::{TurnDeadline, deadline_ms};
