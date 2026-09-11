import "./zod-openapi-init.js";
import { z } from "zod";

const InputMessage = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(z.object({
    type: z.enum(["input_text", "output_text"]), text: z.string(),
    annotations: z.array(z.unknown()).optional(),
    logprobs: z.array(z.unknown()).optional(),
  }).strict()).min(1)]),
  id: z.string().optional(),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
}).strict();

/** Deliberately explicit subset: never silently drop tools or state fields. */
export const ResponsesBody = z.object({
  model: z.string().default("auto"),
  input: z.union([z.string(), z.array(InputMessage).min(1)]),
  instructions: z.string().optional(),
  stream: z.boolean().default(false),
  store: z.boolean().default(true),
  metadata: z.record(z.string()).optional(),
  reasoning: z.object({ summary: z.enum(["auto", "concise", "detailed"]).optional() }).strict().optional(),
  max_output_tokens: z.number().int().positive().optional(),
}).strict();
export type ResponsesRequest = z.infer<typeof ResponsesBody>;

export function responsesToCompletion(body: ResponsesRequest) {
  const sanitizedMetadata = body.metadata ? { ...body.metadata } : undefined;
  if (sanitizedMetadata) {
    delete (sanitizedMetadata as any).turnstile_token;
    delete (sanitizedMetadata as any).mirror_turnstile_token;
  }
  const messages = typeof body.input === "string"
    ? [{ role: "user" as const, content: body.input }]
    : body.input.map(item => ({ role: item.role, content: typeof item.content === "string"
      ? item.content : item.content.map(part => part.text).join("") }));
  return { model: body.model, stream: body.stream, store: body.store, metadata: sanitizedMetadata,
    messages: [...(body.instructions === undefined ? [] : [{ role: "system" as const, content: body.instructions }]), ...messages] };
}

export function createResponseWriter(body: ResponsesRequest, emit: (event: Record<string, unknown>) => void) {
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const itemId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let summaries: { id: string; type: string; summary: { type: string; text: string }[] }[] = [];
  const part = (text: string) => ({ type: "output_text", text, annotations: [], logprobs: [] });
  const item = (text: string, status: string) => ({ id: itemId, type: "message", role: "assistant", status, content: [part(text)] });
  const sanitizedBodyMetadata = body.metadata ? { ...body.metadata } : {};
  delete (sanitizedBodyMetadata as any).turnstile_token;
  delete (sanitizedBodyMetadata as any).mirror_turnstile_token;
  const response = (text: string, status: string, model = body.model, metadata = sanitizedBodyMetadata) => ({
    id, object: "response", created_at: created, status, error: null, incomplete_details: null,
    model, output: status === "in_progress" ? [] : [item(text, "completed"), ...summaries],
    instructions: body.instructions ?? null, metadata, usage: null, store: body.store,
    tools: [], tool_choice: "none", parallel_tool_calls: false,
    max_output_tokens: null, previous_response_id: null,
  });
  const event = (type: string, fields: Record<string, unknown>) => emit({ type, sequence_number: sequence++, ...fields });
  return {
    response,
    setSummaries(values: { text: string }[]) {
      summaries = values.map(value => ({ id: `rs_${crypto.randomUUID().replaceAll("-", "")}`, type: "reasoning", summary: [{ type: "summary_text", text: value.text }] }));
    },
    start() {
      event("response.created", { response: response("", "in_progress") });
      event("response.in_progress", { response: response("", "in_progress") });
      event("response.output_item.added", { output_index: 0, item: { ...item("", "in_progress"), content: [] } });
      event("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: part("") });
    },
    delta(delta: string) { event("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: [] }); },
    complete(text: string, model: string, metadata: Record<string, string>) {
      event("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] });
      event("response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: part(text) });
      event("response.output_item.done", { output_index: 0, item: item(text, "completed") });
      summaries.forEach((summary, index) => {
        const fields = { item_id: summary.id, output_index: index + 1, summary_index: 0 };
        event("response.output_item.added", { output_index: index + 1, item: { ...summary, summary: [] } });
        event("response.reasoning_summary_part.added", { ...fields, part: { type: "summary_text", text: "" } });
        event("response.reasoning_summary_text.delta", { ...fields, delta: summary.summary[0].text });
        event("response.reasoning_summary_text.done", { ...fields, text: summary.summary[0].text });
        event("response.reasoning_summary_part.done", { ...fields, part: summary.summary[0] });
        event("response.output_item.done", { output_index: index + 1, item: summary });
      });
      event("response.completed", { response: response(text, "completed", model, metadata) });
    },
    fail(message: string, code: string) {
      event("response.failed", { response: { ...response("", "in_progress"), status: "failed", error: { message, code } } });
    },
  };
}
