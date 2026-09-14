# Mirror: 30 ways to make it way more awesomer

Free-associated 2026-09-14, deliberately not filtered down to "safe" ideas
first — filtering happens in conversation, not here. Every idea below is
checked against what Mirror actually is (a local, single-user, WARP-gated
proxy in front of chatgpt.com's private protocol, with a SQLite store and an
OpenAI-compatible shim) so nothing here secretly requires abandoning that
architecture. A few explicitly do NOT fit that architecture cleanly and say
so; they're included anyway because "would this actually work" and "is this
worth wanting" are different questions, and this file is for the second one.
Grouped by theme, not by priority — that's the next conversation.


**Status key, kept current as we go:** items get a short "Decided"/"Built" note
inline (like #3 below) the moment we act on them — either shipping something
or explicitly deciding not to. Undecided items have no such note.

## Identity & sessions

**1. Multiple concurrent ChatGPT accounts/sessions.** (Already TODO.md's
MIR-24.) Named sessions, an active-session switcher right in the Mirror
controls panel, separate conversation history per session. The biggest
single unlock for anyone running Mirror for more than themselves — a
household, a personal+work split — but it means `store.ts`'s schema,
`auth.ts`, and the singleton control-cookie model in `security.ts` all need
to stop assuming exactly one credential exists.

**2. One-tap "burner" session.** A session imported from a pasted token,
used for exactly one conversation, and cryptographically shredded (not just
soft-deleted) the moment the tab closes — never written to the database at
all, going further than the existing `private`/`ephemeral` flag by making
the *session itself* disposable, not just the conversation.

## Memory & context

**3. Local "standing instructions."** (TODO's MIR-25.) A user-editable note
that gets prepended to every *new* conversation's prompt context — Mirror's
own local answer to "memory," entirely within reach of the existing
`promptFor`/instructions machinery, no upstream protocol work needed.

**Built, 2026-09-14 — in a better shape than proposed above.** Rather than a
separate settings panel, the Playground's existing System box itself is now
the sticky field: it's saved account-wide server-side
(`GET`/`PUT /api/settings/default-system-instructions`, `store.ts`'s
`getDefaultSystemInstructions`/`setDefaultSystemInstructions`), so a new
conversation always starts from whatever you last left in it, on any
browser/device signed into this Mirror instance — no second concept to
learn, no localStorage. See README.md's Playground section.

**4. Auto-distilled topic notes.** Periodically (locally, using the model
itself in a background turn you approve) compress an old, inactive
conversation into a short standing note — "what we concluded," not the full
transcript — so a six-month-old conversation still informs new ones without
you having to re-read it or manually copy anything into #3.

**5. A per-conversation "why I started this" tag.** One sentence, set once,
shown in the conversation list next to the title — because ChatGPT's
auto-generated titles are often useless for remembering *why* you opened a
thread three weeks ago, and this needs no protocol work at all, just a
column and a text field.

## Organizing what you already have

**6. Folders, tags, and pinning.** (MIR-26.) Flat chronological lists stop
scaling around a few weeks of real use.

**7. A quick-open command palette.** (MIR-28.) `Cmd/Ctrl+K` over the search
endpoint that already exists (`/api/conversations/search`) — this is mostly
a missing UI affordance, not missing backend.

**Built, 2026-09-14.** `CommandPalette.tsx` is a `Cmd/Ctrl+K` overlay over
the existing `/api/conversations/search` endpoint - type-ahead search,
arrow-key navigation, Enter to jump straight into a conversation. Ended up
paired with a second, related feature: every hotkey in the app (currently
just this one) is now configurable and saved per-account server-side
(`GET`/`PUT /api/settings/hotkeys`, `hotkeys.ts`'s `DEFAULT_HOTKEYS`/
`matchesHotkey`/`describeHotkey`), editable from a new "Keyboard shortcuts"
panel (`HotkeySettings.tsx`) next to the other Playground utility panels -
so this and any future shortcut can be rebound or reset without touching
code. Didn't touch `openai.ts`'s conversation-continuation logic at all, as
planned. 100%-per-file coverage maintained.

**8. A cross-conversation branch atlas.** Not just one conversation's branch
tree (already improved per MIR-14) — a zoomable map of *every* conversation's
branch structure at once, so heavy editors/regenerators can see their whole
exploration pattern like a git log across every repo they've ever touched.

**9. A local activity heatmap.** A GitHub-contributions-style calendar of
message counts per day, built entirely from data already in SQLite — zero
new tracking, just a new view over existing rows.

## Multi-model & comparison

**10. Side-by-side compare mode in the Playground.** (MIR-29.) Same prompt,
Chat vs. Responses, or Custom GPT vs. base model, rendered next to each
other.

**11. Manual model fan-out.** Explicitly *not* an automatic `n>1` (Mirror
already, correctly, refuses to silently multiply usage) — but a Playground
button that lets you deliberately pick 2-3 models/GPTs and fire the same
prompt at each with one click, each a distinct visible action you chose,
with results diffed locally line-by-line.

**12. A prompt-variant lab.** Save named variants of a system prompt or
framing, re-run the same test question against each over time, and keep a
local scoreboard of which variant a *you* judged better — useful for anyone
doing real prompt engineering against Custom GPTs, and it's just structured
local storage plus the comparison UI from #10.

## Understanding your own history

**13. Local usage-pattern stats.** (MIR-27.) Turns/day, tool-invocation
frequency, response time — never fabricated tokens/cost, only what Mirror
already observes.

**14. A "read-through" digest mode.** For a long conversation, generate a
linear skim-friendly summary of the *path actually taken* through the
branch tree, so revisiting an old sprawling conversation doesn't mean
re-reading every edit and regeneration to find the thread that mattered.

**15. Tone/length drift markers.** A lightweight local heuristic (no extra
API call) that flags where a long conversation's tone or response length
visibly shifted — useful for noticing exactly where a Custom GPT's
"personality" started drifting from its instructions.

## Protocol resilience & developer tooling

**16. Fuzz the fixture corpus.** Building on MIR-31's new failure classifier
and the existing `sse.test.mjs` fixtures — generate structurally-mutated
variants of known-good captures (dropped fields, reordered patches,
truncated mid-token) and confirm the SSE reducer either handles them or
fails with a *classified* error, never a silent wrong answer.

**17. A standing protocol-drift watcher.** Take `scripts/protocol-canary.mjs`
(already built) and give it a cron mode that snapshots response *shapes*
(field names/types, never content) from real calls and diffs them against
the last snapshot, surfacing "backend-api's shape just changed here" before
it shows up as a mysterious user-facing failure.

**18. A rich-output renderer plugin system.** Right now new upstream event
types (tool calls, citations, widgets) get a renderer added to
`rich-output.ts` by hand each time. A small registered-renderer interface
would let new event kinds get a renderer without touching the core file -
useful the day ChatGPT ships some new in-chat widget type.

## Ecosystem & integration

**19. A real installable PWA.** (MIR-30.) Manifest + service worker for the
Playground, installable as a desktop icon, fully functional offline against
the local server — stays entirely inside the `127.0.0.1`-only boundary.

**20. An embeddable chat-panel SDK.** A tiny `<iframe>`-based widget other
local tools on your machine (a notes app, a personal dashboard) could embed
to get a Mirror-backed chat panel, authenticated the same origin-restricted
way the Playground already is.

**21. Mirror-as-an-MCP-server.** Genuinely fun one given what tool you're
reading this in right now: expose Mirror's own conversation engine as an MCP
server, so Claude Code / Claude Desktop / any MCP client could drive a real
ChatGPT conversation through Mirror as a callable tool. Recursive in a
pleasing way - the thing built to mirror ChatGPT becomes reachable by the
same protocol its own tooling runs on.

**22. Local automation webhooks.** Fire a `localhost`-only webhook when a
turn matches a pattern you configured (assistant returned code, an image
was generated, a specific keyword appeared) - opt-in, sanitized, and
strictly local, for wiring into something like Home Assistant or a personal
n8n instance without ever leaving your machine.

## Multi-modal & creative

**23. Local text-to-speech read-aloud.** Not "voice mode" (structurally
unbridgeable per COMPATIBILITY.md - that needs a real upstream audio
pipeline) - just a local TTS engine reading the *already-received* text
reply aloud. A real, honest partial answer to the voice gap rather than
faking the real thing.

**24. A generated-image gallery.** Every in-chat DALL-E image across every
conversation, currently buried inline in whichever conversation it was
generated in, aggregated into one browsable gallery view - the images and
metadata already exist in the store.

**25. A live sandbox-file browser.** When the code-interpreter sandbox
writes files mid-conversation, mirror them into a small local file browser
you can open directly, instead of only a download link inline in the
transcript.

## The genuinely trippy ones

**26. Séance mode.** Replay an old, favorite conversation as a live
re-enactment, typed out at its original cadence instead of appearing
instantly - for the specific pleasure of reliving a good exchange rather
than just re-reading it. (There's a `psychedelic_terminal.sh` sitting right
next to this repo in the parent folder - this is clearly an idea whose time
has already half-arrived.)

**27. Ambient token-stream visualization.** An optional generative-visual
backdrop behind the Playground that reacts to the actual cadence of
incoming stream deltas - not decoration for its own sake, but a literal
visualization of backend-api's real, otherwise-invisible timing behavior
(the same heartbeat/delta timing README.md already documents in prose).

**28. Conversation constellations.** A force-directed graph of your entire
conversation history, clustered by shared vocabulary/topics, for exploring
months of ChatGPT usage as a map instead of a list - the "read-through
digest" (#14) turned into something you navigate spatially instead of
reading top to bottom.

## Trust & data ownership

**29. A tamper-evident local audit log.** A hash-chained append-only log of
every credential/session/settings change Mirror makes to its own database,
so you can independently verify your local install wasn't silently modified
by anything else with filesystem access - a genuinely nice fit for a project
this security-conscious already.

**30. A one-click cold-storage archive.** Distinct from the existing
per-conversation export (MIR-15): a single encrypted archive of the *entire*
database - every account, conversation, and setting - meant for an offline
backup drive, not a re-import target. Storage-drill-tested the same way
`storage:drill` already tests backup/restore, but scoped to "get everything
off this machine safely" rather than day-to-day maintenance.

---

None of these are commitments - this is the wide net before the next
conversation narrows it down. Good next question once you've read through:
which handful excite you enough to actually want them running, versus which
ones were fun to imagine and can stay imaginary?
