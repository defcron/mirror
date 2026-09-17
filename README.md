# Mirror

[![CircleCI](https://circleci.com/gh/defcron/mirror.svg?style=svg)](https://circleci.com/gh/defcron/mirror) [![GitHub Actions CI](https://github.com/defcron/mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/defcron/mirror/actions/workflows/ci.yml) [![Coverage](https://img.shields.io/badge/coverage-100%25%20enforced-brightgreen)](.c8rc.json) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.nvmrc) [![Last commit](https://img.shields.io/github/last-commit/defcron/mirror)](https://github.com/defcron/mirror/commits/main) [![Issues](https://img.shields.io/github/issues/defcron/mirror)](https://github.com/defcron/mirror/issues) [![Stars](https://img.shields.io/github/stars/defcron/mirror?style=social)](https://github.com/defcron/mirror/stargazers)

See [TODO.md](TODO.md) for the issue-level backlog and
[NEXT-STEPS.md](NEXT-STEPS.md) for the repository-audit roadmap and recommended
order of work.

Mirror is a local, self-hosted ChatGPT client with an OpenAI-compatible API bolted on. It logs you into the *real* chatgpt.com web app — proxied through Mirror's own server, using your existing ChatGPT session — so you get the actual ChatGPT interface, Custom GPTs and all, with no OpenAI API key and no browser automation involved. Alongside that, Mirror ships a separate **Playground** page for testing its OpenAI-compatible `/v1/chat/completions` endpoint directly.

> **Unofficial project.** Mirror depends on ChatGPT's private web protocol, which OpenAI can change at any time without notice. Keep it on localhost. See [PROTOCOL.md](./PROTOCOL.md) for the full reverse-engineered protocol notes.

> **Provenance.** Mirror is an independent project inspired by earlier experimentation in ChatGPT-compatible tooling, including research into existing projects such as [dairoot's discontinued ChatGPT-Mirror](https://github.com/dairoot/ChatGPT-Mirror) and [suphotP/chatgpt-api](https://github.com/suphotP/chatgpt-api). Mirror has a different architecture, goals, and implementation.

## Quickstart

You'll need Docker, and a ChatGPT account you're logged into in a browser.

**1. Get your session token.**

While logged into ChatGPT in your browser, open [https://chatgpt.com/api/auth/session](https://chatgpt.com/api/auth/session). The session token is displayed on that page — copy it. This is the one credential Mirror needs — it's the same long-lived session cookie your browser already relies on to keep you logged in; Mirror uses it server-side to mint its own short-lived access tokens, and never needs anything else from you.

**2. Configure and start the stack.**

```sh
cp .env.example .env
# Open .env and set WARP_ACCEPT_TOS=yes (after reading Cloudflare's WARP terms)
docker compose up --build
```

**3. Open the app and connect your token.**

Go to `http://127.0.0.1:8799` — this is the real ChatGPT interface, served through Mirror. In the left sidebar, click the **Mirror controls** button (it sits just above your account button, and Mirror injects it there automatically). A panel opens with a `sessionToken` field — paste the token from step 1 and hit **Save & reload**.

That's it. Mirror mints and refreshes its own access tokens from your session token going forward, so you won't need to touch this panel again unless the session itself expires or you sign out. The same panel also shows a green/amber connection dot and the current WARP egress status, and has an **API tester** link straight to the Playground (see below).

### Why WARP?

Mirror requires all traffic to route through the bundled Cloudflare WARP container — it will refuse to start otherwise. This isn't optional hardening you can turn off. It exists because:

- it keeps Mirror's outbound requests to `chatgpt.com` on a consistent, verified egress path instead of your raw host network
- Cloudflare's faster "Local proxy" mode caps requests at 10 seconds, which breaks long streamed responses, so Mirror uses full WARP/MASQUE mode instead and verifies Cloudflare's `warp=on` trace signal before letting the app serve traffic

Mirror rechecks this every 30 seconds and shuts down serving if the tunnel drops — there's no silent fallback to a direct connection. Note that WARP changes your network path but doesn't grant a fixed IP or protect an account that ChatGPT has already flagged; if that happens, use ChatGPT's own account recovery flow rather than retrying through Mirror.

## Decoder challenges in the ChatGPT UI

Open **Format Lab** beside the normal ChatGPT composer in the relayed official interface. The existing Mirror controls panel stays dedicated to connection settings. Choose **LoaF**, **PngSpeak**, **Original gptgif**, or **gptgif v4**, then generate a challenge. You can give GPT a format guide or let it investigate, and choose a UTF-8 note or random binary as the hidden payload. The v4 challenges randomize their alphabet and palette.

**Insert into chat** prepares a draft in the normal composer; send it when ready. An existing draft is preserved. **Copy prompt** is available if the upstream composer changes. The prompt carries the exact encoded artifact as `base64(gzip(file bytes))`, so GPT can reconstruct it with code execution without accessing your localhost. GPT must decode the named format after unpacking that transport. For larger prompts, especially v4, use **Download prompt**, attach the `.txt` file in ChatGPT, and ask GPT to solve the challenge described inside it. Code execution must be available in the selected ChatGPT conversation; Mirror does not add execution tools to the upstream model.

When GPT finishes, reopen Format Lab and click **Check latest GPT reply**, or paste its recovered hexadecimal bytes / marked answer line. Mirror compares the bytes against its server-held answer key and reports **Exact match**, **Partial match**, or **Mismatch**. Partial matches count bytes at the same offsets; extra or missing bytes never pass as exact. Reply markers contain a unique challenge ID to avoid grading another challenge's answer.

The **GPT workshop** in Format Lab uses Mirror's conversion API to build format-specific prompts for three collaborative actions: build an artifact from a creative brief, remix a format, or explain a format with a tiny example. The prompt asks GPT to produce real bytes or a reproducible script, maintain a manifest, and leave a change log for the next iteration. This is deliberately a GPT-facing workflow rather than a user-only export tool.

The optional **Download this kit** action bundles the encoded file, matching `prompt.txt`, separate `format-guide.txt`, and instructions in a standard `.tar.gz` archive. Expand **Optional: get files and prompts → Get all four kits** to generate and download one kit for each format in a single archive. The separate guide is an optional hint for the user, including when the prompt uses independent mode. No kit contains an answer key. **Recent challenges** lets you select the challenge you want to check; the last 16 generated prompts are retained in this tab's session storage across reloads.

Answer keys are ephemeral: they expire after 24 hours, a Mirror restart, or a saved-session change. Downloaded files remain usable for independent decoding after that, but Mirror can no longer grade them. The server bounds active challenges to 64 and generation to 20 per minute. The challenge, download, kit, and verification routes use Mirror's existing local control authentication and origin protections; see the generated API docs for `/api/decoder-challenges`.

## The Playground

Besides the proxied ChatGPT interface, Mirror ships a second page — the **Playground** — for exercising its OpenAI-compatible API directly, without needing to write any code. Reach it either from the **Mirror controls** panel's "API tester" link, or directly at:

```
http://127.0.0.1:8799/mirror/playground
```

The Playground offers **Chat** (`/v1/chat/completions`) and **Responses** (`/v1/responses`) modes. Pick a live model, send text messages, and inspect streamed or JSON output in either API format. Switching modes keeps your transcript and Mirror conversation ID. User turns remain editable; assistant replies remain read-only. Both modes use the same conversation engine and can load and continue saved Mirror conversations.

Responses supports text input, instructions, named streaming events, and one-shot requests. Continue using `metadata.conversation_id` or full input history. This is a documented subset: tools, image/file input, `previous_response_id`, response retrieval, and background mode are not supported.

By default the Playground keeps its bearer token in memory only and doesn't persist message history; there's a "Remember prompt history on this device" toggle if you want it to keep your working history in the browser's `localStorage` between visits — flip it back off to clear it. The System box is different: it's always saved server-side, account-wide (`GET`/`PUT /api/settings/default-system-instructions`), not to `localStorage` — whatever you leave in it becomes the default a *new* conversation starts from, on any browser or device signed in to this Mirror instance, independent of the "remember prompt history" toggle above.

## Using the OpenAI-compatible API

Point any OpenAI SDK at Mirror instead of `api.openai.com`:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="your-configured-mirror-key")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

Browser navigation to `/` or `/mirror/playground` creates a process-local, HttpOnly,
SameSite=Strict control cookie, so the proxied ChatGPT UI and the Playground keep working
in a browser without any extra setup. Reload after restarting Mirror. Everything else —
`curl`, an OpenAI SDK, any non-browser client hitting `/v1/*` or Mirror's own `/api/*`
routes — now requires a configured `MIRROR_API_KEY` (or one of `MIRROR_API_KEYS`, or `OPENAI_API_KEY`); Mirror
will reject those requests with 401 if none is set. These keys protect control routes,
conversations, proxy access, and `/v1/*`; they are unrelated to OpenAI credentials.
Health and compiled static assets are public.

```sh
MIRROR_API_KEY='replace-with-a-long-random-value' npm start
```

This is required for any programmatic use of Mirror — set it in `.env` (or export it)
before scripting against `/v1/*`, not just at `npm start` time. Generate a crypto-random
value for it instead of typing one by hand:

```sh
npm run gen-api-key            # 32 random bytes, base64url-encoded
npm run gen-api-key -- 24      # optional byte length (min 16)
```

This only prints a key to your terminal — copy it into `MIRROR_API_KEY` (or append another to `MIRROR_API_KEYS`) yourself; it doesn't write your `.env` file for you.

### Connecting cm, ChatGPTBox, and other OpenAI-compatible clients

Mirror exposes two different base URLs, and which one a client wants depends on what it's actually built to talk to:

- **The server root** (`http://127.0.0.1:8799`, or `http://127.0.0.1:8787` outside Compose) — for a client that already knows it's talking to a Mirror-shaped API and appends its own path, such as `cm` (a separate, sibling Rust CLI project for persistent Mirror chat threads): set `CM_BASE_URL=http://127.0.0.1:8799`.
- **The `/v1` path** (`http://127.0.0.1:8799/v1`) — for a generic OpenAI-compatible client or SDK that expects an `api.openai.com`-shaped base URL and appends `/chat/completions` itself, e.g. the Python example above, or a client field literally labeled "API Base URL" / "OpenAI Base URL".

[ChatGPTBox](https://github.com/josStorer/chatGPTBox) (the browser extension) falls into the second category: pick its **OpenAI API (Custom)** / OpenAI-compatible provider, set the API base URL to `http://127.0.0.1:8799/v1` (some client UIs instead ask for the full completion URL — in that case use `http://127.0.0.1:8799/v1/chat/completions`), set the API key to your configured `MIRROR_API_KEY`, and set the model to any id `GET /v1/models` returns (`auto` picks your account's current default). This has been confirmed working end-to-end (streaming, model discovery, and normal completions) against a real account.

Streaming completions send an empty content delta every 10 seconds while waiting for upstream preparation or response text. ChatGPTBox forwards these data events through its extension messaging port; plain SSE comments would be ignored. This prevents silent waits from starving the messaging activity that keeps a [Chrome extension service worker alive](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). These keepalives add no answer text and do not reset Mirror's idle or total generation deadlines. Client disconnections are recorded as `client_disconnected` in diagnostics, with elapsed time in the server log. The regression suite tests a silent seventh full-history turn over a real local HTTP connection, continuation under the sixth assistant node, deadline expiry, and heartbeat write failure using synthetic upstream responses; it does not prove recovery of an already-disconnected extension request.

Either base URL requires a configured `MIRROR_API_KEY` (or `MIRROR_API_KEYS` / `OPENAI_API_KEY`) sent as `Authorization: Bearer ...` for any **cross-origin** request — that's what lets a browser extension on its own origin, or a script on a different host/port, reach `/v1/*` at all. Mirror's *other* routes (`/api/*`, the proxied ChatGPT UI, the Playground) are deliberately not exposed this way: they stay restricted to same-origin browser requests (backed by the control cookie from step 3 of the Quickstart) specifically so a bearer key alone can't be used to drive them. A same-origin browser client (the Playground itself, for instance) doesn't need a bearer key for `/v1/*` either, for the same reason.

**What's supported:** `model`, `messages`, `stream`, `store`, `max_tokens` / `max_completion_tokens`, `stop`, and `metadata.conversation_id` / `metadata.mirror_model` / `metadata.private`. Any other field is rejected rather than silently ignored, so you'll know immediately if you've hit an unsupported option. The final user message's `content` may also include `image_url` parts (`{"type": "image_url", "image_url": {"url": "..."}}`) — both `data:` URIs and `https://` URLs are accepted; Mirror uploads the image to ChatGPT's file service on your behalf before sending the turn, same as attaching it in the real UI would. Non-image files (PDFs, text files, spreadsheets, etc.) are supported the same way via `file` parts (`{"type": "file", "file": {"file_data": "...", "filename": "notes.txt"}}`), also accepting `data:` URIs or `https://` URLs; `filename` is optional and defaults to `attachment-<index>`.

`max_tokens`, `max_completion_tokens`, and `stop` are **accepted but ignored** for client compatibility. Mirror does not impose a token/character ceiling or truncate answers at stop strings. Successful completions report `finish_reason: "stop"`. The local API transcript and its continuation fingerprint contain the exact answer returned to the caller. Upstream message IDs and captured events are retained independently. ChatGPT-only behavior that happens mid-turn — a web search, the code-interpreter sandbox running, or an in-chat generated image — is surfaced back to you via `metadata.mirror_tool_events` / `metadata.mirror_images` on the response, since the official response schema has no field for any of that. See [COMPATIBILITY.md](./COMPATIBILITY.md) for the exact shape of both.

**What's not supported (yet):** tool/function calling, audio content parts, response-format constraints, sampling controls (temperature, top_p, etc.), penalties, seeds, and multiple choices per request. See [COMPATIBILITY.md](./COMPATIBILITY.md) for the full rundown of what's structurally possible against ChatGPT's backend-api and what isn't, in both directions.

**Playground attachments:** In Chat mode, use **Attach file** on the final user message, select one or more files, wait for file reading to finish, then run. A file-only user message is also accepted. The browser sends the original filename and complete bytes, including for images. Mirror selects MIME types on the server from the filename extension: `.md`/`.markdown` become `text/markdown`, `.png` becomes `image/png`, and unknown or missing extensions become `application/octet-stream`. Client MIME labels and file contents do not override this choice. The same rule applies to Chat Completions `file` parts and native `POST /api/files` uploads. The separate, filename-free `image_url` API retains its existing image MIME handling. Responses mode supports text input only and explains that attachments require Chat mode.

### API docs and the OpenAPI schema

Mirror generates an OpenAPI 3.1 document straight from the same Zod schemas every route (both `/v1/*` and `/api/*`) validates requests against — there's no hand-written spec to fall out of sync; only the small, plain-object response shapes on the `/api/*` routes are still described by hand, since they aren't Zod-validated at runtime to begin with. Get the spec as JSON from `GET /mirror/openapi`, or as YAML from `GET /mirror/openapi?format=yaml`; browse and try it live at `/mirror/api-docs` (Swagger UI). Both are also linked from the Playground's nav bar and from the "Mirror controls" widget in the proxied ChatGPT UI.

**Continuing a conversation:** pass `metadata.conversation_id` to keep talking in the same upstream ChatGPT thread. Mirror only sends your latest message in that case, since ChatGPT already has the history server-side. User edits and changed instructions rebase the tracked conversation; assistant turns are read-only. Supply the complete prior transcript when continuing through the Playground. Pass `store: false` for a one-off, upstream "temporary chat" whose conversation and messages remain in memory only, without database insertion.

## What Mirror can do

Because the main interface is the real ChatGPT web app (proxied through Mirror rather than rebuilt from scratch), you get everything that comes with it: full conversation continuity, branching, editing and regeneration, Custom GPTs, Markdown/code/GFM table/KaTeX rendering, file uploads and generated images, and the persistent conversation sidebar — backed by your ChatGPT account. The Playground separately maintains a local SQLite mirror of conversations it uses. On top of that, Mirror adds:

- Live model discovery straight from your account — nothing hardcoded
- Structured event capture for assistant text, tool calls, file search, citations, images, and status markers, so behavior stays correct even when the underlying protocol details shift
- Stop/cancellation that reaches all the way through to the upstream request
- An OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` (streaming + non-streaming), plus the Playground for testing them directly

**Not included by design:** support for multiple auth methods beyond the one session-token flow, and a solved Cloudflare Turnstile challenge (Mirror currently relies on the fact that ChatGPT doesn't always demand one — see [PROTOCOL.md](./PROTOCOL.md) for details on that gap).

## Security & storage

See [RELEASE-RECOVERY.md](RELEASE-RECOVERY.md) for database schema compatibility,
image revision identification, the isolated `npm run storage:drill` check, and
the upgrade/rollback procedure.

- Everything is scoped to `127.0.0.1` by default. Mirror checks the request `Host` header and rejects anything that isn't loopback (`localhost`, `127.0.0.0/8`, `::1`). It is **not** designed for remote or multi-user deployment — that would need TLS, real auth, CSRF protection, and a proper security review, not just a changed `HOST` value.
- Your session token and minted access token are encrypted at rest with AES-256-GCM, in a local SQLite database (`.data/mirror.db` by default). The token is never inserted into the proxied ChatGPT page's own scripts.
- On first run Mirror generates `.data/master.key` (owner-only permissions) to encrypt credential values. Conversation text, saved instructions, and events are not encrypted by Mirror. For production-style setups you can instead supply your own key via `MIRROR_STORE_KEY` (32 bytes, base64 or hex).
- If you're upgrading from an older version that used a plaintext `.data/store.json`, Mirror migrates it into the encrypted database automatically and deletes the plaintext file once that succeeds.
- Request logging redacts common credential headers and omits query strings. Treat logs as sensitive and review them before sharing; redaction is not a guarantee against every upstream error shape.

### Configuration reference

| Variable            | Default                 | Purpose                                       |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `WARP_ACCEPT_TOS`    | (unset)                  | Must be `yes` — acknowledges Cloudflare's WARP terms before the tunnel will register |
| `MIRROR_PORT`        | `8799`                   | **Compose only** — the host port you actually connect to (`http://127.0.0.1:8799`) when running `docker compose up`. Not read by a direct/non-Compose run. |
| `HOST`               | `127.0.0.1`               | Server bind address for a **direct, non-Compose** run (`npm run dev` / `npm start`) |
| `PORT`               | `8787`                    | Server port for a **direct, non-Compose** run — a locally overridden `PORT` changes this, but has no effect on Compose's `MIRROR_PORT` |
| `MIRROR_WEB_ORIGIN`  | `http://localhost:5173`   | Dev-mode CORS origin |
| `MIRROR_DATA_DIR`    | project `.data`           | Where the database and encryption key live |
| `MIRROR_STORE_KEY`   | auto-generated            | Fixed 32-byte credential encryption key (base64 or hex) |
| `MIRROR_API_KEY(S)`  | **required for API access** | Application key(s) gating `/v1/*` and other non-browser routes (comma-separate `MIRROR_API_KEYS` for multiple) |
| `OPENAI_API_KEY`     | (unset)                  | Accepted as an additional inbound Mirror key alongside `MIRROR_API_KEY(S)` — convenient because it's also the variable name most OpenAI-compatible clients already look for. Not an outbound OpenAI credential; Mirror never calls `api.openai.com`. Blank values are ignored. |

So: **Compose** users connect to `MIRROR_PORT` (`8799` by default); a **direct/non-Compose** run listens on `HOST:PORT` (`127.0.0.1:8787` by default) instead — the two are independent knobs for two different ways of running Mirror, not the same port under two names.

## Running without Docker

For development, or if you'd rather manage WARP yourself:

```sh
nvm use  # Node 24, also used by Docker and CI
npm ci
npm run dev        # server on :8787 (or configured PORT) + web dev server on :5173
```

`npm start` builds and runs the production server directly, but note it still performs the same WARP egress verification and will refuse to serve traffic without a working WARP tunnel in its network path — there's no supported way to bypass this check.

## HTTP API reference

Mirror's own REST/SSE API (used by the proxied UI and the Playground):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Database/configuration/egress health |
| `POST /api/session` | Verify and store a ChatGPT session token |
| `GET /api/session` | Inspect the current session |
| `DELETE /api/session` | Remove the stored session |
| `GET /api/models` | Normalized live model list |
| `GET /api/gpts` | Normalized Custom GPT list |
| `GET /api/conversations` | List conversations |
| `POST /api/conversations` | Create a conversation |
| `GET /api/conversations/:id` | Load a conversation |
| `DELETE /api/conversations/:id` | Delete a conversation |
| `POST /api/conversations/:id/branch` | Branch from an assistant node |
| `POST /api/conversations/:id/stop` | Cancel an in-flight response |
| `POST /api/files` | Upload an attachment |
| `GET /api/assets` | Fetch an authenticated generated asset (e.g. an image) |
| `POST /api/chat` | Structured SSE chat stream (used by the proxied UI) |

Plus the OpenAI-compatible surface:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/models` | OpenAI-compatible model list |
| `POST /v1/chat/completions` | OpenAI-compatible completions (streaming and non-streaming) — also what the Playground exercises |

## Development & testing

```sh
npm run typecheck
npm test
npm run coverage
npm run build
npx playwright install chromium
npm run test:e2e
npm run manifest -- --check
npm audit --omit=dev
```

Tests cover SSE framing, conversation-tree/branch logic, encrypted credential storage, OpenAI-compatible request validation, and the loopback Host/origin policy. They never touch a live ChatGPT account — no credential is read or injected during the test run.

Every server build runs `apps/server/tests/conversation-continuation.test.mjs` after compiling and before generating the OpenAPI artifacts. This is mandatory for `npm run build`, `npm start`, the server workspace build, CI, and the Docker image build. A failed assertion exits nonzero and stops the build. The suite drives three successive HTTP completions through both explicit-ID forms (minimal and full history) and transcript matching, using the actual returned answer in subsequent requests. It verifies stable local/upstream IDs, the preceding assistant parent, one conversation only, complete untruncated output, and reloadable matching history. Streaming, JSON, mixed modes, multi-message turns, and replacement snapshots are covered. Tests use isolated storage and synthetic upstream responses; they do not establish compatibility with every future live protocol change.

`npm run coverage` builds the protocol, web application, and server, then runs the same unit and integration tests as `npm test` under C8. Building the web workspace first makes the command self-contained on a clean checkout because server route tests exercise the generated Playground shell. It collects one fresh report across the server, protocol workers, and React tests, and requires **100% statements, branches, functions, and lines in every application source file**. Unimported files are included so adding untested code fails the gate. CI runs this command as an explicit required step before the production build.

Every test case must be nested in a named `test.describe(...)` suite. Use a suite name that identifies the component or behavior under test; add nested suites when they make a large file easier to scan. `npm run test:suites` enforces this structure across server, web, protocol, and browser tests, and the normal unit and coverage commands run that check automatically. New behavior must retain the per-file **100% statements, branches, functions, and lines** coverage gate; do not lower the thresholds or add coverage exclusions to accommodate untested code.

Open `coverage/index.html` for the annotated report. Machine-readable results are in `coverage/coverage-summary.json`, `coverage/coverage-final.json`, and `coverage/lcov.info`. Reports and raw V8 data are generated artifacts and are ignored by Git.

The coverage scope is the executable TypeScript in `apps/server/src`, `apps/web/src`, and `packages/protocol/src`, mapped from compiled JavaScript where applicable. It excludes dependencies, declarations, test code, build/maintenance scripts, configuration, and macOS resource-fork files. CSS, shell scripts, and JavaScript embedded in injection-template strings are not instrumented as browser executions by C8. Browser smoke tests run separately with `npm run test:e2e`; coverage percentages do not establish live ChatGPT compatibility.

## Learn more

- [PROTOCOL.md](./PROTOCOL.md) — the reverse-engineered ChatGPT backend protocol Mirror implements against, including known gaps and open questions.
- [COMPATIBILITY.md](./COMPATIBILITY.md) — every point where Mirror's OpenAI-compatible API diverges from the real OpenAI API, in both directions, and why each one is (or isn't) fixable.

## Reliability and compatibility

- `sync` and `resync` query parameters accept only `true` or `false`. Pagination
  reports additional upstream history even at a local page boundary. Refresh
  fetches the newest active page; scrolling incrementally continues the sync.
- Streaming errors and missing terminal markers are failures. Partial output
  remains visible. Event streams are forwarded incrementally, without text rewriting.
- The optional browser snapshot pairs conversation ID, messages, model, project
  model, and privacy settings. Without history persistence, refresh starts a new
  editor. Loading a saved conversation restores its stored instructions; older
  conversations without saved instructions load with none rather than borrowing
  instructions from a different conversation.
- `-wm` models are listed as unsupported and rejected by this transport. Mirror
  does not implement Work Mode or silently substitute the corresponding base model.
  Model IDs describe the selected transport model, not a verified internal model build.
- `private` requests can still have local history. `store:false` uses memory-only
  conversation/message state. Turning off “Remember prompt history” clears the
  browser snapshot. Neither deletion nor pruning guarantees physical secure erasure.
- Session replacement/logout invalidates pending credential refreshes and cancels
  active generations. Reconnect/retry explicitly after a session change.
- No Datadog initialization is performed by Mirror. The frontend integration is
  isolated in `browser-patch.ts` and `mirror-controls.ts`; it still depends on
  upstream markup and is not guaranteed compatible with every upstream release.

## Backup, restore, and retention

Use Node 24. Set `MIRROR_DATA_DIR` to the directory used by your deployment.
A backup contains **plaintext conversations/instructions/events** and encrypted
credentials. With the generated-key configuration it also contains `master.key`;
protect the whole backup as sensitive. With `MIRROR_STORE_KEY`, retain that key
separately. Backups use SQLite's online backup API, including committed WAL data.

```sh
npm run storage -- backup /absolute/path/to/new-backup-directory
# Stop Mirror before either operation below.
MIRROR_DATA_DIR=/absolute/path/to/new-empty-data-directory npm run storage -- restore /absolute/path/to/new-backup-directory --offline
npm run storage -- prune 90 --offline
```

Restore refuses to overwrite an existing database. Keep the original directory
until the restored installation has been checked. Pruning deletes local
conversations older than the chosen number of days; it does not delete upstream
ChatGPT history or revoke credentials. It is an explicit maintenance operation,
not an automatic retention policy.

`SHA256-MANIFEST.json` describes tracked source/configuration files. Regenerate it
with `npm run manifest` after changing files; CI checks that it is current.

`OPENAI_API_KEY` also works as an inbound Mirror API key (including in Docker Compose) — see the [configuration reference](#configuration-reference) and [client setup](#connecting-cm-chatgptbox-and-other-openai-compatible-clients) above for the full explanation; it is not an upstream OpenAI credential.


### Optional cm integration test

Mirror's build and test suite do not require cm, its source checkout, or Rust. One optional integration test runs an existing `cm` executable against an isolated Mirror server with synthetic upstream responses. It verifies three turns across SSE and JSON, retained conversation identity, saved instructions, and the upstream assistant parent. It does not use your real session or cm state.

The test looks for an installed `cm` (`cm.exe` on Windows) on `PATH`. Set `CM_TEST_BINARY` to use another executable path. If that binary is missing, only this real-client test is skipped with an explicit reason; all standalone Mirror tests still run. If the binary exists, client failures fail the test. No platform is automatically excluded, and the suite never builds or installs cm.

CI does not check out cm or install Rust. Tests that exercise cm-style API requests using synthetic fixtures remain unconditional because they have no dependency on the cm project.
