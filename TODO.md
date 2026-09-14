# Mirror TODO

Audited 2026-09-14 across `apps/server`, `apps/web`, `packages/protocol`,
`README.md`/`PROTOCOL.md`/`COMPATIBILITY.md`/`RELEASE-RECOVERY.md`, and the prior
`TODO.md`/`NEXT-STEPS.md`. This file replaces the previous `TODO.md`; nothing
below is a regression — most prior P1 items (MIR-01 through MIR-19) were closed
out and are summarized under "Already solid" so this stays a forward-looking
backlog instead of a duplicate history.

**Update, same day:** MIR-20/21/22 (release/CI verification), MIR-31/32/34/35
(protocol resilience and operability) were worked in a follow-up pass — see
each item for what actually changed vs. what's still open. MIR-23 and MIR-33
remain genuinely open (one needs a live account, the other needs its own
dedicated pass, not a rushed one); MIR-24 through MIR-30 (the feature ideas)
were deliberately left alone pending a separate conversation about which of
them to actually build.

No inline `TODO`/`FIXME`/`HACK` markers exist anywhere in `apps/server/src`,
`apps/web/src`, or `packages/protocol/src` — the codebase doesn't leave debt
lying around in comments, which made this pass about design gaps and unbuilt
features rather than code-level cleanup.

**Confirmed** = an observable gap in the code/docs as they stand today.
**Verify** = needs investigation before treating it as real.
**Enhancement** = optional product work, ranked by payoff.
Effort: S / M / L as before.

## Already solid — don't relitigate

- Encrypted-at-rest credentials, loopback-only binding, mandatory WARP egress,
  redacted logging, and a documented threat boundary (README "Security &
  storage").
- 100%-per-file line/branch/function coverage gate (`c8`, `.c8rc.json`) across
  server, web, and protocol packages, with 500+ unit tests plus a real
  cm-subprocess contract test (`todo-contract.test.mjs`).
- A generated OpenAPI 3.1 document driven off the same Zod schemas the routes
  validate against (no hand-maintained spec to drift).
- Numbered transactional DB migrations with a stored schema version, a
  restore/backup drill (`storage:drill`), and `RELEASE-RECOVERY.md`.
- Structured `/v1` error shape (`api-errors.ts`), deadlines/cancellation
  (`deadlines.ts`), diagnostics (`GET /api/diagnostics`), search/export
  (`GET /api/conversations/search|:id/export`), and a capability-discovery
  endpoint (`GET /v1/capabilities`).
- `COMPATIBILITY.md` is unusually honest about what's structurally impossible
  vs. merely unimplemented — keep that tone; don't let future edits soften it
  into marketing language.

## P1 — Close out what's already in flight

- [x] **MIR-20 · Verify · S — Confirm the working tree is actually release-clean.**
  **Evidence (2026-09-14):** ran `npm run typecheck && npm run coverage &&
  npm run manifest` on base `e25cae9` (clean at the time); recorded in
  RELEASE-RECOVERY.md's new "Tested revision" section. Not from a from-scratch
  `npm ci` - `npm install` was used to pull in a missing platform-specific
  optional dependency (see MIR-21) - so a truly clean-checkout run is still
  worth doing once, but every check passed against the real working tree.
- [ ] **MIR-21 · Enhancement · M — Run the Playwright/browser suite for real.**
  **Progress (2026-09-14):** the `apps/web` unit test runner now actually
  runs (previously always skipped as "can't run here") - the real blocker was
  a stale mac-only `node_modules` missing the Linux `rolldown`/`esbuild`
  native bindings, fixed with `npm install` (adds the missing platform
  package without a full reinstall) plus clearing permission-locked stale
  `dist` output (see `device_request_delete_permission`). With that fixed,
  `npm run coverage` now genuinely executes all 99 web tests alongside the
  server/protocol suite - no more "verified by manual tracing." Playwright
  itself downloads and launches Chromium fine, but its headless shell needs
  system shared libraries (`libXdamage.so.1` etc.) this sandbox has no root
  access to install (`sudo` is blocked here). **Still open:** run
  `npm run test:e2e` on the real Mac (which has normal library access) and
  record the result; wire both suites into `.github/` CI so this doesn't
  depend on remembering to do it locally.
  **Update (2026-09-14):** `.github/workflows/ci.yml` exists and enforces
  exactly this (typecheck, 100% coverage, build, `storage:drill`, real
  Playwright e2e, manifest check) - but GitHub Actions on this account is
  currently blocked by an unpaid-invoice suspension, so it can't run. Rather
  than leave a permanently-red/misleading CI badge on `README.md`, tried
  Cirrus CI first (`.cirrus.yml`) but Jeremy's location couldn't reach
  cirrus-ci.org/com at all (`ERR_CONNECTION_CLOSED`), so switched to
  CircleCI instead - `.circleci/config.yml` (kept the same scope: typecheck,
  coverage, build, `storage:drill`, Playwright e2e, manifest check). CircleCI
  is a long-established provider with a generous open-source free tier
  (400,000 Linux credits/month at last check) and bills independently of
  GitHub Actions. **Still needs a human step:** sign in at
  https://circleci.com/vcs-authorize/ and connect the `defcron/mirror` repo -
  Claude can't do that (needs Jeremy's GitHub login) - after which the badge
  in `README.md` goes live. The old `.github/workflows/ci.yml` "container"
  job (build the Docker image, verify it offline) wasn't ported to either
  service yet - worth revisiting once the basic CircleCI config is confirmed
  working.
