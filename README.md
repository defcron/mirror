# Mirror

Mirror is a local, self-hosted ChatGPT web client with an OpenAI-compatible API bolted on. It logs in with your existing ChatGPT session — no OpenAI API key, no browser automation — and talks directly to `chatgpt.com/backend-api`, the same backend the real ChatGPT web app uses.

You get a clean chat UI (Markdown, code blocks, math, file uploads, Custom GPTs, conversation branching) *and* a drop-in `/v1/chat/completions` endpoint you can point any OpenAI SDK at.

> **Unofficial project.** Mirror depends on ChatGPT's private web protocol, which OpenAI can change at any time without notice. Keep it on localhost. See [PROTOCOL.md](./PROTOCOL.md) for the full reverse-engineered protocol notes.

## Quickstart

You'll need Docker, and a ChatGPT account you're logged into in a browser.

**1. Get your session token.**

Log into [chatgpt.com](https://chatgpt.com) in your browser, open dev tools, and copy the value of the `__Secure-next-auth.session-token` cookie (Application/Storage tab → Cookies → chatgpt.com). This is the only credential Mirror needs — it's the same cookie your browser already uses to stay logged in.

**2. Configure and start the stack.**

```sh
cp .env.example .env
# Open .env and set WARP_ACCEPT_TOS=yes (after reading Cloudflare's WARP terms)
docker compose up --build
```

**3. Open the app and paste your token.**

Go to `http://127.0.0.1:8799`, paste the session token from step 1 when prompted, and start chatting.

That's it — Mirror mints its own short-lived access tokens from your session and never needs the raw token again unless it expires or you sign out.

### Why WARP?

Mirror requires all traffic to route through the bundled Cloudflare WARP container — it will refuse to start otherwise. This isn't optional hardening you can turn off. It exists because:

- it keeps Mirror's outbound requests to `chatgpt.com` on a consistent, verified egress path instead of your raw host network
- Cloudflare's faster "Local proxy" mode caps requests at 10 seconds, which breaks long streamed responses, so Mirror uses full WARP/MASQUE mode instead and verifies Cloudflare's `warp=on` trace signal before letting the app serve traffic

Mirror rechecks this every 30 seconds and shuts down serving if the tunnel drops — there's no silent fallback to a direct connection. Note that WARP changes your network path but doesn't grant a fixed IP or protect an account that ChatGPT has already flagged; if that happens, use ChatGPT's own account recovery flow rather than retrying through Mirror.

## Using the OpenAI-compatible API

Point any OpenAI SDK at Mirror instead of `api.openai.com`:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="local")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

`api_key` can be any placeholder value by default — Mirror doesn't check it unless you opt in:

```sh
MIRROR_API_KEY='replace-with-a-long-random-value' npm start
```

(Multiple keys: comma-separate them in `MIRROR_API_KEYS`. These gate access to Mirror itself; they are unrelated to your OpenAI or ChatGPT credentials.)

**What's supported:** `model`, `messages`, `stream`, `store`, and `metadata.conversation_id` / `metadata.mirror_model` / `metadata.private`. Any other field is rejected rather than silently ignored, so you'll know immediately if you've hit an unsupported option.

**What's not supported (yet):** tool calls, image/audio content parts, response-format constraints, sampling controls (temperature, top_p, etc.), token limits, penalties, seeds, stop sequences, and multiple choices per request.

**Continuing a conversation:** pass `metadata.conversation_id` to keep talking in the same upstream ChatGPT thread. Mirror only sends your latest message in that case, since ChatGPT already has the history server-side. You can't change the system/developer instructions on an existing thread — start a new `conversation_id` instead. Pass `store: false` for a one-off, upstream "temporary chat" that Mirror deletes locally as soon as the request finishes (success or failure).

## What Mirror can do

- Full ChatGPT conversation continuity (correct parent-message threading, branching, editing, regeneration)
- Custom GPT discovery and chat
- Live model list pulled from your account — nothing hardcoded
- Streaming assistant text, tool calls, file search, citations, and generated images, all rendered properly
- File uploads and generated-image results
- Stop/cancel mid-response
- Markdown, GFM tables, code highlighting, and KaTeX math rendering
- Persistent conversation sidebar (SQLite-backed, encrypted credentials)
- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` (streaming + non-streaming)

**Not included by design:** support for multiple auth methods beyond the one session-token flow, and a solved Cloudflare Turnstile challenge (Mirror currently relies on the fact that ChatGPT doesn't always demand one — see [PROTOCOL.md](./PROTOCOL.md) for details on that gap).

## Security & storage

- Everything is scoped to `127.0.0.1` by default. Mirror checks the request `Host` header and rejects anything that isn't loopback (`localhost`, `127.0.0.0/8`, `::1`). It is **not** designed for remote or multi-user deployment — that would need TLS, real auth, CSRF protection, and a proper security review, not just a changed `HOST` value.
- Your session token and minted access token are encrypted at rest with AES-256-GCM, in a local SQLite database (`.data/mirror.db` by default).
- On first run Mirror generates `.data/master.key` (owner-only permissions) to encrypt that database. For production-style setups you can instead supply your own key via `MIRROR_STORE_KEY` (32 bytes, base64 or hex).
- The web playground keeps your bearer token in memory only. Prompt/message history isn't persisted unless you opt in via "Remember prompt history on this device," which stores it in browser `localStorage` — turn it back off to clear it.
- If you're upgrading from an older version that used a plaintext `.data/store.json`, Mirror migrates it into the encrypted database automatically and deletes the plaintext file once that succeeds.
- Nothing sensitive is ever written to logs.

### Configuration reference

| Variable            | Default                 | Purpose                                       |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `WARP_ACCEPT_TOS`    | (unset)                  | Must be `yes` — acknowledges Cloudflare's WARP terms before the tunnel will register |
| `MIRROR_PORT`        | `8799`                   | Host port for the combined WARP + Mirror stack (Compose) |
| `HOST`               | `127.0.0.1`               | Server bind address (direct/non-Compose runs) |
| `PORT`               | `8787`                    | Server port (direct/non-Compose runs) |
| `MIRROR_WEB_ORIGIN`  | `http://localhost:5173`   | Dev-mode CORS origin |
| `MIRROR_DATA_DIR`    | project `.data`           | Where the database and encryption key live |
| `MIRROR_STORE_KEY`   | auto-generated            | Fixed 32-byte database encryption key (base64 or hex) |
| `MIRROR_API_KEY(S)`  | unset                     | Require an application key for `/v1/*` (comma-separate for multiple) |

## Running without Docker

For development, or if you'd rather manage WARP yourself:

```sh
npm install
npm run dev        # server on :8787 (or configured PORT) + web dev server on :5173
```

`npm start` builds and runs the production server directly, but note it still performs the same WARP egress verification and will refuse to serve traffic without a working WARP tunnel in its network path — there's no supported way to bypass this check.

## HTTP API reference

Mirror's own REST/SSE API (used by the bundled web UI):

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
| `POST /api/chat` | Structured SSE chat stream (used by the web UI) |

Plus the OpenAI-compatible surface:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/models` | OpenAI-compatible model list |
| `POST /v1/chat/completions` | OpenAI-compatible completions (streaming and non-streaming) |

## Development & testing

```sh
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Tests cover SSE framing, conversation-tree/branch logic, encrypted credential storage, OpenAI-compatible request validation, and the loopback Host/origin policy. They never touch a live ChatGPT account — no credential is read or injected during the test run.

## Learn more

- [PROTOCOL.md](./PROTOCOL.md) — the reverse-engineered ChatGPT backend protocol Mirror implements against, including known gaps and open questions.
