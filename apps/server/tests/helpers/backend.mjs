// Synthetic protocol fixtures only; no production session data.
function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function assistantAddFrame(upstreamConversationId, messageId, text, extra = {}) {
  return {
    p: "",
    o: "add",
    v: {
      conversation_id: upstreamConversationId,
      message: {
        id: messageId,
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
      },
      ...extra,
    },
  };
}

// A full happy-path upstream: /me, /conversation/init, gizmo lookup,
// sentinel handshake, and /f/conversation all succeed. `turnFrames(body,
// turnNumber)` lets a test control exactly what SSE frames come back for
// each successive turn (so a single test can inspect what was actually
// sent - the parent_message_id, the flattened vs single-message prompt,
// history_and_training_disabled, etc). `sent` collects every JSON POST
// body, tagged with its pathname.
export function stubBackend(accountId, { sent = [], turnFrames, modelsBody, sidebarBody, bootstrapBody, sidebarFails, bootstrapFails } = {}) {
  let turn = 0;
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
    if (body) sent.push({ pathname, body });
    if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: accountId } });
    if (pathname.endsWith("/models")) return Response.json(modelsBody ?? { models: [] });
    if (pathname.endsWith("/gizmos/snorlax/sidebar")) {
      if (sidebarFails) return new Response("boom", { status: 500 });
      return Response.json(sidebarBody ?? {});
    }
    if (pathname.endsWith("/gizmos/bootstrap")) {
      if (bootstrapFails) return new Response("boom", { status: 500 });
      return Response.json(bootstrapBody ?? {});
    }
    if (pathname.startsWith("/backend-api/gizmos/")) return new Response("not found", { status: 404 });
    if (pathname.endsWith("/conversation/init"))
      return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
    if (pathname.endsWith("/f/conversation/prepare")) return Response.json({ conduit_token: "conduit" });
    if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
      return Response.json({ prepare_token: "prepare", proofofwork: { required: false } });
    if (pathname.endsWith("/sentinel/chat-requirements/finalize")) return Response.json({ token: "requirements" });
    if (pathname.endsWith("/f/conversation")) {
      turn += 1;
      const frames = turnFrames
        ? turnFrames(body, turn)
        : [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `assistant-${turn}`, `reply-${turn}`), "[DONE]"];
      return sseBody(frames);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
}

