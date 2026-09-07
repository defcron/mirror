// Writes the current OpenAPI document to dist/openapi.json and
// dist/openapi.yaml as build artifacts, e.g. for external codegen tools
// that want the spec without running the server. This is NOT what the
// running server itself uses to answer GET /mirror/openapi - that route
// (see src/index.ts) calls buildOpenApiDocument() directly at request
// time, straight from the live Zod schemas in src/openai.ts, so it can
// never go stale relative to what the server actually validates. This
// script just mirrors that same always-fresh document out to disk as a
// convenience artifact of `npm run build`.
import { mkdir, writeFile } from "node:fs/promises";
import { stringify as toYaml } from "yaml";
import { buildOpenApiDocument } from "../dist/openapi-document.js";

const doc = buildOpenApiDocument();
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/openapi.json", import.meta.url), JSON.stringify(doc, null, 2));
await writeFile(new URL("../dist/openapi.yaml", import.meta.url), toYaml(doc));
console.log("Wrote dist/openapi.json and dist/openapi.yaml");
