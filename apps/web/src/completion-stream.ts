export async function readCompletionStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void, onRaw: (raw: string) => void, onConversation: (id: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "", raw = "";
  let finished = false, doneMarker = false;
  const frame = (value: string) => {
    const lines = value.split(/\r?\n/);
    const id = lines.find((line) => line.startsWith(": mirror-conversation-id "))?.slice(25).trim();
    if (id) onConversation(id);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { doneMarker = true; return; }
    raw += data + "\n"; onRaw(raw);
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message ?? "Generation failed");
    text += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.choices?.[0]?.finish_reason != null) finished = true;
    onText(text);
  };
  try {
    while (!doneMarker) {
      const result = await reader.read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? "";
      for (const value of frames) frame(value);
      if (result.done) { if (buffer.trim()) frame(buffer); break; }
    }
    if (!doneMarker || !finished) throw new Error("Response interrupted before completion; partial output is preserved.");
    return text;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
