import type { NormalizedConversationEvent } from "@mirror/protocol";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent, Root } from "mdast";
import { assetFileName, type AssetLinks } from "./asset-links.js";
import { isLoopbackHostname } from "./security.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const label = (value: string) => value.replace(/[\r\n]/g, " ").trim().replace(/[\\`*_[\]<>]/g, "\\$&");
const toolLabel = (value: string) => value.replace(/[\\\[\]<>\r\n]/g, " ").trim() || "Download file";
const fence = (value: string) => { const ticks = "`".repeat(Math.max(3, ...(value.match(/`+/g) ?? []).map(s => s.length + 1))); return `${ticks}text\n${value}\n${ticks}`; };
const pointerPattern = /(?:file-service|sediment):\/\/[^\s\)\]"'<>\uE000-\uF8FF]+|sandbox:\/[^\s\)\]"'<>\uE000-\uF8FF]+/g;

export function visibleSummary(raw: ObjectValue): string {
  const content = object(raw.content);
  // Only explicitly identified display summaries; never infer a summary from
  // analysis text or copy private/internal channels into an API summary item.
  if (content?.content_type !== "reasoning_recap" && content?.content_type !== "summary") return "";
  return str(content.text) || (Array.isArray(content.parts) ? content.parts.filter(p => typeof p === "string").join("\n") : "");
}

function toolText(raw: ObjectValue): string {
  const content = object(raw.content);
  const blocks: string[] = [];
  const seen = new Set<string>();
  const add = (heading: string, value: unknown) => {
    const text = str(value); if (!text || seen.has(text)) return;
    seen.add(text); blocks.push(`${heading}\n\n${fence(text)}`);
  };
  if (Array.isArray(content?.parts)) for (const part of content.parts) if (typeof part === "string") add("Output", part);
  for (const container of [raw, content, object(raw.output)]) {
    if (!container) continue;
    for (const key of ["text", "stdout", "stderr", "logs"]) {
      const value = container[key];
      add(key, Array.isArray(value) && value.every(v => typeof v === "string") ? value.join("\n") : value);
    }
    // Render a safe textual representation. Executable HTML/JS widgets are
    // not injected into Markdown clients.
    const data = object(container.data);
    if (data) add("Display", data["text/plain"]);
  }
  return blocks.join("\n\n");
}

export function needsRichOutput(event: NormalizedConversationEvent): boolean {
  if (event.displayHidden) return false;
  if (["tool", "image", "file", "citation"].includes(event.kind)) return true;
  if (event.kind === "message") return Boolean(visibleSummary(event.raw));
  return event.kind === "assistant_text" && /[\uE000-\uF8FF]|sandbox:|file-service:|sediment:/.test(event.text);
}

export interface RichOutput {
  text: string;
  assets: { pointer: string; url?: string; previewUnavailable?: boolean; status: "resolved" | "unavailable" }[];
  tools: { name: string; messageId: string | null; text: string }[];
  summaries: { messageId: string | null; text: string }[];
}

/** Resolve only attachments named in this turn's upstream events. */
export async function renderRichOutput(
  events: NormalizedConversationEvent[], fallback: string,
  resolve: (pointer: string, messageId?: string | null, image?: boolean) => Promise<string | AssetLinks>,
): Promise<RichOutput> {
  const segments: { key: string; text: string; tool?: boolean }[] = [];
  const messages = new Map<string | null, ObjectValue>();
  const snapshots = new Map<string | null, string>();
  const tools = new Map<string, RichOutput["tools"][number]>();
  const summaries = new Map<string | null, string>();
  const references = new Map<string, { pointer: string; title: string }>();
  const pointers = new Map<string, { image: boolean; title: string; messageId?: string | null }>();
  // Inline citation markers (e.g. web-search results). ChatGPT wraps each
  // citation in the message text with \uE200...\uE201 private-use markers
  // and separately reports the literal marker text -> title/url mapping in
  // message.metadata.content_references (or the older .citations key).
  // Without this, every marker looks unresolvable to the pointer-based logic
  // below and falls through to the "[Reference unavailable]" placeholder.
  const citationRefs = new Map<string, { title: string; url?: string }>();
  const registerContentReferences = (raw: ObjectValue | undefined) => {
    const metadata = object(raw?.metadata);
    const refs = metadata?.content_references ?? metadata?.citations;
    if (!Array.isArray(refs)) return;
    for (const entry of refs) {
      const ref = object(entry);
      if (!ref) continue;
      const matched = str(ref.matched_text);
      if (!matched) continue;
      const items = Array.isArray(ref.items) ? (ref.items.map(object).filter(Boolean) as ObjectValue[]) : [];
      const primary = items[0] ?? ref;
      const title = str(primary.title) || str(primary.attribution) || str(ref.title) || str(ref.attribution) || "";
      const url = str(primary.url) || str(ref.url) || "";
      if (title || url) citationRefs.set(matched, { title: title || url, url: url || undefined });
    }
  };
  const visit = (value: unknown, messageId?: string | null) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(pointerPattern)) if (!pointers.has(match[0])) pointers.set(match[0], { image: match[0].startsWith("sediment:"), title: "Download file", messageId });
      return;
    }
    if (Array.isArray(value)) { value.forEach(v => visit(v, messageId)); return; }
    const item = object(value); if (!item) return;
    const pointer = str(item.asset_pointer) || (str(item.file_id) ? `file-service://${item.file_id}` : "");
    const title = str(item.file_name) || str(item.fileName) || str(item.filename) || str(item.name) || str(item.title) || "Download file";
    if (pointer) {
      const prior = pointers.get(pointer);
      pointers.set(pointer, { image: prior?.image || item.content_type === "image_asset_pointer" || pointer.startsWith("sediment:"), title, messageId: messageId ?? prior?.messageId });
      for (const key of ["matched_text", "text", "citation", "url", "path"]) {
        const token = str(item[key]);
        if (token && (/[\uE000-\uF8FF]/.test(token) || token.startsWith("sandbox:"))) references.set(token, { pointer, title });
      }
    }
    for (const [key, nested] of Object.entries(item)) if (key !== "asset_pointer") visit(nested, messageId);
  };
  for (const event of events) {
    if (event.displayHidden) continue;
    if (event.kind === "assistant_text") {
      const previous = snapshots.get(event.messageId) ?? "";
      snapshots.set(event.messageId, event.text);
      if (event.text && event.text !== previous) {
        const append = previous && event.text.startsWith(previous) ? event.text.slice(previous.length) : `${segments.length ? "\n\n" : ""}${event.text}`;
        segments.push({ key: "text", text: append });
      }

    } else if (event.kind === "tool") {
      const key = `${event.messageId ?? "typed"}:${event.name}`;
      const text = toolText(event.raw);
      if (text) {
        if (!tools.has(key)) segments.push({ key, text: "", tool: true });
        tools.set(key, { name: event.name, messageId: event.messageId, text });
      }
      messages.set(event.messageId, event.raw);
    } else if (event.kind === "message") {
      const summary = visibleSummary(event.raw);
      if (summary) summaries.set(event.messageId, summary);
      // User inputs and internal analysis are not output attachments.
      if (event.role !== "user" && event.raw.channel !== "analysis") messages.set(event.messageId, event.raw);
    } else if (event.kind === "image" || event.kind === "file") {
      const isImage = event.kind === "image" || event.assetPointer.startsWith("sediment://");
      if (!pointers.has(event.assetPointer)) {
        pointers.set(event.assetPointer, {
          image: isImage,
          title: !isImage && event.kind === "file" ? event.title ?? "Download file" : "Image",
        });
      }
      if (event.raw) visit(event.raw);
    } else if (event.kind === "citation") visit(event.raw);
  }
  let text = segments.length ? segments.map(segment => segment.tool ? `\n\n**${toolLabel(tools.get(segment.key)!.name)}**\n\n${tools.get(segment.key)!.text}\n\n` : segment.text).join("") : fallback;
  for (const [messageId, raw] of messages) { registerContentReferences(raw); visit(raw, messageId); }
  visit(text);
  for (const [token, ref] of references) if (token.startsWith("sandbox:") && token !== ref.pointer) pointers.delete(token);
  // Parse destinations before resolving: parentheses, escaped labels, angle
  // destinations and reference-style links cannot be handled by a URL regex.
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const walk = (node: Root | RootContent, fn: (node: RootContent) => void) => {
    if (node.type !== "root") fn(node);
    if ("children" in node) for (const child of node.children) walk(child, fn);
  };
  const internal = (value: string) => /^(?:file-service:\/\/|sediment:\/\/|sandbox:\/)/.test(value);
  const alias = (value: string) => references.get(value)?.pointer ?? value;
  walk(tree, node => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && internal(node.url)) {
      const pointer = alias(node.url);
      if (!pointers.has(pointer)) pointers.set(pointer, { image: node.type === "image", title: "Download file" });
      else if (node.type === "image") pointers.get(pointer)!.image = true;
    }
  });
  // Remove partial pointers discovered by the legacy bare-token scan when a
  // complete parsed destination is available (e.g. report(final).csv).
  walk(tree, node => {
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && internal(node.url)) {
      for (const partial of node.url.matchAll(pointerPattern)) if (partial[0] !== node.url) pointers.delete(partial[0]);
    }
  });
  // Retain bare references even when they share a prefix with a longer link.
  walk(tree, node => { if (node.type === "text") visit(node.value); });
  for (const [token, ref] of references) if (token.startsWith("sandbox:") && token !== ref.pointer) pointers.delete(token);
  const assets: RichOutput["assets"] = [];
  const urls = new Map<string, { url: string; downloadUrl: string; fileName?: string; previewUnavailable?: boolean }>();
  for (const [pointer, info] of pointers) {
    try {
      const resolved = await resolve(pointer, info.messageId, info.image);
      const value = typeof resolved === "string" ? { url: resolved, downloadUrl: resolved, previewUnavailable: false } : resolved;
      for (const url of [value.url, value.downloadUrl]) {
        if (typeof resolved !== "string" && url === value.url && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd.microsoft.icon|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(url)) continue;
        const parsed = new URL(url);
        const localAsset = typeof resolved !== "string" && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname) && parsed.pathname === "/api/asset-content";
        if ((!localAsset && parsed.protocol !== "https:") || parsed.username || parsed.password) throw new Error("Invalid download URL");
      }
      urls.set(pointer, value); assets.push({ pointer, url: value.url, ...(value.previewUnavailable ? { previewUnavailable: true } : {}), status: "resolved" });
    } catch { assets.push({ pointer, status: "unavailable" }); }
  }
  const used = new Set<string>();
  const escapedUrl = (url: string) => url.replace(/[<>\s\\]/g, c => encodeURIComponent(c));
  const filename = (pointer: string, title: string) => {
    const resolvedName = urls.get(pointer)?.fileName;
    const sandboxAlias = [...references].find(([token, ref]) => token.startsWith("sandbox:") && ref.pointer === pointer)?.[0];
    const path = pointer.startsWith("sandbox:") ? pointer.slice("sandbox:".length) : sandboxAlias?.slice("sandbox:".length) ?? "";
    const named = title && !/^(?:Download(?: file| now)?|Image|file)$/i.test(title) ? title : "";
    if (resolvedName && resolvedName !== "file") return assetFileName(resolvedName);
    let value = path || named || pointer.split("//").at(-1)!;
    if (path) try { value = decodeURIComponent(value); } catch { /* Preserve literal percent signs. */ }
    return assetFileName(value);
  };
  const link = (pointer: string, title: string, image = false, prefixed = false) => {
    pointer = alias(pointer);
    used.add(pointer);
    const value = urls.get(pointer);
    const name = label(filename(pointer, title));
    if (!value) return `[${name} — download unavailable]`;
    const download = `${prefixed ? "" : "Download file: "}[${name}](<${escapedUrl(value.downloadUrl)}>)`;
    return image && !value.previewUnavailable ? `![${name}](<${escapedUrl(value.url)}>)\n\n${download}` : download;
  };
  const edits: { start: number; end: number; value: string }[] = [];
  const edit = (node: RootContent, value: string) => edits.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, value });
  const transform = (node: Root | RootContent) => {
    if (node.type === "definition" && internal(node.url)) { edit(node, ""); return; }
    const destination = node.type === "link" || node.type === "image" ? node.url
      : node.type === "linkReference" || node.type === "imageReference" ? definitions.get(node.identifier) : undefined;
    if (destination && internal(destination)) {
      const pointer = alias(destination);
      const prefixed = /Download file:\s*$/i.test(text.slice(0, node.position!.start.offset));
      edit(node as RootContent, link(pointer, pointers.get(pointer)!.title, node.type === "image" || node.type === "imageReference", prefixed));
      return;
    }
    if (node.type === "text") {
      let value = text.slice(node.position!.start.offset, node.position!.end.offset);
      // Replace references and bare pointers once, without rescanning generated
      // Markdown (a filename itself may contain punctuation or pointer text).
      const tokens = [...references.keys(), ...citationRefs.keys()].filter(token => value.includes(token)).sort((a, b) => b.length - a.length);
      const pattern = new RegExp(tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).concat(pointerPattern.source).join("|"), "g");
      value = value.replace(pattern, token => {
        const citation = citationRefs.get(token);
        if (citation) return citation.url ? `[${label(citation.title)}](<${escapedUrl(citation.url)}>)` : label(citation.title);
        const pointer = alias(token), info = pointers.get(pointer);
        return link(pointer, info!.title, info!.image);
      }).replace(/\uE200[^\uE201]*\uE201/g, "[Reference unavailable]");
      edit(node, value);
      return;
    }
    if ("children" in node) for (const child of node.children) transform(child);
  };
  transform(tree);
  for (const entry of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, entry.start) + entry.value + text.slice(entry.end);
  for (const [pointer, info] of pointers) if (!used.has(pointer)) text += `\n\n${link(pointer, info.title, info.image)}`;
  return { text, assets, tools: [...tools.values()],
    summaries: [...summaries].map(([messageId, text]) => ({ messageId, text })) };
}
