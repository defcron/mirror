import { useState, useMemo } from "react";
interface Item { id: string; title: string; currentNodeId?: string }
interface Node { id: string; upstreamNodeId: string | null; role: string; status: string }
interface Branches { selected: string; parent: string; items: Item[]; nodes: Node[] }
interface TreeNode extends Node { children: TreeNode[] }

/**
 * `branches.nodes` arrives as a flat list linked only by `upstreamNodeId`.
 * This turns it into an actual forest (roots plus nested children) so the
 * real conversation-tree shape - where a user edit or a regenerate forks a
 * sibling branch rather than just appending - is visible, instead of a flat
 * list that hides which nodes are siblings of which.
 */
function buildForest(nodes: Node[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(nodes.map(node => [node.id, { ...node, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.upstreamNodeId ? byId.get(node.upstreamNodeId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Ancestor chain (self included) from `parentId` up to its root, by id - the
 * "current path" the next turn will actually continue from. */
function activePathIds(nodes: Node[], parentId: string): Set<string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const path = new Set<string>();
  let current: string | undefined = parentId;
  while (current && !path.has(current)) {
    path.add(current);
    current = byId.get(current)?.upstreamNodeId ?? undefined;
  }
  return path;
}

function BranchTree({ roots, activePath, nextParentId, disabled, onContinue }: {
  roots: TreeNode[]; activePath: Set<string>; nextParentId: string;
  disabled: boolean; onContinue: (id: string) => void;
}) {
  const render = (node: TreeNode): JSX.Element => {
    const onActivePath = activePath.has(node.id);
    const isNextParent = node.id === nextParentId;
    const hasSiblings = node.children.length > 1;
    return <li key={node.id} role="treeitem" aria-current={isNextParent ? "location" : undefined}
      aria-selected={onActivePath} style={onActivePath ? { fontWeight: 600 } : undefined}>
      <span>{node.role} · {node.status}</span>{" "}
      <code>{node.upstreamNodeId ?? "No upstream node"}</code>
      {isNextParent && <strong> (next parent)</strong>}
      {node.role === "assistant" && node.upstreamNodeId &&
        <button disabled={disabled} onClick={() => onContinue(node.id)}>Continue from this assistant</button>}
      {node.children.length > 0 && <ul role="group">
        {hasSiblings && <li aria-hidden="true"><em>{node.children.length} branches from here:</em></li>}
        {node.children.map(render)}
      </ul>}
    </li>;
  };
  return <ul role="tree" aria-label="Conversation branch tree">{roots.map(render)}</ul>;
}

function BranchTreeSection({ branches, disabled, onContinue }: {
  branches: Branches; disabled: boolean; onContinue: (id: string) => void;
}) {
  const roots = useMemo(() => buildForest(branches.nodes), [branches.nodes]);
  const activePath = useMemo(() => activePathIds(branches.nodes, branches.parent), [branches.nodes, branches.parent]);
  return <BranchTree roots={roots} activePath={activePath} nextParentId={branches.parent}
    disabled={disabled} onContinue={onContinue} />;
}

export function ConversationTools({ conversationId, disabled, onSelect }: { conversationId: string; disabled: boolean; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [status, setStatus] = useState("");
  const [attachments, setAttachments] = useState(false);
  const [metadata, setMetadata] = useState(false);
  async function read(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`History request returned HTTP ${response.status}. Reload and try again.`);
    return response.json();
  }
  async function search() {
    try { const result = await read(`/api/conversations/search?q=${encodeURIComponent(query)}`); setItems(result.items); setStatus(`${result.items.length} local matches (maximum 100)`); }
    catch (error) { setStatus(String(error)); }
  }
  async function refreshBranches() {
    try { setBranches(await read(`/api/conversations/${encodeURIComponent(conversationId)}/branches`)); setStatus("Branches loaded"); }
    catch (error) { setStatus(String(error)); }
  }
  async function branch(messageId: string) {
    try {
      const result = await read(`/api/conversations/${encodeURIComponent(conversationId)}/branch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
      });
      onSelect(result.id); setBranches(null); setStatus("Branch selected; the next turn will use this parent.");
    } catch (error) { setStatus(String(error)); }
  }
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/export?attachments=${attachments}&metadata=${metadata}`;
  return <details className="utility-panel">
    <summary>Local search, branches, and export</summary>
    <label>Search local history<input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label>
    <button disabled={disabled || !query.trim()} onClick={() => void search()}>Search history</button>
    <p role="status">{status}</p>
    <ul>{items.map(item => <li key={item.id}><button disabled={disabled} onClick={() => onSelect(item.id)}>{item.title}</button></li>)}</ul>
    {conversationId && <>
      <button disabled={disabled} onClick={() => void refreshBranches()}>Show conversation branches</button>
      {branches?.selected === conversationId && <>
        <p>Next parent: <code>{branches.parent}</code></p>
        <ul>{branches.items.map(item => <li key={item.id}><button disabled={disabled} aria-current={item.id === conversationId} onClick={() => onSelect(item.id)}>{item.title}</button><code>{item.currentNodeId}</code></li>)}</ul>
        <BranchTreeSection branches={branches} disabled={disabled} onContinue={id => void branch(id)} />
      </>}
      <label><input type="checkbox" checked={attachments} onChange={event => setAttachments(event.target.checked)} />Include attachment references (no file bytes)</label>
      <label><input type="checkbox" checked={metadata} onChange={event => setMetadata(event.target.checked)} />Include IDs, model, and message metadata</label>
      <a href={`${base}&format=json`} download>Export JSON</a>{" · "}<a href={`${base}&format=markdown`} download>Export Markdown</a>
      <p>Exports contain conversation text. Attachment references exclude signed URLs and raw events. An export is an archive, not a resumable import.</p>
    </>}
  </details>;
}
