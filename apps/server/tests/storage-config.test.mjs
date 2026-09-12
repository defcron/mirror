import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDataDirectory } from "../dist/storage-config.js";

test.describe("server / storage-config", () => {
test("storage defaults to the project directory and honors an explicit override", () => {
  assert.equal(resolveDataDirectory("/fixture/project"), path.join("/fixture/project", ".data"));
  assert.equal(resolveDataDirectory("/fixture/project", "/fixture/override"), "/fixture/override");
});
});
