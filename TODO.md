# Mirror TODO

Reviewed 2026-09-07 against the current source, tests, configuration, and compatibility notes. **Confirmed** identifies an observable implementation/documentation gap; **Verify** calls for investigation or expanded proof, not an assumed bug; **Enhancement** is optional product work. Effort: S = focused change, M = several related changes, L = broader design/integration work. Check items off only with the relevant evidence.

Keep mandatory WARP egress, local deployment boundaries, assistant-message immutability, and real upstream conversation-node continuity. Preserve the separation between protocol handling, server/storage, and the Playground. See [COMPATIBILITY.md](COMPATIBILITY.md) for supported behavior and limitations.

## P1 — Protect the working integrations

- [ ] **MIR-01 · Verify · M — Extend the client compatibility suite.** Existing route tests cover the recent CORS and key-alias fixes. Add reproducible end-to-end cases for cm, a browser fetch client, and the ChatGPTBox integration: preflight, model discovery, streamed/non-streamed success, error streams, exposed conversation ID, and continuation. Record extension version/settings with user-driven live checks; do not put credentials in fixtures. Include blank environment values as supplied by Compose.
- [ ] **MIR-02 · Verify · M — Audit continuation with minimal versus full history.** cm sends only the latest user turn while Playground resends history. Test alternating those clients on a seeded conversation, including system instructions, failed prior turns, and restart/reload. In `apps/server/src/openai.ts`, verify that transcript hashes and saved instructions remain consistent when the request omits prior history. Acceptance: no accidental reset, instruction loss, assistant edit, or fabricated flattened history.
- [ ] **MIR-03 · Verify · M — Standardize useful, safe error responses.** Global failures currently use a string `error`, while `/v1` handlers use structured errors; stream errors have a separate path. Define consistent `/v1` error type/code/message/request-ID behavior for auth, validation, rate limits, upstream failures, and interrupted streams. Keep internal stacks and credentials out of responses; test errors before and after headers are flushed.
- [ ] **MIR-04 · Verify · M — Exercise deadlines and cancellation under failure.** Cancellation is already wired; add bounded connection/idle deadlines where needed and test hung upstream calls, slow consumers, disconnects, and queued same-conversation requests. Ensure locks release and local partial/error rows remain coherent. Never blindly retry completion POSTs after an ambiguous failure.
- [ ] **MIR-05 · Verify · M — Finish release integration for the current working tree.** There are substantial existing tracked and untracked changes. Review them as coherent changes, run the established typecheck/coverage/build/browser/manifest CI sequence, and record the tested revision before publishing a release. Preserve unrelated work; do not treat a container rebuild as proof that GitHub/CI has the same code.

## P2 — Recovery, configuration, and maintainability

- [ ] **MIR-06 · Enhancement · M — Perform and document a Docker restore drill.** Backup/restore/prune tooling already exists in `scripts/storage.mjs`. Test backup → isolated restore → decrypt session data → load history → continue a test conversation, covering generated master keys and `MIRROR_STORE_KEY`. Document mounted-volume paths and offline requirements. Never test a restore over the working database.
- [ ] **MIR-07 · Enhancement · M — Make maintenance previewable.** Add a dry-run/report for pruning, explicit retention rules, and a summary of affected conversations/events/files before destructive work. Verify which tables and assets existing pruning actually removes before promising storage savings.
- [ ] **MIR-08 · Confirmed · S — Consolidate configuration and client setup docs.** Put `OPENAI_API_KEY` in the README configuration table, integrate the appended alias explanation, and document ChatGPTBox settings plus `/v1` versus server-root base URLs. Explain that cross-origin `/v1` access requires a bearer key while browser control routes remain origin-restricted. Distinguish Compose's default host port from direct-server ports and locally overridden ports.
- [ ] **MIR-09 · Enhancement · M — Add a safe diagnostics view/export.** Display build version, API reachability, storage health, WARP status, session readiness, and recent categorized failures. Export only allowlisted diagnostic fields; omit prompts, credentials, signed URLs, and raw upstream payloads. Make common failure messages point to the next useful action.
- [ ] **MIR-10 · Verify · M — Expand sanitized protocol regression fixtures.** Protocol parsing already has tests. Add fixtures for newly observed variants, fragmented streams, tool/image events, and interrupted turns, keeping fixtures synthetic or carefully sanitized. Detect drift with clear unsupported-response errors. Treat authentication challenges as an explicit compatibility failure requiring user action, not a bypass feature.
- [ ] **MIR-11 · Enhancement · M — Keep compatibility claims precise.** Review absolute “impossible” claims and “not supported yet” language in `COMPATIBILITY.md`/README against actual implementation evidence; distinguish unsupported, approximate, unverified, and intentionally out of scope. Re-check current primary documentation when making external API claims. Do not promise tool calling, exact usage, or constrained decoding that Mirror cannot deliver.
- [ ] **MIR-12 · Enhancement · M — Refactor large route/UI modules incrementally.** Separate configuration/auth hooks, API error formatting, and conversation orchestration from the large `index.ts`/`openai.ts` modules, and split Playground concerns where useful. Keep behavior unchanged and use the existing regression suite as a guard; avoid a wholesale rewrite.

