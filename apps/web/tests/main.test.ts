import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import ReactDOM from "react-dom/client";

// CSS is loaded by Vite in production; Node only needs to exercise mounting.
const css = registerHooks({ load(url, context, next) {
  if (url === new URL("../src/styles.css", import.meta.url).href) return { format: "module", source: "", shortCircuit: true };
  return next(url, context);
} });
test.describe("web / main", () => {
test.after(() => css.deregister());

test("the browser entry point mounts the Playground in StrictMode", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [], items: [], hasMore: false }));
  let root: ReturnType<typeof ReactDOM.createRoot>;
  const createRoot = ReactDOM.createRoot;
  t.mock.method(ReactDOM, "createRoot", (...args) => { root = createRoot(...args); return root; });
  try {
    await act(async () => { await import("../src/main.js"); });
    assert.ok([...document.querySelectorAll("h1,h2")].some(element => element.textContent === "Chat"));
    assert.ok(document.querySelector(".message-editor"));
  } finally { await act(async () => root?.unmount()); }
});
});
