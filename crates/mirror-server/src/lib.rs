//! Mirror server — port of `apps/server/`.

pub mod api_errors;
pub mod api_schemas;
pub mod auth;
pub mod chat_service;
pub mod conversation_sync;
pub mod conversion_routes;
pub mod deadlines;
pub mod egress;
pub mod preflight;
pub mod proxy_headers;
pub mod response_transform;
pub mod router;
pub mod security;
pub mod url_rewrite;

pub use api_errors::{api_error, recent_failures, record_failure};
pub use api_schemas::{
    AssetsQuery, BranchBody, ChatAttachment, ChatBody, ConversationIdParam, ConversationsQuery,
    ModelUpdateBody, NewConversationBody, SetSessionBody,
};
pub use auth::{get_valid_credentials, verify_candidate_session_token};
pub use chat_service::{RunChatOptions, RunChatOutcome, run_chat, stop_conversation, title_from_prompt};
pub use conversation_sync::{has_remote_history, sync_conversation_page};
pub use conversion_routes::conversion_routes;
pub use deadlines::{TurnDeadline, deadline_ms};
pub use router::{AppState, create_router};
