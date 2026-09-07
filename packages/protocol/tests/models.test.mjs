import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModels, normalizeGizmos } from "../dist/index.js";

test("model normalization tolerates malformed entries and preserves optional metadata", () => {
  assert.deepEqual(normalizeModels({}), []);
  const model = { slug: "model", title: "Display", description: "Details", max_tokens: 123,
    capabilities: {}, enabled_tools: ["tool"] };
  const result = normalizeModels({ models: [null, false, [], {}, model, model] });
  assert.deepEqual(result, [{ id: "model", title: "Display", description: "Details", maxTokens: 123,
    capabilities: {}, enabledTools: ["tool"], raw: model }]);
  assert.equal(normalizeModels({ models: [{ slug: "fallback", title: "" }] })[0].title, "fallback");
});

test("gizmo recognition accepts each supported flat discriminator without requiring a short URL", () => {
  for (const field of ["instructions", "author", "profile_picture_url", "tools"]) {
    const item = { id: field, display_name: field, [field]: field === "profile_picture_url" ? "https://example.test/icon" : [] };
    const [result] = normalizeGizmos({ items: [item] });
    assert.equal(result.id, field);
    assert.equal(result.name, field);
    assert.equal(result.iconUrl, field === "profile_picture_url" ? item[field] : undefined);
  }
  assert.deepEqual(normalizeGizmos({ items: [{ id: "not-a-gizmo", display_name: "Not enough" }] }), []);
});
