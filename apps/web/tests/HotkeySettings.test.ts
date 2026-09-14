import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HotkeySettings } from "../src/HotkeySettings.js";
import { DEFAULT_HOTKEYS } from "../src/hotkeys.js";

test.describe("web / HotkeySettings", () => {
test.afterEach(() => {
  cleanup();
});

function renderSettings(opts: {
  hotkeys?: Record<string, string>;
  disabled?: boolean;
  onSave?: (next: Record<string, string>) => void;
} = {}) {
  const onSave = opts.onSave ?? (() => undefined);
  render(
    React.createElement(HotkeySettings, {
      hotkeys: opts.hotkeys ?? {},
      disabled: opts.disabled ?? false,
      onSave,
    }),
  );
  return { onSave };
}

test("shows the default combo for a shortcut with no override, and no reset button", () => {
  renderSettings();
  assert.ok(screen.getByText("Cmd/Ctrl+K"));
  assert.equal(screen.queryByRole("button", { name: "Reset to default" }), null);
});

test("shows an override's combo and offers Reset to default", () => {
  renderSettings({ hotkeys: { commandPalette: "mod+shift+p" } });
  assert.ok(screen.getByText("Cmd/Ctrl+Shift+P"));
  assert.ok(screen.getByRole("button", { name: "Reset to default" }));
});

test("clicking Change opens a recording field; pressing a combo saves it and reports the new binding", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.keyDown(field, { key: "p", ctrlKey: true, shiftKey: true });
  assert.deepEqual(saved, { commandPalette: "mod+shift+p" });
  assert.ok(screen.getByText(/set to Cmd\/Ctrl\+Shift\+P/));
});

test("recording ignores bare modifier keypresses and waits for a real key", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.keyDown(field, { key: "Control", ctrlKey: true });
  assert.equal(saved, null);
  // Still recording - the field is still there.
  assert.ok(screen.getByLabelText("Press a key combo for Quick-open conversation search"));
});

test("Escape while recording cancels without saving", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.keyDown(field, { key: "Escape" });
  assert.equal(saved, null);
  assert.equal(screen.queryByLabelText("Press a key combo for Quick-open conversation search"), null);
  assert.ok(screen.getByRole("button", { name: "Change" }));
});

test("blurring the recording field cancels it", () => {
  renderSettings();
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.blur(field);
  assert.equal(screen.queryByLabelText("Press a key combo for Quick-open conversation search"), null);
});

test("recording a plain (no-modifier) key still records a combo", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.keyDown(field, { key: "/" });
  assert.deepEqual(saved, { commandPalette: "/" });
});

test("recording captures alt and meta modifiers too", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const field = screen.getByLabelText("Press a key combo for Quick-open conversation search");
  fireEvent.keyDown(field, { key: "e", metaKey: true, altKey: true });
  assert.deepEqual(saved, { commandPalette: "mod+alt+e" });
});

test("Reset to default removes the override and reports the reset", () => {
  let saved: Record<string, string> | null = null;
  renderSettings({ hotkeys: { commandPalette: "mod+shift+p" }, onSave: (next) => { saved = next; } });
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  assert.deepEqual(saved, {});
  assert.ok(screen.getByText(/reset to default/));
});

test("Change and Reset buttons are disabled when the panel is disabled", () => {
  renderSettings({ hotkeys: { commandPalette: "mod+shift+p" }, disabled: true });
  assert.equal((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled, true);
});

test("DEFAULT_HOTKEYS is used as a fallback source for the initial display", () => {
  renderSettings({ hotkeys: {} });
  const expected = DEFAULT_HOTKEYS.commandPalette.split("+")[1].toUpperCase();
  const codeElements = document.querySelectorAll("code");
  assert.ok(Array.from(codeElements).some((el) => el.textContent?.includes(expected)));
});
});
