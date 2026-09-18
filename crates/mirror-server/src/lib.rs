//! Mirror server — port of `apps/server/`.

pub mod api_errors;
pub mod api_schemas;
pub mod auth;
pub mod browser_patch;
pub mod chat_service;
pub mod conversation_context;
pub mod conversation_sync;
pub mod conversion_routes;
pub mod deadlines;
pub mod egress;
pub mod mirror_controls;
pub mod preflight;
pub mod proxy;
pub mod proxy_headers;
pub mod response_transform;
pub mod router;
pub mod security;
pub mod upload_mime;
pub mod url_rewrite;

pub use api_errors::{api_error, recent_failures, record_failure};
pub use api_schemas::{
    AssetsQuery, BranchBody, ChatAttachment, ChatBody, ConversationIdParam, ConversationsQuery,
    ModelUpdateBody, NewConversationBody, SetSessionBody,
};
pub use auth::{get_valid_credentials, verify_candidate_session_token};
pub use browser_patch::EARLY_PATCH;
pub use chat_service::{
    RunChatOptions, RunChatOutcome, run_chat, stop_conversation, title_from_prompt,
};
pub use conversation_context::{
    first_history_difference, is_public_image_host, prompt_for, route_model, text_content,
};
pub use conversation_sync::{has_remote_history, sync_conversation_page};
pub use conversion_routes::conversion_routes;
pub use deadlines::{TurnDeadline, deadline_ms};
pub use proxy::proxy_chatgpt;
pub use router::{AppState, create_router};
pub use upload_mime::upload_mime_type;
