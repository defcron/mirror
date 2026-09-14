import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CommandPalette } from "../src/CommandPalette.js";

test.describe("web / CommandPalette", () => {
test.afterEach(() => {
  cleanup();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function renderPalette(opts: {
  open?: boolean;
  disabled?: boolean;
  onClose?: () => void;
  onSelect?: (id: string) => void;
} = {}) {
  const onClose = opts.onClose ?? (() => undefined);
  const onSelect = opts.onSelect ?? (() => undefined);
  render(
    React.createElement(CommandPalette, {
      open: opts.open ?? true,
      disabled: opts.disabled ?? false,
      onClose,
      onSelect,
    }),
  );
  return { onClose, onSelect };
}

async function wait(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

test("renders nothing when closed", () => {
  renderPalette({ open: false });
  assert.equal(screen.queryByRole("dialog"), null);
});

test("when open, renders the dialog and focuses the input", () => {
  renderPalette({ open: true });
  const input = screen.getByLabelText("Jump to a conversation");
  assert.equal(document.activeElement, input);
});

test("typing searches (debounced) against /api/conversations/search and lists results", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    assert.equal(url.pathname, "/api/conversations/search");
    assert.equal(url.searchParams.get("q"), "rust");
    return jsonResponse({ items: [{ id: "c1", title: "Rust question" }, { id: "c2", title: "" }] });
  }) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "rust" } });
  await wait(250);
  assert.ok(screen.getByRole("button", { name: "Rust question" }));
  // An untitled result falls back to a readable placeholder.
  assert.ok(screen.getByRole("button", { name: "Untitled" }));
});

test("an empty query clears results without fetching", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return jsonResponse({ items: [] }); }) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "  " } });
  await wait(250);
  assert.equal(called, false);
});

test("no matches shows a status message", async () => {
  globalThis.fetch = (async () => jsonResponse({ items: [] })) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "nothing" } });
  await wait(250);
  assert.equal(screen.getByRole("status").textContent, "No matches");
});

test("a response whose items field isn't an array is treated as zero results", async () => {
  globalThis.fetch = (async () => jsonResponse({})) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "anything" } });
  await wait(250);
  assert.equal(screen.getByRole("status").textContent, "No matches");
});

test("a failed search reports the error as the status", async () => {
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "boom" } });
  await wait(250);
  assert.match(screen.getByRole("status").textContent ?? "", /Search failed/);
});

test("arrow keys move the active selection and Enter selects it", async () => {
  globalThis.fetch = (async () => jsonResponse({
    items: [{ id: "c1", title: "First" }, { id: "c2", title: "Second" }, { id: "c3", title: "Third" }],
  })) as typeof fetch;
  let selected: string | null = null;
  let closed = false;
  renderPalette({ onSelect: (id) => { selected = id; }, onClose: () => { closed = true; } });
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "x" } });
  await wait(250);
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  // Wraps back to the first item.
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  fireEvent.keyDown(dialog, { key: "ArrowUp" });
  // Now on the last item (wrapped the other way).
  fireEvent.keyDown(dialog, { key: "Enter" });
  assert.equal(selected, "c3");
  assert.equal(closed, true);
});

test("Enter with no results does nothing", async () => {
  globalThis.fetch = (async () => jsonResponse({ items: [] })) as typeof fetch;
  let selected: string | null = null;
  renderPalette({ onSelect: (id) => { selected = id; } });
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Enter" });
  assert.equal(selected, null);
});

test("arrow keys with no results are a no-op (activeIndex stays 0)", () => {
  renderPalette();
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowUp" });
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  // Nothing to assert on the DOM (no result rows exist) - this just
  // exercises the empty-results branch of both handlers without throwing.
});

test("Enter is a no-op while disabled", async () => {
  globalThis.fetch = (async () => jsonResponse({ items: [{ id: "c1", title: "First" }] })) as typeof fetch;
  let selected: string | null = null;
  renderPalette({ disabled: true, onSelect: (id) => { selected = id; } });
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "x" } });
  await wait(250);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  assert.equal(selected, null);
});

test("clicking a result selects it and closes the palette", async () => {
  globalThis.fetch = (async () => jsonResponse({ items: [{ id: "c1", title: "First" }] })) as typeof fetch;
  let selected: string | null = null;
  let closed = false;
  renderPalette({ onSelect: (id) => { selected = id; }, onClose: () => { closed = true; } });
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "x" } });
  await wait(250);
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  assert.equal(selected, "c1");
  assert.equal(closed, true);
});

test("hovering a result makes it the active one", async () => {
  globalThis.fetch = (async () => jsonResponse({
    items: [{ id: "c1", title: "First" }, { id: "c2", title: "Second" }],
  })) as typeof fetch;
  renderPalette();
  fireEvent.change(screen.getByLabelText("Jump to a conversation"), { target: { value: "x" } });
  await wait(250);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Second" }));
  assert.equal(screen.getByRole("button", { name: "Second" }).getAttribute("aria-current"), "true");
  assert.equal(screen.getByRole("button", { name: "First" }).getAttribute("aria-current"), "false");
});

test("Escape closes the palette", () => {
  let closed = false;
  renderPalette({ onClose: () => { closed = true; } });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(closed, true);
});

test("clicking the backdrop closes the palette, but clicking inside the dialog does not", () => {
  let closed = false;
  renderPalette({ onClose: () => { closed = true; } });
  fireEvent.click(screen.getByRole("dialog"));
  assert.equal(closed, false);
  fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
  assert.equal(closed, true);
});
});
