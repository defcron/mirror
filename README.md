# Mirror

Mirror is a local, modern ChatGPT Web client and OpenAI-compatible adapter. It uses a user-supplied ChatGPT `sessionToken` to mint short-lived access tokens server-side and talks to `chatgpt.com/backend-api`. It does not use an OpenAI API key or browser automation.

This is an unofficial, protocol-dependent project. ChatGPT Web endpoints can change without notice. Keep Mirror bound to localhost unless you have separately designed and reviewed a trusted deployment.

## What is implemented

- Correct ChatGPT conversation-tree continuity using the final assistant node as the next `parent_message_id`
- `conversation/init` defaults, limits and blocked-feature capture
- capability/error-driven two-stage follow-up conduit flow
- first-class Custom GPT discovery, selection and `gizmo_interaction` mode
- structured stream events for assistant text, tools, file search, citations, images, markers and status
- live account model discovery—no model slug is hardcoded into the interface
- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`, streaming and non-streaming
- intelligent OpenAI history mapping: known message prefixes continue the real ChatGPT node; unknown histories are supplied as explicit context
- persistent conversation sidebar, switching, deletion, branching, editing and regeneration
- Markdown, code, GFM tables and KaTeX math rendering
- file upload, persistent file metadata, attachment chips and generated-image results
- stop/cancellation plumbing from the browser through the upstream request
- production static serving from the Fastify server
- SQLite persistence, account-scoped records, AES-256-GCM credential encryption, redacted request logging, rate limiting and health checks
- optional application API-key protection for `/v1/*`
- mandatory, container-scoped Cloudflare WARP egress with a fail-closed startup check

Auth expansion is intentionally not included. The original one-`sessionToken` workflow remains the only account connection mode.

## Run

WARP is mandatory. Mirror will not start on a direct network path. The bundled Compose stack puts Mirror and the official Cloudflare WARP Linux client in one network namespace. This routes session minting, ChatGPT backend calls, proxied web-app requests, uploads, and streamed responses through the same WARP tunnel. The WARP registration and Mirror database are stored in separate persistent Docker volumes.

Cloudflare's Local proxy mode is deliberately not used: Cloudflare documents a 10-second request limit for that mode, which is unsuitable for long streamed generations. The stack instead uses full WARP mode with MASQUE and verifies Cloudflare's `warp=on` trace signal before Mirror starts.

First copy the example configuration and explicitly acknowledge Cloudflare's applicable WARP terms:

```sh
cp .env.example .env
# Edit .env and set WARP_ACCEPT_TOS=yes after reviewing the terms.
docker compose up --build
```

Then open `http://127.0.0.1:8799`. The WARP container owns the published port because the Mirror container shares its network namespace. `GET /api/health` reports only non-sensitive egress state:

```json
{
  "ok": true,
  "egress": {
    "mode": "warp",
    "required": true,
    "verified": true,
    "checkedAt": "...",
    "error": null
  }
}
```

If the tunnel is unavailable or Cloudflare's trace endpoint does not report `warp=on`, Mirror refuses to start. It rechecks every 30 seconds and stops if verified WARP egress is lost, preventing a quiet direct-network fallback. Running `npm start` outside the WARP network namespace fails the same verification and is not a supported bypass.

WARP changes the network path; it does not guarantee a fixed public IP and must not be treated as a way to defeat an account restriction. If ChatGPT has already placed a security hold on the account, use ChatGPT's official account-security/recovery flow before resuming requests. Repeated automated retries can make the signal worse.

## OpenAI-compatible use

Point an OpenAI client at `http://127.0.0.1:8787/v1`. If `MIRROR_API_KEY` is unset, any placeholder API key works while the server remains localhost-only.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

To require an application key for `/v1/*`:

```sh
MIRROR_API_KEY='replace-with-a-long-random-value' npm start
```

Multiple accepted keys can be supplied as a comma-separated `MIRROR_API_KEYS` value. These are Mirror application keys, not OpenAI API keys.

## Storage and security

The default database is `.data/mirror.db`. The session and cached access token are encrypted with AES-256-GCM. On first run Mirror creates `.data/master.key` with owner-only permissions; production operators can instead provide a base64- or hex-encoded 32-byte `MIRROR_STORE_KEY`.

If the old plaintext `.data/store.json` exists, Mirror imports it into the encrypted database and removes the plaintext file after a successful migration. It never logs credential values. `.data`, environment files, build output and dependencies are excluded by `.gitignore`.

Useful configuration:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `8787` | Server port |
| `MIRROR_WEB_ORIGIN` | `http://localhost:5173` | Development CORS origin |
| `MIRROR_DATA_DIR` | project `.data` | Database/key directory |
| `MIRROR_STORE_KEY` | generated local key | 32-byte database encryption key |
| `MIRROR_API_KEY(S)` | unset | Protect OpenAI-compatible routes |

Do not expose Mirror on a public interface merely by changing `HOST`. A remote or multi-user deployment still needs TLS, a real identity boundary, managed key storage, an explicit trust model and operational review.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | database/configuration health |
| `POST/GET/DELETE /api/session` | verify, inspect or remove the local ChatGPT session |
| `GET /api/models` | normalized live account models |
| `GET /api/gpts` | normalized Custom GPT list |
| `GET/POST /api/conversations` | list or create chats |
| `GET/DELETE /api/conversations/:id` | load or delete a chat |
| `POST /api/conversations/:id/branch` | branch from an assistant node |
| `POST /api/conversations/:id/stop` | cancel an active response |
| `POST /api/files` | upload an attachment |
| `GET /api/assets` | resolve an authenticated generated asset |
| `POST /api/chat` | Mirror delta-only structured SSE chat stream |
| `GET /v1/models` | OpenAI-compatible model list |
| `POST /v1/chat/completions` | OpenAI-compatible completions |

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

The automated tests cover SSE framing across network/CRLF boundaries, inherited patch operations, final assistant-node extraction, tool/citation/image preservation, encrypted credential storage and persistent OpenAI prefix mappings. They do not send a live ChatGPT message because the test suite never reads or injects an account credential.

See [PROTOCOL.md](./PROTOCOL.md) for the observed upstream flow and compatibility assumptions.
