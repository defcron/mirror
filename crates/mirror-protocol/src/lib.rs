//! Port of `packages/protocol/` — the ChatGPT wire-protocol client.
//! See the migration plan for remaining modules.

pub mod events;
pub mod patch;
pub mod proof;
pub mod scan;
pub mod sse;

pub use events::NormalizedConversationEvent;
pub use patch::{PatchOutcome, apply_message_patch};
pub use proof::{
    DEFAULT_MAX_ATTEMPTS, GenerateProofOptions, ProofConfig, ProofError, decode_proof_config,
    generate_proof_token,
};
pub use scan::{author_name_of, message_text, role_of, scan_specials};
pub use sse::{
    Inherited, PatchEvent, SseFrameDecoder, StreamEvent, iter_sse_data_lines, parse_sse_event,
};
