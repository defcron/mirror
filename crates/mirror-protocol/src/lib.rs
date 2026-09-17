//! Port of `packages/protocol/` — the ChatGPT wire-protocol client.
//! See the migration plan for remaining modules.

pub mod proof;

pub use proof::{
    DEFAULT_MAX_ATTEMPTS, GenerateProofOptions, ProofConfig, ProofError, decode_proof_config,
    generate_proof_token,
};