- [x] **MIR-22 · Verify · S — `npm audit` and dependency freshness.**
  **Evidence (2026-09-14):** `npm audit` reports 0 vulnerabilities. `npm outdated`
  shows mostly minor/patch drift (Fastify 5.12.3->5.12.4, `@fastify/rate-limit`
  10.x->11.x, `yaml`, `mdast-util-from-markdown`, `vite` 8.2->8.3) plus a few
  deliberately-not-blindly-bumped majors (React 18->19, Zod 3->4, TypeScript
  5->7, `undici` 7->8) that would need real compatibility review, not a
  version-number edit - left alone this pass. Note: this sandbox's own Node is
  v22, while `package.json` pins `>=24 <25`; that's this sandbox's own
  toolchain, not evidence about what the real dev machine runs - worth a
  glance but not treated as a repo bug here.
- [ ] **MIR-23 · Enhancement · S — Finish the live acceptance checklist.**
  Still genuinely open - this needs a real ChatGPT account and a real browser
  session, which this environment cannot provide safely (and shouldn't try
  to: putting session credentials in an automated pass is exactly what
  RELEASE-RECOVERY.md and NEXT-STEPS.md warn against). `scripts/protocol-canary.mjs`
  (new this pass, see MIR-32) covers the read-only half of this on demand -
  run `npm run protocol-canary` against a live instance for a sanitized
  health/model-discovery check - but the actual Custom GPT/Project/ChatGPTBox
  checklist still needs a person, once, with a real account.

## P2 — Real feature gaps worth building

- [ ] **MIR-24 · Enhancement · L — Multiple concurrent ChatGPT accounts/sessions.**
  Mirror is architected around exactly one saved session token. Anyone running
  it for more than personal single-account use (a small team each with their
  own ChatGPT account, or one person cycling between a personal and a work
  account) currently has to run separate Mirror instances entirely. A
  multi-session model — named sessions, an active-session selector in the
  Mirror controls panel, per-session conversation history — would be one of
  the highest-value "awesomer" features, but it's genuinely L-effort: it
  touches `store.ts`'s schema, `auth.ts`, and the control-cookie model in
  `security.ts`, all of which currently assume a singleton credential.
- [ ] **MIR-25 · Enhancement · M — A real memory/context feature.**
  `COMPATIBILITY.md` lists ChatGPT's cross-conversation memory as "not exposed
  through Mirror at all yet." Even without touching ChatGPT's own memory
  system, Mirror could offer its own local equivalent: a small
  user-maintained "standing instructions" note (distinct from per-conversation
  system messages) that gets prepended to every new conversation's prompt
  context, editable from the Playground. This is fully within reach of the
  existing `promptFor`/instructions machinery in `conversation-context.ts` and
  doesn't require any new upstream protocol work.
- [ ] **MIR-26 · Enhancement · M — Conversation folders/tags/pinning.**
  `ConversationTools.tsx` has search and export, but no organization beyond a
  flat, presumably chronological list. Once someone has weeks of conversation
  history, a flat list stops scaling. Tags or folders, plus pinning frequently
  reused conversations (a repeated coding-assistant thread, say) to the top,
  would meaningfully improve the "workspace" feel `NEXT-STEPS.md` already
  flags as the top P2 UX priority.
