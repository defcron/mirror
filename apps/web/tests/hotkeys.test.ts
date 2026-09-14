import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOTKEYS,
  parseHotkey,
  matchesHotkey,
  describeHotkey,
} from "../src/hotkeys.js";

test.describe("web / hotkeys", () => {
  test("DEFAULT_HOTKEYS defaults commandPalette to mod+k", () => {
    assert.equal(DEFAULT_HOTKEYS.commandPalette, "mod+k");
  });

  test("parseHotkey reads mod/shift/alt and the trailing key", () => {
    assert.deepEqual(parseHotkey("mod+k"), { mod: true, shift: false, alt: false, key: "k" });
    assert.deepEqual(parseHotkey("mod+shift+p"), { mod: true, shift: true, alt: false, key: "p" });
    assert.deepEqual(parseHotkey("alt+shift+x"), { mod: false, shift: true, alt: true, key: "x" });
    assert.deepEqual(parseHotkey(""), { mod: false, shift: false, alt: false, key: "" });
    // Case-insensitive and tolerant of stray whitespace.
    assert.deepEqual(parseHotkey(" MOD + K "), { mod: true, shift: false, alt: false, key: "k" });
  });

  // Pure logic functions - no DOM needed, so build a minimal event-shaped
  // object rather than pulling in jsdom's KeyboardEvent for this file.
  function keydown(init: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): KeyboardEvent {
    return {
      key: init.key,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      shiftKey: init.shiftKey ?? false,
      altKey: init.altKey ?? false,
    } as KeyboardEvent;
  }

  test("matchesHotkey requires every modifier and the key to line up exactly", () => {
    assert.equal(matchesHotkey(keydown({ key: "k", ctrlKey: true }), "mod+k"), true);
    assert.equal(matchesHotkey(keydown({ key: "k", metaKey: true }), "mod+k"), true);
    assert.equal(matchesHotkey(keydown({ key: "K", ctrlKey: true }), "mod+k"), true, "key comparison is case-insensitive");
    assert.equal(matchesHotkey(keydown({ key: "k" }), "mod+k"), false, "missing the mod key");
    assert.equal(matchesHotkey(keydown({ key: "j", ctrlKey: true }), "mod+k"), false, "wrong key");
    assert.equal(matchesHotkey(keydown({ key: "k", ctrlKey: true, shiftKey: true }), "mod+k"), false, "unexpected shift");
    assert.equal(matchesHotkey(keydown({ key: "p", ctrlKey: true, shiftKey: true }), "mod+shift+p"), true);
    assert.equal(matchesHotkey(keydown({ key: "p", ctrlKey: true, altKey: true }), "mod+shift+p"), false, "alt present but not expected");
  });

  test("matchesHotkey rejects a combo with no actual key (modifiers only)", () => {
    assert.equal(matchesHotkey(keydown({ key: "Control", ctrlKey: true }), "mod"), false);
  });

  test("describeHotkey renders a short human label", () => {
    assert.equal(describeHotkey("mod+k"), "Cmd/Ctrl+K");
    assert.equal(describeHotkey("mod+shift+p"), "Cmd/Ctrl+Shift+P");
    assert.equal(describeHotkey("alt+enter"), "Alt+enter");
    // No recognizable parts at all falls back to the raw combo string.
    assert.equal(describeHotkey(""), "");
  });
});
