# Mirror: recommended next steps

This roadmap is based on a repository-wide review of the authored application
source, tests, scripts, deployment configuration, and documentation on
2026-09-12. Dependency metadata and generated integrity/OpenAPI artifacts were
checked as build outputs rather than treated as product design documents.

Mirror already has an unusually strong foundation for a private-protocol
integration: strict input schemas, a protocol package separated from product
code, encrypted credential storage, explicit local-only security boundaries,
conversation-continuation regression tests, and per-file 100% coverage gates.
The highest-value work is therefore not adding a long list of endpoints. It is
making the working behavior easier to verify against real clients, safer to
release and restore, and less expensive to change when ChatGPT's private
protocol moves.

## Recommended order

### 0. Restore a genuinely green clean-checkout baseline (completed 2026-09-12)

The two release blockers found by the audit are resolved:

- `npm test` and `npm run coverage` now build `apps/web` before server route
  tests, so they do not rely on an ignored `apps/web/dist` left by an earlier
  command. An isolated copy with every `dist` directory omitted passed all 529
  tests.
- Behavioral fixtures cover the previously missed inline-widget, citation
  patch, and citation-container branches in `rich-output.ts` and
  `packages/protocol/src/sse.ts`. The unchanged per-file C8 gate reports 100%
  statements, branches, functions, and lines for every executable TypeScript
  source file.

The App test that exercises synchronous re-entrant keyboard input now contains
its state changes inside React `act(...)`; the successful unit and coverage
runs emit no React test warnings.

**Definition of done:** on a fresh checkout after `npm ci`, the exact CI sequence
runs successfully without relying on ignored `dist` directories and without
test-runner warnings that are under the project's control.

### 1. Make releases reproducible and recoverable (P0)

Complete MIR-05, MIR-06, and MIR-18 together as one release-readiness project.

**Progress (2026-09-12):** the numbered transactional baseline migration,
schema diagnostics, two-key-mode offline restore drill, container revision
plumbing, runtime maintenance scripts, and [recovery runbook](RELEASE-RECOVERY.md)
are implemented. The remaining release work is artifact publishing and
digest/version recording, plus real-volume and authenticated live acceptance.
The bullets below describe the full acceptance target.

- Add a release workflow that produces a versioned, digest-pinned container,
  injects `MIRROR_BUILD_REVISION`, publishes the generated OpenAPI document and
  SHA256 manifest, and records the exact Node and dependency-lock revisions.
- Replace the current ad-hoc column-existence migrations with numbered,
  transactional schema migrations and a stored schema version. Document the
  oldest database version supported by each release.
- Automate an **offline** backup -> isolated restore -> integrity check drill for
  both generated `master.key` and supplied `MIRROR_STORE_KEY` configurations.
  Keep the live-account continuation check as a separately approved manual
  release gate; never put a session credential in CI.
- Publish a rollback runbook. A rollback should start with a known-good backup,
  state whether the previous binary can read the upgraded schema, and include
  WARP, session, model-discovery, and one real continuation checks.

**Why first:** storage upgrades now have a transactional version contract, but
the package version is still `0.1.0` and build revision remains optional for local
development. A published artifact still needs to identify its tested source,
dependencies, image digest, and migration contract.

**Definition of done:** a clean machine can install a tagged artifact, restore a
fixture backup without touching the source database, verify/decrypt it, upgrade
it, and follow the documented rollback decision tree. CI records artifact
digests and all required checks against the tagged commit.

### 2. Turn client compatibility into an executable contract (P0)

Finish MIR-01 and MIR-19 before expanding the API surface.

- Write a versioned client contract for headers, CORS, conversation-ID delivery,
  SSE/Responses lifecycle events, heartbeats, cancellation, and the distinction
  between a successful empty answer and a truncated/failed stream.
- Move contract fixtures into a small reusable package or fixture directory that
  both Mirror and `cm` can consume. Test minimal-history and full-history clients
  against the same cases.
- Add real loopback-socket tests for disconnect and backpressure. The present
  slow-consumer logic is deterministically unit-tested, but it writes
  synchronously and does not honor `write()`/`drain`; an integration harness can
  deliberately pause its TCP reader without relying on timing luck.
- Add a pinned ChatGPTBox source-renderer lane, plus a short manual checklist
  that records extension version, provider settings, stream/non-stream mode,
  model discovery, errors, and three-turn continuation. Keep the manual result
  clearly separate from synthetic CI evidence.

**Definition of done:** Mirror and `cm` run the same success/error/continuation
fixtures; a paused real socket cannot lose the transcript or deadlock the
conversation lock; a disconnected socket aborts coherently; and a recorded,
versioned ChatGPTBox check can be repeated by someone other than the author.

### 3. Build an explicit private-protocol drift boundary (P1)

