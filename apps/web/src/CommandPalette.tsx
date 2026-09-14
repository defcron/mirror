import { useEffect, useRef, useState } from "react";

interface Result {
  id: string;
  title: string;
}

// A Cmd/Ctrl+K quick-open overlay over the same local search endpoint
// ConversationTools' "Search local history" field already calls
// (/api/conversations/search) - this only adds a faster, keyboard-only way
// to reach it and jump straight into a result.
export function CommandPalette({
  open,
  disabled,
  onClose,
  onSelect,
}: {
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [status, setStatus] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset to a clean slate every time the palette opens, and focus the
  // input so typing works immediately - no click required first.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setStatus("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // Debounced search-as-you-type against the existing endpoint, same
  // 100-result cap ConversationTools already documents.
  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      setStatus("");
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/conversations/search?q=${encodeURIComponent(query)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}).`);
          return res.json();
        })
        .then((body: { items?: Result[] }) => {
          const items = Array.isArray(body.items) ? body.items : [];
          setResults(items);
          setActiveIndex(0);
          setStatus(items.length ? "" : "No matches");
        })
        .catch((error) => {
          setResults([]);
          setStatus(String(error));
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;

  function choose(id: string) {
    onSelect(id);
    onClose();
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-label="Quick-open conversation search"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) =>
              results.length ? (current + 1) % results.length : 0,
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) =>
              results.length
                ? (current - 1 + results.length) % results.length
                : 0,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const picked = results[activeIndex];
            if (picked && !disabled) choose(picked.id);
          }
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to a conversation…"
          aria-label="Jump to a conversation"
          onChange={(event) => setQuery(event.target.value)}
        />
        <p role="status">{status}</p>
        <ul>
          {results.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={index === activeIndex}
                className={
                  index === activeIndex ? "command-palette-active" : undefined
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(item.id)}
              >
                {item.title || "Untitled"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
