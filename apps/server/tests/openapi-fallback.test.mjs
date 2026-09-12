import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as zodOpenapi from "zod-openapi";

let document;
mock.module("zod-openapi", { namedExports: { ...zodOpenapi, createDocument: () => document } });
const { buildOpenApiDocument } = await import("../dist/openapi-document.js");

test.describe("server / openapi-fallback", () => {
test("OpenAPI augmentation tolerates a generator omitting the discriminated union", () => {
  for (const partial of [{}, { components: {} }, { components: { schemas: { NormalizedConversationEvent: {} } } }]) {
    document = partial;
    assert.equal(buildOpenApiDocument(), partial);
  }
});
});