The synthetic protocol suite is broad, but upstream compatibility remains the
project's existential risk.

- Add a schema-tolerant, sanitized capture/replay format with fixture provenance
  (capture date, endpoint, account capabilities, sanitization version, and
  expected normalized events). Never store credentials, prompts, signed URLs,
  account identifiers, or raw personal payloads.
- Classify failures as authentication/challenge, transport truncation, known
  upstream error, or unsupported protocol shape. Surface the classification in
  diagnostics without exposing the payload.
- Add an opt-in live canary command that performs read-only session/model checks
  by default and requires an explicit flag for a disposable generation. It
  should emit a sanitized report suitable for attaching to an issue.
- Document how to refresh the browser identity constants and protocol fixtures,
  instead of letting hard-coded user-agent/client-context values age silently.

**Definition of done:** a protocol change produces an actionable, sanitized
failure category and a replayable fixture, not merely a generic 502 or a hurried
production patch.

### 4. Reduce the cost of changing core behavior (P1)

Continue MIR-12 incrementally; do not rewrite working code.

- Split `openai.ts` into request schemas/adapters, conversation resolution,
  transport writers, and route registration. Remove the current type-only
  dependency back from `conversation-context.ts` into the route module.
- Split `store.ts` into schema/migrations, credentials, conversations/messages,
  transcript matching, and maintenance repositories, behind a small database
  interface. This will also make isolated migration and corruption tests easier.
- Split `index.ts` route groups into plugins and break `App.tsx` into mode,
  transcript editor, conversation browser, and request-runner components.
- Generate all possible OpenAPI operations from the runtime route schemas, and
  add a check that every documented route exists and every registered public
  route is documented. Keep hand-written prose descriptions, but not duplicate
  request shapes.

**Definition of done:** no orchestration/UI module is a catch-all, imports point
in one direction, and behavior remains pinned by the current regression suite at
each extraction step.

### 5. Improve operability without collecting sensitive data (P1)

- Add structured local logs with request ID, route, duration, outcome category,
  conversation operation (new/continue/rebase), upstream phase, and deadline
  phase. Explicitly prohibit prompts, tokens, cookies, attachment URLs, and raw
  upstream bodies.
- Extend diagnostics with schema version, actual build revision, process uptime,
  last successful WARP/session/model checks, and counters for failure categories.
  Keep bounded retention and a one-click sanitized export.
- Add startup preflight output that distinguishes configuration errors, database
  migration failures, missing browser dependencies, WARP failure, and session
  expiry, each with one concrete next action.

This makes private-protocol regressions supportable without introducing remote
telemetry or weakening Mirror's local-only posture.

### 6. Then invest in user-facing features (P2)

After the trust/release work above, the best product improvements are:

1. **Conversation workspace:** search highlighting, branch-tree keyboard
   navigation, branch labels, and a clear preview of the exact node that the next
   turn will continue from.
2. **Portable archives:** validate exported JSON against a published archive
   schema and add read-only import. Imported archives must remain visibly
   non-resumable unless a valid upstream identity is independently established.
3. **Rich output inspector:** friendly tool/citation/file cards by default with
   an opt-in sanitized event inspector. Never show internal analysis content.
4. **Responses conveniences:** consider `previous_response_id` only after its
   persistence and expiry semantics are specified; do not imply official API
   parity merely because the wire shape can be emulated.
5. **Accessibility evidence:** run a real keyboard and screen-reader audit at
   narrow and wide viewports, add automated axe-style checks, and test long live
   streams rather than only mocked browser responses.

## Work to avoid for now

- **Remote or multi-user deployment.** It needs a new threat model, TLS, durable
  identity/authorization, CSRF protection, per-user storage isolation, quotas,
  and a security review. An allowed-host escape hatch is not that design.
- **Pretend API parity.** Do not emulate unsupported sampling, token usage,
  caller-defined tools, or constrained decoding with guesses.
- **Automatic retries of generation POSTs.** An ambiguous upstream completion
  can duplicate or branch a turn; reload and reconcile instead.
- **A broad UI rewrite.** Current tests protect many subtle continuation and
  persistence behaviors. Small extractions retain that leverage.
- **More raw protocol exposure.** Normalize and sanitize new events before making
  them a public client contract.

## Suggested first three pull requests

1. **Release metadata and numbered migrations:** wire revision/version into the
   image and diagnostics, add transactional migration infrastructure, and write
   upgrade/rollback tests.
2. **Streaming contract and socket harness:** publish the contract, share its
   fixtures with `cm`, and replace the synchronous slow-consumer guard with
   drain-aware writing proven over a paused loopback socket.
3. **Restore drill and release runbook:** automate isolated restores for both key
   modes, document Compose volume handling, and make the drill a release gate.

These three changes improve confidence in every later feature while directly
closing the oldest open verification and release items in `TODO.md`.