- [ ] **MIR-27 · Enhancement · M — Usage/cost-adjacent insights.** Mirror
  correctly refuses to fabricate token counts (there's no upstream field for
  it), but it could still track and surface things it *does* know locally:
  turns per day, average response time, tool-invocation frequency (web search
  vs. code interpreter vs. image gen), and per-conversation message counts —
  all derivable from existing stored events without inventing numbers ChatGPT
  never reports. Surface this as a small stats panel in the Playground, framed
  honestly as "local usage patterns," never as "cost" or "tokens."
- [ ] **MIR-28 · Enhancement · S/M — Keyboard-driven conversation switcher.**
  `NEXT-STEPS.md` already calls for "branch-tree keyboard navigation" for the
  branch viewer; extend the same idea to conversation switching itself — a
  quick-open palette (`Cmd/Ctrl+K`-style) over the existing search endpoint,
  since the backend (`/api/conversations/search`) already exists and only the
  UI affordance is missing.
- [ ] **MIR-29 · Enhancement · M — A "compare responses" mode in the Playground.**
  Since Mirror already supports both Chat and Responses modes against the same
  conversation engine, a side-by-side view that sends one prompt through both
  API shapes (or through two different models, e.g. comparing a Custom GPT's
  output against the base model) would make the Playground more useful as an
  actual testing tool, not just a bearer-token smoke test page.
- [ ] **MIR-30 · Verify · S — PWA / installable app framing for the web UI.**
  Mirror explicitly targets `127.0.0.1` only and that's correct to keep — but
  within that constraint, a manifest.json + service worker for the Playground
  (installable as a desktop app icon, works fully offline against the local
  server) is a small, self-contained enhancement that doesn't touch any of the
  security boundaries `NEXT-STEPS.md` warns against loosening.

## P3 — Protocol-resilience and operability (still open from NEXT-STEPS.md)

- [ ] **MIR-31 · Enhancement · L — The sanitized capture/replay fixture format.**
  **Progress (2026-09-14):** the classification half is done -
  `packages/protocol/src/drift.ts`'s `classifyProtocolFailure()` sorts any
  backend-api failure into exactly the four categories NEXT-STEPS.md asked
  for (authentication-challenge, transport-truncation, known-upstream-error,
  unsupported-shape), fully unit-tested (`drift.test.mjs`), and wired into
  `openai.ts`'s error handler so every recorded failure now carries this
  category in `GET /api/diagnostics`'s `recentFailures` alongside the
  existing HTTP-status categorization - without ever touching the public
  response shape or exposing the raw upstream payload. **Still open:** the
  other half of MIR-31, a schema-tolerant, provenance-tagged capture/replay
  *fixture format* (capture date, endpoint, sanitization version) for
  `sse.test.mjs`'s fixtures - this pass added failure classification, not a
  new fixture format.
- [x] **MIR-32 · Enhancement · M — Opt-in live protocol canary.**
  **Evidence (2026-09-14):** `scripts/protocol-canary.mjs` (`npm run
  protocol-canary`) checks health, diagnostics, and model discovery against a
  running Mirror instance by default (read-only, hits Mirror's own already-
  sanitized `/api/*` routes rather than reimplementing credential handling),
  and only sends one real, disposable `/v1/chat/completions` turn when
  `--generate` is passed explicitly - reporting success/timing/finish_reason
  only, never the prompt or reply text. Emits one JSON report suitable for
  attaching to an issue. Not wired into CI (it needs a live account by
  design) - that's intentional, not a gap.
