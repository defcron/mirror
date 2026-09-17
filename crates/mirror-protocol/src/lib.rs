//! Port of `packages/protocol/` — the ChatGPT wire-protocol client.
//! See the migration plan for remaining modules.

pub mod proof;
pub mod sse;

pub use proof::{
    DEFAULT_MAX_ATTEMPTS, GenerateProofOptions, ProofConfig, ProofError, decode_proof_config,
    generate_proof_token,
};
pub use sse::{
    Inherited, PatchEvent, SseFrameDecoder, StreamEvent, iter_sse_data_lines, parse_sse_event,
};