## P3 — Optional super-awesomer features

- [ ] **MIR-13 · Enhancement · M — Better connection onboarding.** Add a connection-test flow and copyable client setup snippets with placeholder keys. Distinguish saved session, usable API key, healthy WARP, and successful test generation; do not display “connected” based only on a saved setting.
- [ ] **MIR-14 · Enhancement · L — A clear conversation branch viewer.** Show user-edit branches, selected parents, and continuation state; keep assistants selectable/copyable and read-only. First prove branch selection → reload → next-turn identity before adding visual polish.
- [ ] **MIR-15 · Enhancement · M — Search and portable conversation export.** Add local history search and Markdown/JSON exports, with an explicit choice about including attachments and metadata. If import is later added, distinguish an archived transcript from a genuinely resumable upstream thread.
- [ ] **MIR-16 · Enhancement · M — Improve Playground accessibility and feedback.** Audit keyboard navigation, focus after edits, screen-reader announcements, contrast, small screens, and long streaming outputs. Present citations, generated images, and tool status without exposing noisy raw protocol data by default.
- [ ] **MIR-17 · Enhancement · M — Client-facing capability discovery.** Expose a small versioned capability summary derived from supported routes/schema: supported fields, approximations, conversation tracking, and unsupported features. Let clients explain mismatches before sending a doomed request.
- [ ] **MIR-18 · Enhancement · M — Reproducible release and rollback artifacts.** Publish version/build metadata, tested container identifiers, migration notes, and a rollback procedure that accounts for database schema compatibility. Retain a known-good backup before upgrades; validate WARP and one real continuation after rollout.

## Shared work with cm

- [ ] **MIR-19 · Verify · M — Define the shared streaming and persistence contract.** Document success/error/end-of-stream semantics, header versus SSE-comment conversation IDs, and cancellation/ambiguous-completion handling. Coordinate with CM-01/02/16 in cm's TODO. A failed or truncated response must not appear as successful empty text to a client.

## Completed in this task — preserve, do not reimplement

- Empty/whitespace `MIRROR_WEB_ORIGIN` no longer causes Fastify CORS HTTP 500s.
- Cross-origin bearer-authenticated model/completion requests, preflight, and streaming CORS headers work; control-route origin protection remains.
- Server-side `OPENAI_API_KEY` is accepted alongside Mirror key settings and forwarded by Compose.
- Live cm streaming and same-ID non-streaming continuation passed; the user confirmed ChatGPTBox works.
- Existing assets include generated OpenAPI docs, coverage/browser CI, storage maintenance tools, and conversation-edit tests. Extend these rather than creating duplicate systems.

Suggested order: MIR-01/02/03, then release integration and the recovery drill, then diagnostics and the most useful Playground improvements. Optional product ideas need their own scoped implementation decisions.
