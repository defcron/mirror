# backend-api protocol notes

Mined from real captured chatgpt.com browser traffic (redacted analysis — no
tokens/cookies were ever inspected as literal values, only endpoint paths,
header names, and JSON shapes). This is the ground truth `packages/protocol`
was built from.

## Full endpoint surface observed (all under `/backend-api/`)

GET: accounts/check/v4-2023-04-27, accounts/optimized/check, aip/first-party/eligibility, amphora/notifications, apps/sources_dropdown, beacons/home, calpico/chatgpt/rooms/summary, celsius/ws/user, checkout_pricing_config/configs/{cc}, client/strings, composer/items, conversation/{id}/stream_status, conversation/{id}/textdocs, conversations, estuary/content, estuary/public_content/enc/{...}, gizmos/bootstrap, gizmos/{gizmo_id}[/conversations], gizmos/snorlax/sidebar, hazelnuts, images/bootstrap, me, models, models/gpts, pageConfigs/billing, pins, prompt_library/, sentinel/frame.html, sentinel/sdk.js, settings/is_adult, settings/user, settings/voices, subscriptions, system_hints, tasks, tpp/models/, user_granular_consent, user_surveys/active, user_system_messages

POST: accounts/backfill_workspace_owner_domains, aip/connectors/links/list_accessible, composer/items/interactions, conversation/init, f/conversation, f/conversation/prepare, lat/r, sentinel/chat-requirements/finalize, sentinel/chat-requirements/prepare, sentinel/heartbeat, sentinel/ping, sentinel/req

The implementation uses `conversation/init`, the two-stage `f/conversation/prepare` conduit flow, `f/conversation`, the `sentinel/*` family, live models, gizmo discovery/retrieval, and file create/upload/download routes.

## Common request headers (every backend-api call)

`accept`, `accept-encoding`, `accept-language`, `authorization` (Bearer accessToken), `content-type`, `cookie` (unclear yet whether required alongside bearer), `dnt`, `oai-client-build-number`, `oai-client-version`, `oai-device-id` (client-generated UUID, persisted), `oai-language`, `oai-session-id`, `origin`, `referer`, `sec-ch-ua*`, `sec-fetch-*`, `user-agent`, `x-oai-is-client-observation`, `x-openai-target-path`, `x-openai-target-route`. Chat calls also add `chatgpt-account-id`.

## Conversation flow

1. **POST /backend-api/conversation/init** — `{requested_default_model, conversation_id: null, timezone, timezone_offset_min, conversation_origin: null}` (+ `gizmo_id` for custom GPTs). Returns `default_model_slug`, `limits_progress`, `blocked_features`.
2. **POST /backend-api/f/conversation/prepare** — debounced pre-flight. Returns `{status:"ok", conduit_token}`.
3. **Sentinel proof-of-work / turnstile gate**:
   - `POST sentinel/chat-requirements/prepare` → `{persona, prepare_token, turnstile:{required,dx}, proofofwork:{required,seed,difficulty}, so:{...}}`
   - Solve proof-of-work (SHA3-512 hashcash — see `packages/protocol/src/proof.ts`, ported from a tested reference implementation).
   - **Turnstile resolution**: When required, Mirror resolves Turnstile tokens automatically via an in-memory TTL cache, stored session credentials, environment variables (`CHATGPT_TURNSTILE_TOKEN` / `MIRROR_TURNSTILE_TOKEN`), live proxy request capture, or the automated headless browser solver (`solveTurnstileWithBrowser` in `@mirror/protocol`). When no token is needed or available, Mirror falls back to `turnstile: null` so unconstrained sessions continue to function seamlessly.
   - `POST sentinel/chat-requirements/finalize` → `{persona, token, expire_after, expire_at}`. `token` becomes `openai-sentinel-chat-requirements-token`.
4. **POST /backend-api/f/conversation** — the actual send. Extra headers: `chatgpt-account-id`, `oai-echo-logs`, `oai-genui-client-actions`, `oai-telemetry`, `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`, `openai-sentinel-turnstile-token`, `x-oai-turn-trace-id`.

   The final conduit token is sent as `x-conduit-token`. Compatibility failures from the prepare endpoint fall back one stage (or to no conduit); authentication and rate-limit failures remain fatal.

   **Response is SSE.** First line is literally `"v1"`. Then JSON-patch-style events `{p, o, v, c}`.

   **The critical gotcha**: subsequent events routinely omit `p`/`o` — just `{"v": "..."}` — meaning "reuse the previous event's path and op". A client that assumes every event is self-describing will silently drop most of the streamed text. `packages/protocol/src/sse.ts`'s `ConversationStreamReducer` tracks this state correctly. There's also a batch form: `{"p":"","o":"patch","v":[{...},{...}]}`. Non-patch typed events (`resume_conversation_token`, `input_message`, `title_generation`, `message_marker`) are interleaved and should be ignored by the text-rendering path. Ends with `data: [DONE]`.

## Model slugs observed live

`gpt-5-6-thinking`, `gpt-5-6`, `gpt-5-3` — fetch live from `GET /backend-api/models` rather than hardcoding; these are account/plan-dependent.

## Compatibility boundaries

- Bearer-only vs. bearer+cookie requirement (affects the paste-your-token-only auth UX).
- Turnstile solving strategy (automated via cache, session, env, proxy capture, and headless browser challenge).
- Exact typed event envelopes continue to evolve. Mirror preserves raw normalized events internally and derives stable text/tool/citation/image views.
- Unknown OpenAI-compatible histories cannot reconstruct a pre-existing ChatGPT tree. A new Mirror conversation supplies the received history as explicit text context; subsequent calls can resume through an explicit `metadata.conversation_id` or a matching stored transcript fingerprint. Work Mode aliases are rejected rather than remapped.
