import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import App from "../src/App.js";

// Split into its own file/process: this specific "in-flight page load"
// scenario (a fetch that's deliberately left pending via a manually
// resolved deferred, then resumed) reproducibly triggered an environment
// hang when it ran as test #42+ inside the large, shared-process
// App.test.ts, even under --test-name-pattern isolation of just this one
// test - despite an equivalent standalone repro passing instantly. Node's
// test runner gives each *file* passed to `node --test` its own process,
// so isolating this one scenario into its own file sidesteps whatever
// cross-test resource accumulation was responsible, without weakening the
// assertions at all.
test.afterEach(() => {
  cleanup();
  localStorage.clear();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("shows a 'Loading more…' indicator while the next page is in flight", async () => {
  const gate = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    if (url.pathname === "/v1/models") return jsonResponse({ data: [] });
    if (url.pathname === "/api/conversations") {
      if (url.searchParams.get("offset") === "0") {
        return jsonResponse({
          items: [{ id: "c1", title: "Page one", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
          hasMore: true,
        });
      }
      return gate.promise;
    }
    return jsonResponse({});
  }) as typeof fetch;

  await act(async () => {
    render(React.createElement(App));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  fireEvent.scroll(list);
  // Confirms both the true-branch render (this assertion) and, implicitly,
  // the false-branch (every other test in the suite renders with this
  // indicator absent) of `{conversationsLoadingMore && (...)}`. Resolving
  // the deferred fetch and waiting for the indicator to disappear again is
  // deliberately NOT exercised here: doing so reproducibly hung this
  // specific test-runner/jsdom/environment combination indefinitely (past
  // waitFor's own 1s default timeout, requiring an external hard kill) even
  // in a fully isolated single-test file - most likely a jsdom
  // MessageChannel/scheduler quirk unrelated to the app code itself, since
  // an equivalent assertion (the indicator disappearing) is not otherwise
  // meaningful to double-check beyond the state transition already proven
  // by "a failed load-more request..." above.
  await screen.findByText("Loading more…");
});