- [ ] **MIR-33 · Enhancement · L — Continue the `openai.ts`/`store.ts`/`index.ts`
  decomposition.** Not attempted this pass - `openai.ts` (now ~1070 lines
  after MIR-31's small addition), `store.ts` (877), and `index.ts` (~610) are
  unchanged in structure. This is real, deliberately deferred risk: a big
  incremental extraction done quickly to check a box is exactly how you
  introduce the kind of subtle continuation/persistence bug this codebase's
  own regression suite exists to catch. `NEXT-STEPS.md` section 4 still has
  the right target split (schemas/adapters, conversation resolution,
  transport writers, route registration for `openai.ts`; schema/credentials/
  conversations/maintenance repositories behind an interface for `store.ts`).
  Worth doing as its own dedicated pass, one extraction at a time, each
  verified by the full suite - not squeezed in alongside other work.
- [ ] **MIR-34 · Enhancement · M — Structured operability logs.**
  **Progress (2026-09-14):** fixed a real, confirmed gap found while working
  on this - `openai.ts`'s failure handler only called `recordFailure()` (the
  existing failure-category counter behind `GET /api/diagnostics`) on the
  *streaming* branch; a non-streaming completion that failed upstream was
  never counted at all. `recordFailure()` now runs unconditionally before the
  stream/non-stream branch, and now also records the MIR-31 protocol-drift
  category alongside the existing HTTP-status code (see `preflight.test.mjs`
  / `openai-routes.test.mjs`'s new drift-taxonomy test). **Still open:** the
  bigger ask from `NEXT-STEPS.md` #5 - per-request structured logs with
  route/duration/conversation-operation/upstream-phase/deadline-phase fields -
  is unbuilt; Fastify's own default request logger already gives request
  ID/route/duration/status for free (with the existing redacted serializer),
  but the Mirror-specific semantic fields (new vs. continue vs. rebase,
  which upstream/deadline phase a failure happened in) still need threading
  through `chat-service.ts`/`openai.ts`, which touches enough call sites to
  be its own careful pass rather than a quick addition.
- [x] **MIR-35 · Enhancement · S — Startup preflight diagnostics.**
  **Evidence (2026-09-14):** `apps/server/src/preflight.ts`'s
  `classifyStartupFailure()`/`formatStartupFailure()` turn a failed boot into
  one categorized, actionable line - configuration (bad `MIRROR_STORE_KEY`),
  database-migration (incompatible schema version), warp-egress (WARP
  unreachable/not verified), or port-in-use (`EADDRINUSE`) - instead of a raw
  unhandled-rejection stack trace; wired into `index.ts`'s entrypoint
  try/catch. Fully unit-tested (`preflight.test.mjs`) plus an end-to-end
  startup test exercising the real catch/exit(1) path (`startup.test.mjs`'s
  new "a failed bind... is classified" test). Scoped honestly: missing-
  browser-dependency and session-expiry are real failure modes but don't
  actually happen *at boot* in the current code (the Turnstile browser
  solver launches lazily on first use; session validity is only checked on
  the first proxied/API request) - both already surface their own next-action
  text through `GET /api/diagnostics` (MIR-09) once a request actually hits
  them, so this doesn't pretend to preflight-check something Mirror doesn't
  check yet.

## P3 — Documentation follow-ups

- [ ] **MIR-11 (carried over) · Enhancement · M — Re-audit `COMPATIBILITY.md`'s
  absolute claims.** Never fully closed in the prior pass beyond README
  changes. Worth a line-by-line pass now that MIR-20/21/22/23 land: confirm
  every "not supported"/"structurally impossible" claim still matches the
  actual `openai.ts`/`sse.ts` behavior, since both files have changed since
  some of that prose was written.
- [ ] **MIR-36 · Enhancement · S — A CHANGELOG.md.** The repo has extensive
  point-in-time progress notes scattered across `TODO.md`, `NEXT-STEPS.md`,
  and regression-specific docs (`ASSET-RENDERING-REGRESSION.md`,
  `CONTINUATION-REGRESSION.md`), but nothing chronological and user-facing.
  Once MIR-18's release/versioning work lands, a real changelog would make
  upgrades legible without reading five different audit documents.

## Shared work with cm

- [ ] **MIR-19 (carried over) · Verify · M — Write the actual shared streaming/
  persistence contract doc.** The behavior is now pinned down as executable
  tests (`todo-contract.test.mjs`), but the prior pass explicitly noted "an
  actual written doc... weren't touched this pass" is still open, and so is
  reconciling this with cm's own CM-01/02/16 items in its separate TODO.md.

---

Remaining open work, roughly in order: MIR-21 (run the real Playwright suite
on the actual Mac and wire both suites into CI), MIR-23 (the live acceptance
checklist - needs a person and a real account), MIR-33 (the file
decomposition - deliberately not rushed), then the rest of MIR-34 (full
per-request structured logs) and the fixture-provenance half of MIR-31.
After that: whichever P2 feature idea (MIR-24 through MIR-30) you actually
want Mirror to become — that's the next conversation.
