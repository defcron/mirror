# 30 ways to inject neat stuff into the real chatgpt.com UI (via Mirror)

Free-associated 2026-09-14, same rules as the original `BRAINSTORMING.md`:
not pre-filtered to "safe" ideas, but every entry is checked against what
Mirror can *actually* do to the real chatgpt.com page it's proxying, not
what would be neat in the abstract.

**The mechanism, for grounding:** `proxy.ts` splices `EARLY_PATCH`
(`browser-patch.ts`) into every proxied `text/html` response's `<head>` —
not just the root shell, every route (a conversation, `/c/<id>`, settings,
etc. all get it, since the check is just "is this response HTML"). Mirror
controls' own `injectionCss`/`injectionJs` are exported from
`mirror-controls.ts` and are just more CSS/JS strings riding along in that
same patch. So: anything doable as vanilla CSS/JS running inside the real
ChatGPT page, with no cooperation from OpenAI's own bundle, is fair game.
Two hard walls this list respects:

- **No reading React internals or private state.** Everything here works
  off the rendered DOM (`data-testid` hooks, text content, class-adjacent
  selectors) or Mirror's own server-side data (its SQLite store, the
  OpenAI-compatible shim), the same way `mirror-controls.ts` already finds
  `accounts-profile-button`. Nothing assumes access to ChatGPT's internal
  component props/state.
- **No fighting the composer or main content column for clicks/focus.**
  `mirror-controls.ts`'s own doc comment already flags this as the reason
  it mounts in-flow in the sidebar instead of floating — every idea below
  that adds visible UI either lives in that same sidebar slot, in a
  sidebar-adjacent row, or is inert-by-default (a keyboard shortcut, a
  toggle) until deliberately invoked.

Grouped by theme. A "Reach:" line on anything non-obvious says what it can
see/do given the DOM-only, server-observes-traffic constraints above.

## Sidebar & chrome

**1. Conversation folders/tags, client-side.** ChatGPT's own sidebar has no
folders. Add a tiny tag picker to each sidebar conversation row (a
right-click menu or a small icon that appears on hover) that writes
tags into Mirror's SQLite store keyed by conversation id, then a filter
bar above the list that hides/shows rows by tag. Reach: sidebar rows are
real DOM nodes with the conversation id in their href — no protocol
access needed, purely DOM + Mirror's own storage.

**2. Pinned conversations, actually enforced.** ChatGPT has a "pin" but
caps you around a handful. Mirror-side pin list (its own store), rendered
as a synthetic pinned section injected at the top of the sidebar list,
no upstream cap.

**3. Sidebar search that's actually fast.** ChatGPT's own conversation
search hits their backend per keystroke. Route the search box's queries
to Mirror's `/api/conversations/search` (the same endpoint the Playground's
`CommandPalette`/`ConversationTools` already use) instead, since Mirror
already has to see and can index the conversation list traffic passing
through it. Decided against duplicating this as a *second* box — better to
literally rewire ChatGPT's existing search input's event listener to hit
Mirror's endpoint instead of adding a competing UI element.

**4. The Playground's command palette, reused here.** `CommandPalette.tsx`
is a Cmd/Ctrl+K overlay over `/api/conversations/search` — nothing in it
is Playground-specific. Port the same component (or just the compiled
JS/CSS) into the injected bundle so Cmd+K quick-jump works on the real
site too, using the same configurable-hotkey settings panel idea from
`HotkeySettings.tsx`.

**5. A "which model actually answered" badge on each assistant message.**
ChatGPT's UI already shows this in small print sometimes but inconsistently
across surfaces (voice, temporary chats, etc.) Standardize it: a small
persistent chip on every assistant turn, always present, reading from
whatever DOM/metadata is already exposed per-message.

