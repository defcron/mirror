import { useState } from "react";

interface Item {
  id: string;
  title: string;
  currentNodeId?: string;
}

interface Node {
  id: string;
  upstreamNodeId: string | null;
  role: string;
  status: string;
}

interface Branches {
  selected: string;
  parent: string;
  items: Item[];
  nodes: Node[];
}

export function ConversationTools({
  conversationId,
  disabled,
  onSelect,
}: {
  conversationId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [status, setStatus] = useState("");
  const [attachments, setAttachments] = useState(false);
  const [metadata, setMetadata] = useState(false);

  async function read(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (!response.ok)
      throw new Error(
        `History request returned HTTP ${response.status}. Reload and try again.`,
      );
    return response.json();
  }

  async function search() {
    try {
      const result = await read(
        `/api/conversations/search?q=${encodeURIComponent(query)}`,
      );
      setItems(result.items);
      setStatus(`${result.items.length} local matches (maximum 100)`);
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function refreshBranches() {
    try {
      setBranches(
        await read(
          `/api/conversations/${encodeURIComponent(conversationId)}/branches`,
        ),
      );
      setStatus("Branches loaded");
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function branch(messageId: string) {
    try {
      const result = await read(
        `/api/conversations/${encodeURIComponent(conversationId)}/branch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        },
      );
      onSelect(result.id);
      setBranches(null);
      setStatus("Branch selected; the next turn will use this parent.");
    } catch (error) {
      setStatus(String(error));
    }
  }

  const base = `/api/conversations/${encodeURIComponent(
    conversationId,
  )}/export?attachments=${attachments}&metadata=${metadata}`;

  return (
    <details className="utility-panel">
      <summary>Local search, branches, and export</summary>
      <label>
        Search local history
        <input
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <button
        disabled={disabled || !query.trim()}
        onClick={() => void search()}
      >
        Search history
      </button>
      <p role="status">{status}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button disabled={disabled} onClick={() => onSelect(item.id)}>
              {item.title}
            </button>
          </li>
        ))}
      </ul>
      {conversationId && (
        <>
          <button disabled={disabled} onClick={() => void refreshBranches()}>
            Show conversation branches
          </button>
          {branches?.selected === conversationId && (
            <>
              <p>
                Next parent: <code>{branches.parent}</code>
              </p>
              <ul>
                {branches.items.map((item) => (
                  <li key={item.id}>
                    <button
                      disabled={disabled}
                      aria-current={item.id === conversationId}
                      onClick={() => onSelect(item.id)}
                    >
                      {item.title}
                    </button>
                    <code>{item.currentNodeId}</code>
                  </li>
                ))}
              </ul>
              <ol>
                {branches.nodes.map((node) => {
                  const isNextParent = Boolean(
                    branches.parent && node.upstreamNodeId === branches.parent,
                  );
                  return (
                    <li
                      key={node.id}
                      aria-current={isNextParent ? "location" : undefined}
                      style={isNextParent ? { fontWeight: 600 } : undefined}
                    >
                      <span>
                        {node.role} · {node.status}
                      </span>{" "}
                      · <code>{node.upstreamNodeId ?? "No upstream node"}</code>
                      {isNextParent && <strong> (next parent)</strong>}
                      {node.role === "assistant" && node.upstreamNodeId && (
                        <button
                          disabled={disabled}
                          onClick={() => void branch(node.id)}
                        >
                          Continue from this assistant
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={attachments}
              onChange={(event) => setAttachments(event.target.checked)}
            />
            Include attachment references (no file bytes)
          </label>
          <label>
            <input
              type="checkbox"
              checked={metadata}
              onChange={(event) => setMetadata(event.target.checked)}
            />
            Include IDs, model, and message metadata
          </label>
          <a href={`${base}&format=json`} download>
            Export JSON
          </a>
          {" · "}
          <a href={`${base}&format=markdown`} download>
            Export Markdown
          </a>
          <p>
            Exports contain conversation text. Attachment references exclude
            signed URLs and raw events. An export is an archive, not a resumable
            import.
          </p>
        </>
      )}
    </details>
  );
}
