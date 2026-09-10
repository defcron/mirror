# Generated asset rendering and downloads

Validated locally on 2026-09-10 against ChatGPTBox commit `d47f875aaeb5bf8e7464fcf60c404fef759dee73` from https://github.com/ChatGPTBox-dev/chatGPTBox.

## Cause and behavior

The previous output linked directly to signed ChatGPT Estuary URLs. A fresh URL returned HTTP 403 without authentication and HTTP 200 with the saved upstream session. ChatGPTBox's special handling of `chatgpt.com` links also uses a clickable span instead of a normal anchor. A first replacement with loopback image URLs failed Chromium's Local Network Access restriction on the controlled HTTPS search-page fixture.

Mirror now obtains preview bytes server-side and embeds standard Markdown image data URIs. Generated files use `Download file: [actual filename](<Mirror file URL>)`. The file URL carries an encrypted, session-bound, seven-day capability for that single asset. It refreshes upstream metadata and streams the original bytes with an attachment disposition and UTF-8 filename. API keys and upstream credentials are not put in those links. Disconnecting or reconnecting the session invalidates the capabilities.

The Markdown transformation parses destinations and reference links, escapes filenames, and preserves surrounding text. Unavailable previews retain the downloadable file when its metadata is available. Unresolvable files have an explicit unavailable label. Existing replies stored by ChatGPTBox are not retroactively changed.

## Evidence

- The complete automated suite passes. The required coverage gate reports 100% lines, statements, functions, and branches for every included file.
- Production build succeeds. Chat/Responses JSON and SSE regression cases retain three-turn continuation with the exact returned assistant text.
- The optional `scripts/check-chatgptbox-assets.mjs` bundles the checkout's actual Markdown and Hyperlink components. Chromium runs with normal browser security on a controlled `https://www.google.com/search` fixture, using a fresh profile.
- Both renderer variants, with and without KaTeX, decode the synthetic preview and download `report.csv`; the downloaded filename and all 17 bytes match the fixture.
- After updating the local Docker Mirror service, a normal live ChatGPT turn generated `mirror-preview-qa.png` (96 × 64, 442 bytes) and `mirror-download-qa.csv` (17 bytes). The PNG preview was embedded; anonymous capability requests downloaded both original files with HTTP 200 and attachment headers. The CSV was exactly `name,value\nQA,42\n`.
- Both actual ChatGPTBox renderer variants also passed with that live response: image decoded, filename anchor opened through normal browser behavior, and the CSV download matched byte-for-byte.
- The running service reports healthy SQLite storage and required, verified WARP egress. The WARP container and persisted data were retained. The prior image is tagged `mirror-app-mirror:before-asset-fix-20260910` for rollback.

## Boundaries

This is source-renderer integration plus real upstream and browser download evidence. It is not a claim that the user's installed extension or a real Google results page was exercised. Extension versions and page policies can differ.

A separate live `store:false` temporary-chat probe generated files, but ChatGPT's interpreter download endpoint returned HTTP 404 for both final and tool message IDs. Mirror correctly reports those files unavailable. This upstream temporary-chat retrieval case remains unsupported; the passing live workflow uses normal stored chat semantics, which ChatGPTBox sends by default. The fix does not change the user's storage/privacy choice to work around that restriction.

Preview reads are bounded to 25 MiB per image; original-file downloads do not have that preview limit. Embedded previews increase the size of returned text and saved client history. Upstream file availability can expire independently of the seven-day Mirror link.

## Reproduce

Run `npm run coverage`, `npm run build`, and then:

```sh
CHATGPTBOX_SOURCE=/path/to/chatGPTBox node scripts/check-chatgptbox-assets.mjs
```

The checkout needs its own npm dependencies installed. To replay the specific live QA response, set `MIRROR_ASSET_RESPONSE` to a private JSON file containing `{ "markdown": "..." }` from the QA turn that generated `mirror-preview-qa.png` and `mirror-download-qa.csv`. Do not commit capability-bearing response files.
