# API continuation regression — 2026-09-07

The user confirmed that ChatGPTBox was creating a new conversation on follow-up requests, while cm continued correctly. The investigation read all authored application source, tests, build/maintenance scripts, deployment configuration, and project documentation before reproducing or changing application behavior. Generated dependency metadata, vendored dependencies, build output, and private runtime data were excluded from source review.

## Reproduced failure

An isolated three-turn HTTP/protocol probe used the actual response text as the next request's assistant history. No production credentials, messages, or database were used.

| Input/response shape | Before: conversations after three turns | After |
| --- | --- | --- |
| Plain response | 1 | 1 |
| Response longer than `max_tokens` estimate | 3 | 1, full answers |
| Assistant preamble followed by another assistant message | 3 | 1, complete segments |

Before the fix, both failing cases omitted `conversation_id` in all three upstream sends and used `client-created-root` each time. After the fix, the second and third sends retained the first upstream ID and used `answer-1` and `answer-2` respectively as their parents.

## Cause and history

`openai.ts` saved a transcript fingerprint containing `result.text`, the final upstream assistant text. The HTTP response could differ: a response limiter cut it according to a character estimate or stop string, and its streaming offset incorrectly spanned separate assistant messages. A client resending the answer it received therefore supplied a different transcript from the one Mirror fingerprinted. Exact matching failed and the route created a new conversation.

The limiter also corrupted multi-message output: a preamble of `Searching now. ` followed by `Here is the complete answer 1` became `Searching now. plete answer 1`. The retained character offset removed the beginning of the next message.

Git places the limiter's introduction in `47ddb204003df4489fd6a0128a13bcf5f43fd912` (2026-09-07), with the older `result.text` fingerprint retained. The later `7d13162` Cowork completion commit retained these paths. The shared Git author identity does not prove which agent wrote individual changes. The mismatch between multi-message streamed output and final-text-only fingerprints also existed independently of truncation.

The inspected public ChatGPTBox source at `ab221d2fc17219ae64c479560865005c2b16a361` builds history from recorded questions/answers, concatenates response deltas, and sends a response-token field automatically (`src/services/apis/openai-compatible-core.mjs`). This supports the client interaction described above; it is not proof of the user's installed extension version or exact failed request. No private request capture was used.

Existing tests covered simple continuation and truncation separately. They did not close the loop from a processed HTTP answer to the next two requests. Executing every source branch is insufficient to establish that contract. The initial new matrix exposed 48 failing cases out of 81 before application changes.

## Repair

At the user's explicit request, the response limiter was removed entirely. `max_tokens`, `max_completion_tokens`, and `stop` remain accepted for client compatibility but are ignored. Mirror does not impose a token/character cap or stop-string truncation. Successful responses report `finish_reason: "stop"`.

Streaming now tracks snapshots per assistant message ID, forwards extensions without duplicating existing text, and separates new/replacement segments with a blank line. Already-transmitted bytes cannot be retracted, so replacement snapshots are appended intact. Captured upstream events remain available independently.

The saved logical API assistant row and transcript fingerprint now use the exact delivered response. Local/upstream IDs, parent tracking, status, events, and attachments remain intact. This makes reload and explicit full-history continuation agree with what the API caller received. JSON mode returns the final upstream assistant text; mixed-mode continuation is tested too.

## Mandatory build contract

The server package's `build` script runs `node --test tests/conversation-continuation.test.mjs` immediately after TypeScript compilation and before OpenAPI generation. The root build, root start, CI, and Docker image build invoke that server build. Failed assertions stop the command with a nonzero exit code.

The final matrix has 99 cases, each completing three turns:

- History matching, minimal explicit ID, and full-history explicit ID.
- JSON, SSE, and mixed transports over an actual loopback HTTP listener.
- Complete output despite token-limit and stop fields; split stop strings; multi-message output; replaced, repeated, and removed snapshots; empty answers and missing status.
- Stable local/upstream IDs, correct preceding assistant parent, one upstream send per turn, one local conversation and no unexpected branch, logical persisted history, matching fingerprint, and retained instructions.

Two deliberate mutations were applied only in disposable source copies:

| Mutation | Root build exit | Continuation assertions reporting a new conversation |
| --- | --- | --- |
| Omit the resolved conversation on explicit-ID continuation | 1 | 66 |
| Omit the resolved conversation on history-matched continuation | 1 | 33 |

