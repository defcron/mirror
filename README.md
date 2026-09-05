# Mirror

Mirror is a local, self-hosted ChatGPT client with an OpenAI-compatible API bolted on. It logs you into the *real* chatgpt.com web app — proxied through Mirror's own server, using your existing ChatGPT session — so you get the actual ChatGPT interface, Custom GPTs and all, with no OpenAI API key and no browser automation involved. Alongside that, Mirror ships a separate **Playground** page for testing its OpenAI-compatible `/v1/chat/completions` endpoint directly.

> **Unofficial project.** Mirror depends on ChatGPT's private web protocol, which OpenAI can change at any time without notice. Keep it on localhost. See [PROTOCOL.md](./PROTOCOL.md) for the full reverse-engineered protocol notes.

## Quickstart

You'll need Docker, and a ChatGPT account you're logged into in a browser.

**1. Get your session token.**

While logged into ChatGPT in your browser, navigate to:

```
https://chatgpt.com/api/auth/session
```

Open your browser's dev tools on that page and copy the value of the `__Secure-next-auth.session-token` cookie. This is the one credential Mirror needs — it's the same long-lived session cookie your browser already relies on to keep you logged in; Mirror uses it server-side to mint its own short-lived access tokens, and never needs anything else from you.

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

## The Playground

Besides the proxied ChatGPT interface, Mirror ships a second page — the **Playground** — for exercising its OpenAI-compatible API directly, without needing to write any code. Reach it either from the **Mirror controls** panel's "API tester" link, or directly at:

```
http://127.0.0.1:8799/mirror/playground
```

It's a lightweight chat-completions tester: pick a live model from your account, send messages, and watch streaming or non-streaming responses come back exactly as `/v1/chat/completions` would return them to any OpenAI SDK. You can edit or remove individual turns and re-run from that point, continue an existing upstream ChatGPT thread via its conversation id, and load previous Mirror conversations into the working history. It's meant as a quick way to sanity-check requests and inspect exact response shapes before wiring up real client code — everything it does goes through the same `/v1/chat/completions` endpoint documented below, so anything that works in the Playground will work the same way from `curl` or an SDK.

By default the Playground keeps its bearer token in memory only and doesn't persist message history; there's a "Remember prompt history on this device" toggle if you want it to keep your working history in the browser's `localStorage` between visits — flip it back off to clear it.

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
SameSite=Strict control cookie. Reload after restarting Mirror. Non-browser API
clients must supply a configured `MIRROR_API_KEY` or one of `MIRROR_API_KEYS`.
These keys protect control routes, conversations, proxy access, and `/v1/*`;
they are unrelated to OpenAI credentials. Health and compiled static assets are public.

```sh
MIRROR_API_KEY='replace-with-a-long-random-value' npm start
```

**What's supported:** `model`, `messages`, `stream`, `store`, and `metadata.conversation_id` / `metadata.mirror_model` / `metadata.private`. Any other field is rejected rather than silently ignored, so you'll know immediately if you've hit an unsupported option.

**What's not supported (yet):** tool calls, image/audio content parts, response-format constraints, sampling controls (temperature, top_p, etc.), token limits, penalties, seeds, stop sequences, and multiple choices per request.

**Continuing a conversation:** pass `metadata.conversation_id` to keep talking in the same upstream ChatGPT thread. Mirror only sends your latest message in that case, since ChatGPT already has the history server-side. User edits and changed instructions rebase the tracked conversation; assistant turns are read-only. Supply the complete prior transcript when continuing through the Playground. Pass `store: false` for a one-off, upstream "temporary chat" whose conversation and messages remain in memory only, without database insertion.

## What Mirror can do

Because the main interface is the real ChatGPT web app (proxied through Mirror rather than rebuilt from scratch), you get everything that comes with it: full conversation continuity, branching, editing and regeneration, Custom GPTs, Markdown/code/GFM table/KaTeX rendering, file uploads and generated images, and the persistent conversation sidebar — backed by your ChatGPT account. The Playground separately maintains a local SQLite mirror of conversations it uses. On top of that, Mirror adds:

- Live model discovery straight from your account — nothing hardcoded
- Structured event capture for assistant text, tool calls, file search, citations, images, and status markers, so behavior stays correct even when the underlying protocol details shift
- Stop/cancellation that reaches all the way through to the upstream request
- An OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` (streaming + non-streaming), plus the Playground for testing them directly

**Not included by design:** support for multiple auth methods beyond the one session-token flow, and a solved Cloudflare Turnstile challenge (Mirror currently relies on the fact that ChatGPT doesn't always demand one — see [PROTOCOL.md](./PROTOCOL.md) for details on that gap).

## Security & storage

- Everything is scoped to `127.0.0.1` by default. Mirror checks the request `Host` header and rejects anything that isn't loopback (`localhost`, `127.0.0.0/8`, `::1`). It is **not** designed for remote or multi-user deployment — that would need TLS, real auth, CSRF protection, and a proper security review, not just a changed `HOST` value.
- Your session token and minted access token are encrypted at rest with AES-256-GCM, in a local SQLite database (`.data/mirror.db` by default). The token is never inserted into the proxied ChatGPT page's own scripts.
- On first run Mirror generates `.data/master.key` (owner-only permissions) to encrypt credential values. Conversation text, saved instructions, and events are not encrypted by Mirror. For production-style setups you can instead supply your own key via `MIRROR_STORE_KEY` (32 bytes, base64 or hex).
- If you're upgrading from an older version that used a plaintext `.data/store.json`, Mirror migrates it into the encrypted database automatically and deletes the plaintext file once that succeeds.
- Request logging redacts common credential headers and omits query strings. Treat logs as sensitive and review them before sharing; redaction is not a guarantee against every upstream error shape.

### Configuration reference

| Variable            | Default                 | Purpose                                       |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `WARP_ACCEPT_TOS`    | (unset)                  | Must be `yes` — acknowledges Cloudflare's WARP terms before the tunnel will register |
| `MIRROR_PORT`        | `8799`                   | Host port for the combined WARP + Mirror stack (Compose) |
| `HOST`               | `127.0.0.1`               | Server bind address (direct/non-Compose runs) |
| `PORT`               | `8787`                    | Server port (direct/non-Compose runs) |
| `MIRROR_WEB_ORIGIN`  | `http://localhost:5173`   | Dev-mode CORS origin |
| `MIRROR_DATA_DIR`    | project `.data`           | Where the database and encryption key live |
| `MIRROR_STORE_KEY`   | auto-generated            | Fixed 32-byte credential encryption key (base64 or hex) |
| `MIRROR_API_KEY(S)`  | unset                     | Application keys for API and control access (comma-separate for multiple) |

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
npm run build
npx playwright install chromium
npm run test:e2e
npm run manifest -- --check
npm audit --omit=dev
```

Tests cover SSE framing, conversation-tree/branch logic, encrypted credential storage, OpenAI-compatible request validation, and the loopback Host/origin policy. They never touch a live ChatGPT account — no credential is read or injected during the test run.

## Learn more

- [PROTOCOL.md](./PROTOCOL.md) — the reverse-engineered ChatGPT backend protocol Mirror implements against, including known gaps and open questions.

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
