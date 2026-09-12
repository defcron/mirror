# API compatibility: Mirror vs. the official OpenAI API

Mirror's `/v1/chat/completions` and `/v1/models` speak OpenAI's wire format, but underneath they run on `chatgpt.com/backend-api` — the private protocol behind the ChatGPT web app, not the officially documented OpenAI API. Those two APIs were built for different purposes (one is a product backend for a specific first-party client, the other is a general-purpose developer API), so some gaps aren't bugs to fix — they're places where the two surfaces fundamentally don't line up. This document enumerates every point of divergence found so far, in both directions, and says which ones are permanent versus which are just not implemented yet.

See [PROTOCOL.md](./PROTOCOL.md) for the underlying backend-api mechanics referenced throughout. For a machine-readable version of the `/v1` request/response shapes described here, `GET /mirror/openapi` (add `?format=yaml` for YAML) serves an OpenAPI 3.1 document generated straight from the same Zod schemas the server validates against - see `apps/server/src/openapi-document.ts` - and `/mirror/api-docs` serves a Swagger UI for browsing and trying it live.

## Part 1: Official OpenAI API features Mirror can't (fully) offer

### Structurally impossible — no equivalent exists in backend-api

**Sampling controls** (`temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `seed`). ChatGPT's web client never exposes these to the account holder, and `f/conversation` has no request field for them. There's no dial to turn — the model runs with whatever sampling ChatGPT's product team configured server-side for that model slug, and it can change without notice.

**Deterministic output / `seed`.** Same root cause: no seed parameter exists upstream, and ChatGPT's own infra doesn't guarantee reproducible sampling even session-to-session.

**`logprobs` / `top_logprobs`.** The SSE stream backend-api sends is rendering-oriented (assistant text deltas, tool/citation/image events) — it has never carried per-token probabilities, because the ChatGPT UI has no use for them.

**`n` > 1 (multiple choices per request).** A ChatGPT conversation turn produces exactly one assistant message; there's no "give me 3 completions" concept in the product this API mirrors. Mirror could fan out `n` separate upstream turns, but that would burn `n`x the underlying ChatGPT usage per call and silently multiply cost/rate-limit consumption behind a request field that looks free in the OpenAI API — this is deliberately not done automatically. Call the endpoint `n` times yourself if you need this.

**Tool/function calling (the OpenAI `tools`/`tool_choice` contract).** This is the biggest structural gap, and it's a two-way mismatch, not a missing feature:

- OpenAI's function calling lets *you* define a function schema, have the model request a call with structured arguments, and *you* execute it and post the result back as a `role: "tool"` message. backend-api has no such contract — there is no way for a caller to register a function schema with ChatGPT, and no `tool_calls` field in its message shape.
- ChatGPT does run tools server-side (web browsing, its Python/code-interpreter sandbox, DALL-E image generation, a "computer use" surface) — but those are ChatGPT's own built-in, product-controlled tools, invoked entirely inside OpenAI's infrastructure. Mirror's SSE reducer (`packages/protocol/src/sse.ts`) surfaces these as generic `{kind: "tool", name, status}` events for display purposes, but there's no way for an API caller to define a *new* tool, intercept the call before it runs, or feed back a custom result — the round-trip the OpenAI `tools` API depends on doesn't exist in this direction either.

Because of this, Mirror rejects `role: "tool"` messages outright and doesn't accept a `tools` field at all, rather than pretending to support a contract that can't actually complete.

**`response_format` (JSON mode / JSON schema / structured outputs).** No equivalent request field upstream, and no guarantee mechanism — ChatGPT's raw text output is exactly that, prose, with no schema-constrained decoding available to ask for.

**Reasoning-model controls** (`reasoning_effort`, `max_completion_tokens` semantics distinct from `max_tokens`, encrypted reasoning content, etc). ChatGPT's web client picks its own internal reasoning behavior per model slug; there's no lever exposed for callers to raise or lower it, and reasoning traces (where they exist) aren't returned via `f/conversation` in a form Mirror could re-expose.

**Exact token usage (`usage.prompt_tokens` / `completion_tokens` / `total_tokens`).** backend-api doesn't report token counts anywhere in its response envelope — ChatGPT bills by subscription/plan usage windows, not per-token metering, so there's nothing to read. Mirror's completions always return `usage: null` rather than fabricate a number from a tokenizer that may not even match the real one for a given model slug.

**Separate endpoints that have no ChatGPT-web equivalent at all**: `/v1/embeddings`, `/v1/audio/*` (Whisper transcription, TTS), `/v1/images/generations` as a standalone endpoint (distinct from in-chat DALL-E — see Part 2), `/v1/moderations`, `/v1/fine_tuning/*`, `/v1/batches`, and the Assistants API surface. None of these map onto anything chatgpt.com's own web client calls, so there's no backend-api traffic to reverse-engineer against in the first place.

### Accepted for compatibility, without limiting the answer

**`max_tokens`, `max_completion_tokens`, and `stop`.** Mirror accepts these fields because clients such as ChatGPTBox send them automatically, but ignores their values. No token estimate, character cap, stop-string cutoff, or synthetic `length` completion is applied. Responses retain the full answer. Generation can still fail or be cancelled; an interrupted turn is not a successful completion.

**Streaming snapshots and continuation.** Backend-api can emit more than one assistant message and can replace a text snapshot. Mirror appends growing text within each message and separates new/replacement segments with a blank line, since bytes already streamed cannot be retracted. The API's saved logical assistant row and transcript fingerprint use exactly the text delivered to the client. The upstream tree and raw captured events remain available independently. JSON completions return the final upstream assistant text. Switching response modes does not change conversation identity.

### Not structurally impossible, just not implemented

**Audio/image *input* content parts beyond `image_url`.** Mirror added `image_url` support (both `data:` URIs and `https://` URLs — see the README) because backend-api does support image attachments end-to-end (the same file-upload flow the real UI uses). Audio input parts have no equivalent upload/attachment path that's been reverse-engineered yet, so they're rejected for now rather than silently dropped — that could change if ChatGPT's audio-input flow gets mapped.

**Multiple simultaneous system/developer messages with independent semantics.** Mirror currently folds all `system`/`developer` messages into one combined instructions block sent as part of the synthesized prompt context (see `promptFor` in `apps/server/src/openai.ts`) rather than modeling them as separately trackable instruction slots. This is a Mirror implementation simplification, not a backend-api limitation.

## Part 2: ChatGPT-only capabilities the official OpenAI API can't touch

These are real features of the product Mirror proxies that have **no equivalent at all** in the official OpenAI Chat Completions API, because that API was never meant to expose a specific end-user product's features. Status varies per item — some are fully working through `/v1/chat/completions` today, some are only reachable through the proxied UI or Mirror's own non-OpenAI-compatible `/api/chat`, and some aren't exposed through Mirror at all yet. Each one says which.

### ✅ Already fully supported through `/v1/chat/completions`

**Custom GPTs and Projects (gizmos).** `GET /v1/models` lists these as pseudo-models (ids like `g-<hex>` for GPTs, `g-p-<hex>` for Projects) and you chat with one today by passing its id as `model` (`routeModel` in `apps/server/src/openai.ts` handles the routing, including a Project's own picked model via `metadata.mirror_model`). This is a real, working Mirror feature with no OpenAI API counterpart — Custom GPTs/Projects are a ChatGPT product concept (a bundle of instructions, files, and tool configuration wrapped in an id), not something the general API models at all, so there was never an "OpenAI-compatible" shape to fall back to here. Mirror had to invent the `model: "g-..."` convention itself.

**Temporary/incognito chat.** `metadata.private` (see the README) is a real, working backend-api "don't save to history, don't train on this" mode, fully wired through `/v1/chat/completions` today. The plain OpenAI API has no concept of this at all, since it was never tied to a persistent chat history in the first place.

### 🟡 Visible through Mirror, and now partially surfaced in `/v1/chat/completions`

**Built-in web browsing** and **the Python/code-interpreter sandbox.** Ordinary ChatGPT can search/browse the live web and run Python mid-conversation; the plain OpenAI Chat Completions API has no equivalent of either (browsing lives only in ChatGPT-the-product and, separately, the Responses API's hosted tools). `/v1/chat/completions` now re-exposes *that these ran* as structured data: `metadata.mirror_tool_events` on the response is a JSON-stringified array of `{name, status}` objects, one per built-in tool invocation observed during the turn (parse it with `JSON.parse`). This is informational only - there is still no way to define a *new* tool, intercept a call before it runs, or feed back a custom result; the round-trip the OpenAI `tools` contract depends on doesn't exist in this direction (see Part 1).

**In-chat image generation and generated files.** Chat Completions and Responses put previews and file links directly in assistant text, so Markdown clients such as ChatGPTBox do not need to interpret `mirror_*` metadata. An image preview uses `![filename](<data:image/png;base64,...>)`; a file link uses `Download file: [filename](<http://127.0.0.1:PORT/api/asset-content?ticket=...&download=1>)` (with the requesting Mirror origin and actual MIME type). Filenames are taken from upstream metadata or the sandbox path and escaped for Markdown. Ordinary response text and final transcript continuation remain intact.

ChatGPT's signed Estuary URLs still require authentication. Mirror retrieves preview bytes through the saved upstream session and embeds them because Google search pages can block separate requests to a loopback server under Local Network Access policy. Preview reads are bounded to 25 MiB per image; if a preview cannot be read or exceeds that bound, the response keeps the original-file download link instead of emitting a broken image. Downloads stream the original bytes without that preview size limit. `metadata.mirror_images` contains available preview URLs; a failed preview is omitted.

Each download link contains an encrypted, file-scoped ticket, never a Mirror API key or ChatGPT credential. Anyone holding that link and able to reach the Mirror instance can read that one file for seven days while the originating saved session remains connected. Reconnecting or removing the saved session invalidates the links. The route resolves fresh upstream metadata on each request, uses authentication only for the exact ChatGPT Estuary endpoint, and sends a filename-bearing `Content-Disposition: attachment` header. The browser's normal download behavior applies. Existing replies already stored in ChatGPTBox are not rewritten; ask for a fresh file link after updating Mirror. Upstream file availability can still expire independently.

Optional renderer verification: with dependencies installed in a ChatGPTBox checkout, run `CHATGPTBOX_SOURCE=/path/to/chatGPTBox node scripts/check-chatgptbox-assets.mjs` after building Mirror. This runs the checkout's actual Markdown and Hyperlink components in Chromium on a controlled HTTPS search-page fixture and checks decoded image dimensions, the clicked filename, and downloaded contents. It is a source-renderer integration test with a synthetic upstream, not an assertion about an installed personal extension.

**Conversation branching, editing, and regeneration as a real tree.** ChatGPT conversations are a DAG of message nodes with a "current" path through them (edit any user turn and you fork a new branch; regenerate and you fork the assistant side). Mirror models this faithfully for its own conversation store and the proxied UI's editing/regeneration flows (see `store.ts`'s rebase logic) — but the official Chat Completions API is stateless per call and has no notion of a branchable history at all, so there's no OpenAI-shaped way to expose "branch" or "regenerate" as request fields; `/v1/chat/completions` only gets at this indirectly, by resending edited history against a tracked `metadata.conversation_id`.

### ❌ Not exposed through Mirror at all yet

**Memory.** ChatGPT's persistent cross-conversation memory feature has no counterpart in the stateless Chat Completions API and isn't currently surfaced through Mirror in any form.

**Connectors (Drive, Gmail, calendar, etc.) inside the ChatGPT UI.** These let ChatGPT read/act on a user's connected accounts mid-conversation. They're visible in the real, proxied ChatGPT interface Mirror serves at `/`, but Mirror doesn't currently intercept or re-expose any connector-driven behavior through the OpenAI-compatible API.

**Canvas, Tasks/scheduled reminders, and voice mode.** All real ChatGPT-product surfaces with their own dedicated upstream endpoints and interaction models that don't correspond to anything in a `messages` array — none currently bridged into `/v1/chat/completions`, and some (voice) may not be structurally bridgeable into a text-completions shape at all.

## Where this leaves "full compatibility"

Given the above, "fully OpenAI-compatible" isn't a reachable end state for this specific pairing — some gaps in Part 1 are permanent by construction (there is no dial upstream to turn), and some gaps in Part 2 are ChatGPT product features that the OpenAI API format has no slot for, no matter how much of backend-api gets reverse-engineered. The realistic target is: match the official request/response *shape* as closely as backend-api's actual capabilities allow, reject unsupported fields loudly and immediately rather than silently ignoring them (this is already Mirror's policy — see the strict Zod schemas in `apps/server/src/openai.ts`), and keep this document current as more of backend-api gets mapped or as OpenAI's own API surface changes.


## Responses API text subset

`POST /v1/responses` adapts text generation to the Responses request/output format. It shares the Chat Completions engine, persistence, account checks, immutable assistant history, cancellation, deadlines, and WARP egress.

- `input`: a string or message array with `system`, `developer`, `user`, or `assistant` roles. Content can be a string or `input_text`/`output_text` parts. Returned assistant message items can be included in subsequent input history.
- `instructions`: optional system instructions. `model`, `stream`, `store`, and Mirror `metadata` routing fields are supported. `max_output_tokens` is accepted but ignored so answers remain complete.
- JSON returns a `response` object with a completed assistant message in `output` and `output_text` content parts. Token `usage` is null.
- Streaming emits named `response.created`, `response.in_progress`, output-item/content-part lifecycle events, `response.output_text.delta`, and `response.completed`. Failures emit `response.failed`; truncated streams must not be treated as success. Empty text deltas keep silent connections active every ten seconds. There is no Chat Completions `[DONE]` marker.
- Continue with the returned `metadata.conversation_id` (also a JSON response header) or resend full input history. Response IDs identify individual results; they are not conversation IDs. `previous_response_id` and GET/retrieve/delete response endpoints are not implemented.
- Mirror's `store:false` means a non-resumable one-shot, as in Chat mode. It omits the continuation ID. This differs from OpenAI's response-object storage semantics; Mirror does not store retrievable response objects.
- Tools/function calls, images/files/audio, structured output, background mode, and other unsupported request fields are rejected with HTTP 400 rather than silently ignored.

```json
{
  "model": "auto",
  "input": "Say hello in one sentence.",
  "stream": true
}
```

The Playground's **Responses** sidebar item exercises this endpoint directly. Its Messages editor sends `input` instead of Chat Completions `messages`; its Output/Raw views show text and the Responses payload respectively.

### First response in a Custom GPT or Project

On the first upstream turn of a new Custom GPT (`g-…`) or Project (`g-p-…`)
conversation, Mirror displays the assistant answer, Python tool output
(`python` and `python_user_visible`, including their namespaced variants),
and every other tool the model can invoke in direct response to the user's
own turn - image generation (`image_gen`/`dalle`/`dalle.text2im`), web browsing/search
(`browser`/`web`), canvas (`canmore`), and video/sora (`sora`/`video_gen`) -
exactly as it would on any later turn. Chain-of-thought (the raw "analysis"
channel) is likewise never hidden, on this or any turn, in any chat type; see
"Chain-of-thought / reasoning" below for how it's surfaced.

What *is* still excluded on this first turn only: `file_search`/`myfiles_browser`
results and status cards (the quiet retrieval pass over a gizmo/Project's
attached knowledge files that fires automatically before the model starts
answering) and generic system/UI framing content (developer/system content,
`computer_initialize_state`/`computer_output`, the "commentary" thinking
preamble, etc). Attachments discovered only inside those still-hidden events
are not appended or resolved; attachments in the answer, Python output, and
the other user-invoked tools above still work. The original events remain in
local storage with a display visibility flag. This rule applies to Chat
Completions and Responses, streaming and JSON, and Mirror's native chat event
feed. Follow-ups in existing upstream conversations and ordinary model chats
were never affected by any of this (nothing here is first-turn-gated for
them). The proxied ChatGPT website continues to use ChatGPT's own rendering.

### Chain-of-thought / reasoning

Documented reasoning summaries are surfaced via `metadata` on
`/v1/chat/completions` and `/v1/responses` (no non-standard top-level response
fields - see this document's convention above):
`metadata.mirror_reasoning_summaries` is
ChatGPT's own condensed post-hoc recap (`reasoning_recap`/`summary` content
types) - the "Thought for Xs" dropdown text. It is a JSON-stringified array
of `{messageId, text}` objects and is only present when the turn produced an
explicit display summary. Internal `analysis` channel content is never
published. Summaries are finalized once per turn, consistent with how Mirror
already finalizes other rich content (tool outputs, images) at
turn completion rather than incrementally.