Both builds failed at the mandatory continuation test step. The production source was not mutated for these negative checks.

## Validation and limits

- Final continuation contract: 99 passed, no skips.
- Unit/integration suite: 508 passed, one optional cm subprocess test skipped by its pre-existing platform gate.
- C8: 7,945/7,945 lines and statements; 271/271 functions; 2,068/2,068 branches. Every included source file passes all four metrics at 100%.
- Typecheck, production build, and all four Chromium browser tests passed.
- The same original three-case probe now retains one conversation in all cases and returns untruncated text.

Tests use synthetic upstream responses. They cannot guarantee compatibility with every future upstream or extension change. Existing histories that already diverged are not automatically merged or rewritten; the exact-history matcher still needs the client to resend matching history. A user-driven live ChatGPTBox retest is the remaining confirmation of the installed-client scenario.

The Compose `mirror` image was rebuilt successfully; its Docker build independently passed all 99 mandatory cases. Only the `mirror` service was recreated. The running service on `http://127.0.0.1:8787` returned HTTP 200 with `ok: true`, SQLite configured, and mandatory WARP verified. Inspection of deployed application code confirmed the limiter is absent and the delivered-transcript/per-message-streaming fix is present. No live ChatGPT generation was performed during this verification.

## Second cause found after the user reported the fix didn't resolve it (2026-09-07, later same day)

The fix above was real and necessary but not sufficient. The user reported ChatGPTBox was still creating a new conversation on every turn after this document's fix was applied. Re-investigation found a second, independent bug in the same file that produces the identical symptom through a different mechanism.

`sse()` in `openai.ts` enforced a slow-consumer guard: if `reply.raw.writableLength` (Node's outbound-buffer backlog for the hijacked raw response) exceeded 1MB at the moment of any single write, it called `reply.raw.destroy()` and threw, immediately severing the connection. This check ran on every SSE frame, including the heartbeat frames sent every 10s throughout generation, not just at the end of a turn.

The critical ordering problem: `saveOpenAiTranscript()` - which records the fingerprint the next turn's continuation match depends on - only runs *after* `runChat()` returns, i.e. after the full assistant turn has already streamed. If the guard fired at any point *during* streaming (heartbeat or content delta), the thrown error aborted the in-flight `withConversationLock` callback before it ever reached the transcript save. The outer catch block sees `reply.raw.destroyed === true` and returns early, so nothing gets persisted for that turn at all - not the corrected fingerprint from the fix above, no fingerprint at all. The next request then has nothing to match against and starts a new conversation, regardless of how correct the fingerprinted text is.

ChatGPTBox relays every SSE chunk through a Chrome extension `runtime.Port`, an extra hop with materially different latency/draining behavior than a normal socket read or the in-process test transport used by `conversation-continuation.test.mjs` (which is why that suite's 99/99 pass did not catch this - it never exercises a slow real consumer). A relayed, bursty consumer can plausibly cross 1MB of buffered backlog well before the far end has actually gone away, especially on a longer response, making this closer to routine than an edge case for that specific client.

### Repair

Replaced the byte-count snapshot check with a stall-duration check layered on a much higher-water mark: the guard now only fires if `writableLength` stays above 8MB *continuously* for more than 15 seconds (tracked per-response via a `WeakMap`, reset the moment the backlog drains back under the mark). A momentary burst - the expected case for a Port-relayed client - now writes through untouched instead of killing the connection. A connection that is actually gone (backlog never drains) is still torn down, just after a real stall window instead of on the first snapshot over an arbitrary count.

This is still not full drain-event-driven backpressure (pause production on `write()` returning `false`, resume on `'drain'`) - the call sites remain synchronous - but it removes the false-positive kill against a legitimately bursty relay, which is the mechanism that was actually breaking continuity in practice.

`sse()` gained an optional `now` parameter (defaults to `Date.now()`) solely so its unit tests can drive the stall clock deterministically without real timers or a real slow socket.

Validation: `apps/server/tests/conversation-continuation.test.mjs` still 99/99. Full suite (`npm run coverage`) 417 passed / 1 skipped (pre-existing platform-gated cm test), 100% lines/statements/functions/branches per file across every included source file. Typecheck and production build both clean.
