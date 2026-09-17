# Mirror

[![CircleCI](https://circleci.com/gh/defcron/mirror.svg?style=svg)](https://circleci.com/gh/defcron/mirror) [![GitHub Actions CI](https://github.com/defcron/mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/defcron/mirror/actions/workflows/ci.yml) [![Coverage](https://codecov.io/github/defcron/mirror/branch/main/graph/badge.svg)](https://app.codecov.io/github/defcron/mirror) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.nvmrc)

Mirror is a self-hosted ChatGPT client and OpenAI-compatible API. Its web interface serves the official ChatGPT application through a local proxy, so conversations and Custom GPTs use your ChatGPT account without an OpenAI API key or browser automation. Mirror also provides a Playground, conversion tools for four file formats, and a REST/SSE API.

> **Unofficial project:** Mirror relies on ChatGPT's private web protocol, which may change without notice. It is designed for local use. See [PROTOCOL.md](PROTOCOL.md) for implementation details and known limitations.

## Quick start

You need Docker and an active ChatGPT account in your browser.

1. Copy your session token from [ChatGPT's session page](https://chatgpt.com/api/auth/session) while signed in.
2. Configure and start Mirror:

   ```sh
   cp .env.example .env
   # Read Cloudflare's WARP terms, then set WARP_ACCEPT_TOS=yes in .env.
   docker compose up --build
   ```

3. Open [http://127.0.0.1:8799](http://127.0.0.1:8799). Select **Mirror controls** in the ChatGPT sidebar, paste the token, and choose **Save & reload**.

Mirror stores the credential encrypted on the local server and uses it to obtain short-lived access tokens. The controls panel also reports connection and WARP status and links to the Playground, API documentation, and decoder challenges.

### Network requirements

All outbound traffic must use the bundled Cloudflare WARP tunnel. Mirror checks the tunnel before serving requests and periodically while running; it does not fall back to a direct connection. This keeps outbound traffic on a verified egress path and avoids the 10-second request limit of Cloudflare's local-proxy mode. WARP does not provide a fixed IP or resolve account restrictions.

## ChatGPT features

Mirror proxies the official ChatGPT interface rather than rebuilding it. ChatGPT account features such as conversation history, Custom GPTs, branching, editing, regeneration, uploads, generated images, Markdown, and KaTeX remain available through the proxy.

Mirror adds **Decoder challenges** to the controls panel. Create a challenge in LoaF, PngSpeak, gptgif, or gptgif v4, then ask GPT to decode the artifact. You can insert the prompt into the composer, copy it, or download it with the artifact. Optional downloadable kits include one file and prompt per format. After GPT replies, Mirror can check its answer against a temporary server-side key. Keys expire after 24 hours, a server restart, or a session change; Mirror retains at most 64 active challenges and allows 20 generations per minute. See the API docs for the complete challenge routes and limits.

## Playground and conversion API

Open **API tester** in Mirror controls or visit [http://127.0.0.1:8799/mirror/playground](http://127.0.0.1:8799/mirror/playground). The Playground exercises `/v1/chat/completions` and `/v1/responses` without a separate client. Chat mode supports text and file/image attachments; Responses mode currently accepts text only. Conversation history can be continued through Mirror's conversation ID.

The conversion API exposes LoaF, PngSpeak, gptgif, and gptgif v4 under `/api/convert/*`. It accepts JSON with base64 payloads by default, or raw bytes through `raw_in`, `raw_out`, and `raw` query options. The original gptgif format requires a calibrated cluster map to decode. The API reference at `/mirror/api-docs` is generated from the running server and includes current request schemas and responses.

## OpenAI-compatible API

Set an OpenAI SDK's base URL to `http://127.0.0.1:8799/v1`. For example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8799/v1",
    api_key="your-mirror-api-key",
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

Mirror provides `GET /v1/models` and `POST /v1/chat/completions` (streaming and non-streaming). The supported request fields and known differences from OpenAI are documented in [COMPATIBILITY.md](COMPATIBILITY.md). Mirror does not call `api.openai.com`; `OPENAI_API_KEY`, when set, is accepted as an inbound Mirror API key.

Programmatic clients must set `MIRROR_API_KEY`, `MIRROR_API_KEYS`, or `OPENAI_API_KEY`. Browser navigation to Mirror's root or Playground establishes a same-origin control cookie for the browser UI. API keys do not replace the ChatGPT session token.

Generate a random API key with:

```sh
npm run gen-api-key
```

Set the printed value in `.env` as `MIRROR_API_KEY`. The command does not modify `.env` automatically.

## Run without Docker

For development, use Node.js 24:

```sh
nvm use
npm ci
npm run dev
```

This starts the server on `127.0.0.1:8787` and the web development server on port `5173`. A direct `npm start` runs the production server on `HOST:PORT` (defaults `127.0.0.1:8787`) and still requires a working WARP tunnel.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WARP_ACCEPT_TOS` | unset | Set to `yes` after reviewing Cloudflare's WARP terms. Required for startup. |
| `MIRROR_PORT` | `8799` | Host port for Docker Compose. |
| `HOST` | `127.0.0.1` | Bind address for a direct, non-Compose run. |
| `PORT` | `8787` | Port for a direct, non-Compose run. |
| `MIRROR_WEB_ORIGIN` | `http://localhost:5173` | Web origin used for development CORS. |
| `MIRROR_DATA_DIR` | `.data` | Directory for the SQLite database and generated encryption key. |
| `MIRROR_STORE_KEY` | generated | Optional 32-byte key (base64 or hex) for encrypting credentials at rest. |
| `MIRROR_API_KEY` | unset | Inbound API key for programmatic access. |
| `MIRROR_API_KEYS` | unset | Comma-separated set of accepted inbound API keys. |
| `OPENAI_API_KEY` | unset | Additional inbound API key; not an OpenAI service credential. |

Compose uses `MIRROR_PORT`; direct runs use `HOST` and `PORT`. These settings are independent.

## Security and data

Mirror binds to loopback by default and rejects non-loopback hosts. It is not designed for remote or multi-user deployment. A remote deployment would require additional authentication, TLS, CSRF defenses, and a security review.

Session and minted access tokens are encrypted at rest with AES-256-GCM in `.data/mirror.db` by default. Mirror creates `.data/master.key` with owner-only permissions, or you can provide `MIRROR_STORE_KEY`. Conversation text, instructions, and events are stored locally without encryption. Request logs redact common credential headers, but should still be treated as sensitive.

Backups may contain plaintext conversations and instructions, encrypted credentials, and the generated master key. Protect the complete backup and retain a supplied `MIRROR_STORE_KEY` separately. Example maintenance commands:

```sh
npm run storage -- backup /absolute/path/to/backup
# Stop Mirror before restoring or pruning.
MIRROR_DATA_DIR=/absolute/path/to/new-data npm run storage -- restore /absolute/path/to/backup --offline
npm run storage -- prune 90 --offline
```

Restore does not overwrite an existing database. Pruning deletes local conversations older than the selected age; it does not affect ChatGPT history or revoke credentials. See [RELEASE-RECOVERY.md](RELEASE-RECOVERY.md) for schema compatibility and restore procedures.

## Development and tests

```sh
npm run typecheck
npm test
npm run coverage
npm run build
npm run test:e2e
npm run manifest -- --check
```

`npm run coverage` requires 100% statements, branches, functions, and lines in every application source file and writes `coverage/lcov.info`. GitHub Actions uploads that report to Codecov after the coverage gate passes; the badge above displays the measured line coverage from the uploaded test report. To enable uploads, connect the public repository to Codecov and add its repository upload token as the `CODECOV_TOKEN` GitHub Actions secret. Public open-source projects can use Codecov's free plan. Tests use isolated storage and synthetic upstream responses; they do not validate compatibility with a live ChatGPT account. Browser smoke tests run separately through Playwright. Every test must be inside a named `test.describe(...)` suite; `npm run test:suites` checks this rule.

Regenerate `SHA256-MANIFEST.json` after changing tracked source or configuration:

```sh
npm run manifest
```

## API overview

Mirror provides local control routes, conversion routes, decoder-challenge routes, and the OpenAI-compatible API. The generated OpenAPI document is available at `/mirror/openapi` (JSON) and `/mirror/openapi?format=yaml` (YAML); browse it at `/mirror/api-docs`.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Health, configuration, and egress status |
| `POST /api/session` | Verify and save a ChatGPT session token |
| `GET` / `DELETE /api/session` | Inspect or remove the saved session |
| `/api/conversations/*` | Create, list, load, branch, stop, and delete conversations |
| `POST /api/files` | Upload an attachment |
| `/api/convert/*` | Encode, decode, verify, and calibrate supported formats |
| `/api/decoder-challenges/*` | Generate and check decoder challenges and downloadable kits |
| `GET /v1/models` | List available models in OpenAI-compatible form |
| `POST /v1/chat/completions` | Create streaming or non-streaming completions |

## Project notes

- [PROTOCOL.md](PROTOCOL.md): ChatGPT protocol implementation, known gaps, and open questions.
- [COMPATIBILITY.md](COMPATIBILITY.md): OpenAI API compatibility details.
- [TODO.md](TODO.md): issue-level project backlog.
- [NEXT-STEPS.md](NEXT-STEPS.md): repository audit roadmap.
