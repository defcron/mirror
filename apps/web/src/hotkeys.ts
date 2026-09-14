// A tiny, dependency-free hotkey representation shared between the actual
// keydown handling in App.tsx and the recording/display UI in
// HotkeySettings.tsx. Combos are stored as strings like "mod+k" or
// "mod+shift+p" - "mod" means metaKey (Cmd, on Mac) or ctrlKey (everywhere
// else), matching how the rest of this app already treats the two as
// interchangeable (see the existing Cmd/Ctrl+Enter run shortcut).
export interface ParsedHotkey {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

// Every hotkey this app currently defines, and its default combo. New
// shortcuts should be added here so they automatically get a settings row
// and a saved/reset-able per-account override.
export const DEFAULT_HOTKEYS: Record<string, string> = {
  commandPalette: "mod+k",
};

export function parseHotkey(combo: string): ParsedHotkey {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed: ParsedHotkey = { mod: false, shift: false, alt: false, key: "" };
  for (const part of parts) {
    if (part === "mod") parsed.mod = true;
    else if (part === "shift") parsed.shift = true;
    else if (part === "alt") parsed.alt = true;
    else parsed.key = part;
  }
  return parsed;
}

export function matchesHotkey(event: KeyboardEvent, combo: string): boolean {
  const parsed = parseHotkey(combo);
  if (!parsed.key) return false;
  const mod = event.metaKey || event.ctrlKey;
  return (
    mod === parsed.mod &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    event.key.toLowerCase() === parsed.key
  );
}

// A short, readable label for the settings panel - "mod+k" -> "Cmd/Ctrl+K".
export function describeHotkey(combo: string): string {
  const parsed = parseHotkey(combo);
  const labels: string[] = [];
  if (parsed.mod) labels.push("Cmd/Ctrl");
  if (parsed.alt) labels.push("Alt");
  if (parsed.shift) labels.push("Shift");
  if (parsed.key) labels.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return labels.join("+") || combo;
}
