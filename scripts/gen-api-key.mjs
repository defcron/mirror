// Generates a cryptographically random value suitable for MIRROR_API_KEY /
// MIRROR_API_KEYS. Not an OpenAI or ChatGPT credential -- this is Mirror-s
// own application key, used only to gate its /v1/* OpenAI-compatible routes
// when you want that (see README.md). Run with: npm run gen-api-key
import { randomBytes } from "node:crypto";

const bytes = Number(process.argv[2] ?? 32);
if (!Number.isInteger(bytes) || bytes < 16) {
  console.error("Usage: npm run gen-api-key [byteLength>=16]  (default 32)");
  process.exit(1);
}

// base64url avoids characters (+ / =) that need quoting/escaping in .env
// files and shells, while still being copy-pasteable as one token.
console.log(randomBytes(bytes).toString("base64url"));