**6. Token/cost estimate ticker.** A running estimate in the Mirror-controls
panel of how many tokens the current conversation has used and roughly what
it would have cost via the API, computed from message text length with a
tokenizer bundled client-side (`tiktoken`-style, WASM) — approximate, and
labeled as such, but useful. Reach: pure client-side text analysis of
already-rendered messages, no upstream data needed.

## Reading & navigating long conversations

**7. In-page conversation minimap/outline.** A collapsible strip (anchored
in the sidebar-adjacent column, not floating over the composer) listing
every user prompt in the current conversation as a jump-to link — solves
the "scroll forever to find where I asked X" problem the user already
flagged as their motivation for the second Run button. Reach: DOM-only,
walks rendered message nodes for role="user" turns.

**8. Collapse/fold long assistant responses.** A fold toggle injected onto
any assistant message past some length threshold, so skimming a long
conversation doesn't mean scrolling past walls of text you've already
read. Client-side only, doesn't touch stored content.

**9. Read-time / turn-count stats per conversation**, shown in the sidebar
row on hover: turn count, rough total length, first/last message
timestamps. All derivable from the rendered list plus Mirror's own stored
copy of the conversation (if Mirror already logs traffic, no new fetch
needed).

**10. "Jump to last unread" marker** for conversations with a lot of
back-and-forth reopened after a while — a thin highlight bar client-side
persisted (Mirror's store, keyed by conversation id + last-viewed message
id) so returning to a long thread doesn't mean scrolling to guess where you
left off.

## Composer & prompting ergonomics

**11. Duplicate Run button pattern, generalized: prompt snippets/macros.**
A small "insert saved snippet" button in the composer row (same in-flow
placement approach as the second Run button already shipped) backed by a
Mirror-side saved-snippets list — reusable prompt fragments, boilerplate
instructions, etc., without ChatGPT's own limited "custom instructions."

**12. Draft autosave that survives a page reload/crash**, independent of
ChatGPT's own (sometimes lossy) draft persistence — mirror the composer's
`textarea`/`contenteditable` content into `localStorage` or Mirror's store
on every keystroke (debounced), restore on load if the composer comes back
empty. Reach: DOM input event listener only.

**13. A visible character/token counter under the composer**, since
ChatGPT doesn't show one live — same client-side tokenizer as #6, updated
on input.

**14. Multi-line prompt templates with fill-in blanks.** A small `{{var}}`
templating helper: type a saved template name, get prompted (a tiny inline
form) for the blanks, get the filled prompt inserted into the composer.
Pure client-side text substitution, no protocol involvement.

**15. Keyboard-driven "send to a specific model/mode" shortcuts**, mapped
through the same configurable-hotkeys settings panel already built for the
Playground — e.g. a hotkey that clicks whatever the current model-picker
UI needs clicked, so switching models doesn't require a mouse trip through
menus. Reach: DOM click-simulation on ChatGPT's own picker elements, same
technique already used to drive the sidebar-open forcing in
`mirror-controls.ts`.

## Export, backup & portability

**16. One-click "export this conversation" as Markdown/JSON**, injected as
a button near the conversation title — walks the rendered message DOM (or,
better, asks Mirror's own store for the canonical copy if it already has
one from proxied traffic) and downloads a file. This is squarely inside
what a DOM-only injected script can do since it's just reading + a
client-side `Blob` download, no upstream write needed.

**17. Bulk export / "back up everything" from the sidebar**, driven by
Mirror's server (it can enumerate the account's conversations via the
proxy) rather than the client scraping each one — a real server endpoint
Mirror already has the access pattern for, exposed as a button in the
injected controls panel.

**18. Auto-archive to Mirror's local store on every new message**, so a
full local copy of every conversation always exists independent of
OpenAI's retention/export flow — this is really "make Mirror's existing
traffic-observing role do something proactively", not new UI, but the UI
piece is a status indicator ("N conversations archived locally") in the
controls panel.

## Privacy, safety & control

**19. A visible "this request is going through WARP" indicator**, always-on
in the Mirror-controls panel (extending the existing egress/WARP status
line already in `injectionCss`), rather than something you have to open the
panel to check.

