// Sets up a jsdom-backed browser-like global environment before any other
// test-time import touches `document`/`window`/etc. This file must be the
// FIRST import in any test that renders App.tsx (ESM evaluates imports in
// listed order, so importing this first guarantees react-dom/client and
// @testing-library/react see a real `document` the moment *they* load).
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM(
  "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  { url: "http://localhost/mirror/playground", pretendToBeVisual: true },
);

const { window } = dom;

function copy(name: string) {
  if (name in (globalThis as Record<string, unknown>)) return;
  Object.defineProperty(globalThis, name, {
    get: () => (window as unknown as Record<string, unknown>)[name],
    configurable: true,
  });
}

// react-dom, Testing Library, and App.tsx itself only ever touch this
// specific surface (DOM classes/constructors + the handful of browser
// globals App.tsx calls directly: location, localStorage, fetch's caller
// context). fetch/Response/AbortController/TextDecoder are deliberately
// left as Node's own - jsdom (v22+) doesn't implement fetch, and the tests
// supply their own fetch mock per-case anyway.
for (const name of [
  "window", "document", "navigator", "location", "localStorage",
  "sessionStorage", "HTMLElement", "Element", "Node", "Event",
  "CustomEvent", "KeyboardEvent", "MouseEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "SVGElement",
  "DocumentFragment", "Text", "Comment", "MutationObserver", "Storage",
]) {
  copy(name);
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Under plain `--import tsx` (no coverage collection active), tsx compiles
// App.tsx's JSX via the automatic runtime (react/jsx-runtime), so App.tsx
// itself never needs `React` in module scope. But the moment
// NODE_V8_COVERAGE is set (i.e. any coverage-instrumented run, including
// every `c8 ...` invocation) tsx's esbuild transform falls back to the
// classic "React.createElement(...)" pragma for .tsx files instead - a
// documented-nowhere quirk discovered by running the exact same test file
// with/without NODE_V8_COVERAGE set and seeing "ReferenceError: React is
// not defined" appear only in the coverage run. Rather than add an unused
// `import React from "react"` to App.tsx purely to satisfy a coverage-tool
// quirk, expose it as a real global here: an unqualified `React` reference
// in any module falls through to globalThis's own properties, so this
// makes the classic-pragma output resolve correctly either way.
(globalThis as unknown as { React: typeof React }).React = React;
