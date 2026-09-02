# Updated protocol snapshot

This bundle was assembled from the original `mirror-app.zip` PoC and overlays
the upgraded ChatGPT protocol implementation produced during the follow-up
review.

## Updated source files

- `packages/protocol/src/client.ts`
- `packages/protocol/src/sse.ts`
- `packages/protocol/src/types.ts`
- `packages/protocol/src/proof.ts`
- `packages/protocol/src/models.ts`

The server and web application have now been integrated with the upgraded protocol core.

## What the protocol overlay adds

- actual final assistant-node extraction for conversation continuity
- stateful `ChatGptConversationSession`
- `conversation/init` integration
- two-stage follow-up conduit preparation
- Custom GPT/gizmo request support in the protocol client
- structured SSE event preservation and normalization
- file/citation/image/tool event recognition
- file upload/download protocol primitives
- dynamic model normalization
- abort/cancellation plumbing
- cancellable worker-thread Sentinel proof-of-work

## Local validation performed when packaging

The protocol package was type-checked with TypeScript 5.8.3 using the DOM
library and tiny local declarations for external runtime-only modules
(`js-sha3`, `node:crypto`, and Node globals). This validates the upgraded
TypeScript source without requiring an internet-facing `npm install`.

The full workspace now installs, type-checks, tests and builds locally. The
production server serves the compiled web interface, and a credential-free
browser smoke test verifies the disconnected/account-connection state.

No HAR files, session tokens, cookies, access tokens, or other captured
credentials are included in this project. Automated tests use isolated
temporary storage and synthetic values only.