**20. Per-conversation "ephemeral" toggle surfaced right in the chat header**,
not buried in the Mirror controls popup — wires to the same private/ephemeral
flag `BRAINSTORMING.md` #2's burner-session idea already touches, just
promoted to a one-click header toggle for the common case (this
conversation specifically, not the whole session).

**21. A content filter / redaction pass on outgoing messages**, warns (does
not block, since Mirror shouldn't silently eat data) before sending if the
composer text matches user-defined patterns (an SSN-shaped string, a saved
"never send this" phrase list) — pure client-side regex check before the
send click is allowed through.

**22. Screenshot/copy-paste guard toggle**: a CSS-only mode that blurs the
page content until hovered/focused, for screen-sharing during a call
without exposing conversation history — trivial to inject as a CSS class
toggle, no JS logic needed beyond a keybind.

## Fun / cosmetic

**23. Theme packs beyond light/dark.** Mirror already injects CSS
unconditionally — nothing stops shipping a small set of alternate color
schemes (the user's `psychedelic_terminal.sh` energy, if they want it) as
selectable presets in the controls panel, applied via CSS custom-property
overrides scoped to ChatGPT's own theme variables where they're exposed,
or brute-force selector overrides where they're not.

**24. Custom favicon/tab title that reflects state** — e.g. changes when a
response is still streaming vs. done, so a backgrounded tab tells you when
to come back. Reach: trivial, `document.title` + a dynamically swapped
`<link rel="icon">`, both fully within a content script's reach.

**25. A "conversation soundtrack" toggle** — genuinely silly, flagged as
such: a tiny ambient audio loop that plays while a response is streaming
and stops when it's done, as an audible alternative to watching the
spinner. Purely client-side `<audio>`, off by default.

**26. Achievement/streak tracker** for personal use — total conversations,
longest thread, days-in-a-row used — computed from Mirror's own local
conversation log, shown as a small stats card in the controls panel. Not
gamifying anything upstream, just a fun readout of your own local history.

## Power-user / integration

**27. Slash-command style local commands in the composer**, e.g. typing
`/export`, `/model`, `/pin` as the first token of a message triggers the
matching injected feature instead of being sent as a prompt — a thin
client-side intercept on the send action that checks for the prefix before
letting the real send through.

**28. Webhook/notification on response completion**, for long-running
responses where you've alt-tabbed away — Mirror's server already sees the
streamed response finish (it's proxying it), so it can fire a local
notification (or ping something like a self-hosted ntfy endpoint the user
configures) without any client-side polling.

**29. A "diff this edit" view when you edit-and-resend a prompt.** ChatGPT
lets you edit a previous message and regenerate, but doesn't show what
changed vs. the original inline afterward. Inject a small expandable diff
(computed client-side, since both versions are just text already in the
DOM/Mirror's stored history) between the edited message and its previous
version.

**30. Mirror-controls "recipes": one-click multi-step actions.** A small
scriptable-macro slot in the controls panel — e.g. "new chat, paste
standing instructions (#3 from the original list), switch to model X" as
one button — composed from the same DOM-click/composer-fill primitives
several ideas above already need individually. This is really the
generalization that #11/#14/#15 all become presets of, once two or three
of them exist.

---

None of these need anything OpenAI would have to cooperate with — every
one is either pure client-side DOM/CSS/JS riding in the existing
`EARLY_PATCH`/`mirror-controls` injection point, or a Mirror server
endpoint acting on traffic it's already proxying. The honest caveat that
applies to literally all of them: ChatGPT's frontend bundle changes without
warning, and anything keyed to a `data-testid` or DOM shape can silently
break on their next deploy — exactly the maintenance burden
`mirror-controls.ts`'s periodic re-assertion interval already exists to
paper over for the one widget that exists today. More injected surface
area is more of that same maintenance tax, not a new kind of risk.
