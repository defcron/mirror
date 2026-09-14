import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_HOTKEYS, describeHotkey } from "./hotkeys.js";

// Every configurable shortcut in the app. Add a row here (and a matching
// entry in DEFAULT_HOTKEYS) the next time a new hotkey is introduced -
// this panel and the per-account save/reset behavior come for free.
const ACTIONS: Array<{ id: string; label: string }> = [
  { id: "commandPalette", label: "Quick-open conversation search" },
];

export function HotkeySettings({
  hotkeys,
  disabled,
  onSave,
}: {
  hotkeys: Record<string, string>;
  disabled: boolean;
  onSave: (next: Record<string, string>) => void;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  function captureKey(actionId: string, label: string, event: ReactKeyboardEvent) {
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push("mod");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    parts.push(event.key.toLowerCase());
    const combo = parts.join("+");
    onSave({ ...hotkeys, [actionId]: combo });
    setRecording(null);
    setStatus(`${label} set to ${describeHotkey(combo)}`);
  }

  return (
    <details className="utility-panel">
      <summary>Keyboard shortcuts</summary>
      <p role="status">{status}</p>
      <ul>
        {ACTIONS.map((action) => {
          const combo = hotkeys[action.id] ?? DEFAULT_HOTKEYS[action.id];
          const isDefault = combo === DEFAULT_HOTKEYS[action.id];
          return (
            <li key={action.id}>
              <span>{action.label}</span>{" "}
              {recording === action.id ? (
                <input
                  autoFocus
                  readOnly
                  aria-label={`Press a key combo for ${action.label}`}
                  value="Press a key combo… (Esc to cancel)"
                  onKeyDown={(event) => captureKey(action.id, action.label, event)}
                  onBlur={() => setRecording(null)}
                />
              ) : (
                <>
                  <code>{describeHotkey(combo)}</code>{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setRecording(action.id)}
                  >
                    Change
                  </button>{" "}
                  {!isDefault && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        const next = { ...hotkeys };
                        delete next[action.id];
                        onSave(next);
                        setStatus(`${action.label} reset to default`);
                      }}
                    >
                      Reset to default
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
