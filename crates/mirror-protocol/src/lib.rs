//! Port of `packages/protocol/` — the ChatGPT wire-protocol client.

pub mod client;
pub mod drift;
pub mod events;
pub mod http;
pub mod models;
pub mod patch;
pub mod proof;
pub mod reducer;
pub mod scan;
pub mod session;
pub mod sse;
pub mod turnstile;
pub mod types;

pub use client::{ChatGptBackendClient, ChatGptConversationSession, SendMessageOptions};
pub use drift::{
    ClassifiedDrift, ProtocolDriftCategory, classify_protocol_failure,
    classify_protocol_failure_parts,
};
pub use events::NormalizedConversationEvent;
pub use models::{normalize_gizmos, normalize_models};
pub use patch::{PatchOutcome, apply_message_patch};
pub use proof::{
    DEFAULT_MAX_ATTEMPTS, GenerateProofOptions, ProofConfig, ProofError, decode_proof_config,
    generate_proof_token,
};
pub use reducer::{ConversationStreamReducer, ReducerOptions};
pub use scan::{author_name_of, message_text, role_of, scan_specials};
pub use session::{MintedAccessToken, SessionError, mint_access_token};
pub use sse::{
    Inherited, PatchEvent, SseFrameDecoder, StreamEvent, iter_sse_data_lines, parse_sse_event,
};
pub use turnstile::{
    BrowserTurnstileOptions, ResolveTurnstileOptions, TurnstileChallenge,
    decode_turnstile_config, resolve_turnstile_token, solve_turnstile_with_browser,
};
pub use types::{
    BackendApiError, ConversationInitResult, ConversationSessionState, GizmoSummary,
    ModelDescriptor, RemoteConversationSummary, SendMessageResult, SessionCredentials,
    UploadedFile, UseCase,
};
