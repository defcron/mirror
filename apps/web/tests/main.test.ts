import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import ReactDOM from "react-dom/client";

// CSS is loaded by Vite in production; Node only needs to exercise mounting.
// Redirected via a `resolve` hook (to an inert data: URL) rather than
// intercepted in `load` - a `load` hook that calls `next()` for every other
// module (react/jsx-runtime.js in particular, which main.js's tree pulls in
// repeatedly) hits a real Node 24 bug where a later `next()` call for an
// already-resolved specifier throws ERR_INVALID_RETURN_PROPERTY_VALUE
// instead of returning the cached result. Rewriting the specifier in
// `resolve` means `load` is never customized at all, so that path is never
// exercised - confirmed reproducible/fixed against Node v24.9.0 directly
// (this sandbox's own Node is v22, which never hit it - the pinned
// >=24 <25 engine, e.g. under CircleCI, is what actually surfaces this).
const cssUrl = new URL("../src/styles.css", import.meta.url).href;
const css = registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  return result.url === cssUrl ? { ...result, url: "data:text/javascript," } : result;
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
