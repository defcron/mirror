import type { NormalizedConversationEvent } from "@mirror/protocol";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const label = (value: string) => value.replace(/[\\\[\]<>\r\n]/g, " ").trim() || "Download file";
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
  assets: { pointer: string; url?: string; status: "resolved" | "unavailable" }[];
  tools: { name: string; messageId: string | null; text: string }[];
  summaries: { messageId: string | null; text: string }[];
}

/** Resolve only attachments named in this turn's upstream events. */
export async function renderRichOutput(
  events: NormalizedConversationEvent[], fallback: string,
  resolve: (pointer: string, messageId?: string | null) => Promise<string>,
): Promise<RichOutput> {
  const segments: { key: string; text: string; tool?: boolean }[] = [];
  const messages = new Map<string | null, ObjectValue>();
  const snapshots = new Map<string | null, string>();
  const tools = new Map<string, RichOutput["tools"][number]>();
  const summaries = new Map<string | null, string>();
  const references = new Map<string, { pointer: string; title: string }>();
  const pointers = new Map<string, { image: boolean; title: string; messageId?: string | null }>();
  const visit = (value: unknown, messageId?: string | null) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(pointerPattern)) if (!pointers.has(match[0])) pointers.set(match[0], { image: match[0].startsWith("sediment:"), title: "Download file", messageId });
      return;
    }
    if (Array.isArray(value)) { value.forEach(v => visit(v, messageId)); return; }
    const item = object(value); if (!item) return;
    const pointer = str(item.asset_pointer) || (str(item.file_id) ? `file-service://${item.file_id}` : "");
    const title = str(item.name) || str(item.title) || "Download file";
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
      if (typeof event.raw !== "string" && !pointers.has(event.assetPointer)) pointers.set(event.assetPointer, { image: event.kind === "image", title: event.kind === "file" ? event.title ?? "Download file" : "Image" });
    } else if (event.kind === "citation") visit(event.raw);
  }
  let text = segments.length ? segments.map(segment => segment.tool ? `\n\n**${label(tools.get(segment.key)!.name)}**\n\n${tools.get(segment.key)!.text}\n\n` : segment.text).join("") : fallback;
  for (const [messageId, raw] of messages) visit(raw, messageId);
  visit(text);
  for (const [token, ref] of references) if (token.startsWith("sandbox:") && token !== ref.pointer) pointers.delete(token);
  const assets: RichOutput["assets"] = [];
  const urls = new Map<string, string>();
  for (const [pointer, info] of pointers) {
    try {
      const url = await resolve(pointer, info.messageId);
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid download URL");
      urls.set(pointer, url); assets.push({ pointer, url, status: "resolved" });
    } catch { assets.push({ pointer, status: "unavailable" }); }
  }
  const used = new Set<string>();
  const link = (pointer: string, title: string, image = false) => {
    used.add(pointer); const url = urls.get(pointer);
    return url ? `${image ? "!" : ""}[${label(title)}](<${url.replaceAll(">", "%3E").replaceAll("<", "%3C")}>)` : `[${label(title)} — download unavailable]`;
  };
  for (const [token, ref] of references) if (text.includes(token)) {
    // A sandbox target is already inside Markdown; replace its destination.
    const url = urls.get(ref.pointer);
    if (token.startsWith("sandbox:") && url) { text = text.replaceAll(token, url); used.add(ref.pointer); }
    else text = text.replaceAll(token, link(ref.pointer, ref.title));
  }
  // Preserve surrounding Markdown link labels and image placement.
  text = text.replace(/(!?\[[^\]\n]*\])\((<?)((?:file-service|sediment):\/\/[^\s)>]+|sandbox:\/[^\s)>]+)>?\)/g,
    (_match, prefix: string, _angle: string, pointer: string) => {
      used.add(pointer); const url = urls.get(pointer);
      return url ? `${prefix}(<${url.replaceAll(">", "%3E")}>)` : `${prefix} (download unavailable)`;
    });
  text = text.replace(pointerPattern, pointer => link(pointer, pointers.get(pointer)?.title ?? "Download file", pointers.get(pointer)?.image));
  // Unknown private-use tokens must not become garbage in a plain-text client.
  text = text.replace(/\uE200[^\uE201]*\uE201/g, "[Reference unavailable]");
  for (const [pointer, info] of pointers) if (!used.has(pointer)) text += `\n\n${link(pointer, info.title, info.image)}`;
  return { text, assets, tools: [...tools.values()], summaries: [...summaries].map(([messageId, text]) => ({ messageId, text })) };
}
