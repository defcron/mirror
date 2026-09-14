export interface PlaygroundAttachment {
  name: string;
  mimeType: string;
  /** A data: URI containing the file's bytes, ready to send as an image_url/file content part. */
  dataUrl: string;
}

export interface PlaygroundMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
  /** File attachments to send alongside this message's text (see App.tsx's attach button). */
  attachments?: PlaygroundAttachment[];
}

export interface HistoryMutation {
  messages: PlaygroundMessage[];
  invalidatesConversation: boolean;
}

function withUserDraft(messages: PlaygroundMessage[]): PlaygroundMessage[] {
  if (messages.at(-1)?.role === "user") return messages;
  return [...messages, { role: "user", content: "" }];
}

export function editPlaygroundMessage(
  messages: PlaygroundMessage[],
  index: number,
  key: keyof PlaygroundMessage,
  value: string,
  hasTrackedConversation: boolean,
): HistoryMutation {
  const current = messages[index];
  if (!current) throw new RangeError(`Message index ${index} is out of bounds`);
  // Assistant output is immutable. Return the original array so callers
  // cannot accidentally mutate it even if an event slips past the read-only
  // Playground control.
  if (current.role === "assistant")
    return { messages, invalidatesConversation: false };
  if (current[key] === value)
    return { messages, invalidatesConversation: false };

  const edited = { ...current, [key]: value } as PlaygroundMessage;
  const isFinalUserContentDraft =
    hasTrackedConversation &&
    index === messages.length - 1 &&
    current.role === "user" &&
    key === "content";

  if (!hasTrackedConversation || isFinalUserContentDraft) {
    return {
      messages: messages.map((message, currentIndex) =>
        currentIndex === index ? edited : message,
      ),
      invalidatesConversation: false,
    };
  }

  return {
    messages: withUserDraft([...messages.slice(0, index), edited]),
    // Keep the stable Mirror conversation id. The server recognizes the
    // changed prefix and rebases that id onto a fresh upstream ChatGPT
    // branch; clearing it here would make the next Run look like a brand-new
    // Playground conversation and violate the user's thread continuity.
    invalidatesConversation: false,
  };
}

export function removePlaygroundMessage(
  messages: PlaygroundMessage[],
  index: number,
  hasTrackedConversation: boolean,
): HistoryMutation {
  if (!messages[index])
    throw new RangeError(`Message index ${index} is out of bounds`);
  if (messages[index]?.role === "assistant")
    return { messages, invalidatesConversation: false };

  const isFinalUserDraft =
    hasTrackedConversation &&
    index === messages.length - 1 &&
    messages[index]?.role === "user";
  if (!hasTrackedConversation || isFinalUserDraft) {
    return {
      messages: messages.filter((_, currentIndex) => currentIndex !== index),
      invalidatesConversation: false,
    };
  }

  return {
    messages: withUserDraft(messages.slice(0, index)),
    // Removing a committed turn is the same kind of history rewrite as an
    // edit: preserve the Mirror id and let the server rebase it.
    invalidatesConversation: false,
  };
}

export function addPlaygroundAttachment(
  messages: PlaygroundMessage[],
  index: number,
  attachment: PlaygroundAttachment,
  hasTrackedConversation: boolean,
): HistoryMutation {
  const current = messages[index];
  if (!current) throw new RangeError(`Message index ${index} is out of bounds`);
  if (current.role === "assistant")
    return { messages, invalidatesConversation: false };

  const edited: PlaygroundMessage = {
    ...current,
    attachments: [...(current.attachments ?? []), attachment],
  };
  const isFinalUserDraft =
    hasTrackedConversation &&
    index === messages.length - 1 &&
    current.role === "user";

  if (!hasTrackedConversation || isFinalUserDraft) {
    return {
      messages: messages.map((message, currentIndex) =>
        currentIndex === index ? edited : message,
      ),
      invalidatesConversation: false,
    };
  }

  return {
    messages: withUserDraft([...messages.slice(0, index), edited]),
    invalidatesConversation: false,
  };
}

export function removePlaygroundAttachment(
  messages: PlaygroundMessage[],
  index: number,
  attachmentIndex: number,
  hasTrackedConversation: boolean,
): HistoryMutation {
  const current = messages[index];
  if (!current) throw new RangeError(`Message index ${index} is out of bounds`);
  if (current.role === "assistant")
    return { messages, invalidatesConversation: false };

  const edited: PlaygroundMessage = {
    ...current,
    attachments: (current.attachments ?? []).filter((_, i) => i !== attachmentIndex),
  };
  const isFinalUserDraft =
    hasTrackedConversation &&
    index === messages.length - 1 &&
    current.role === "user";

  if (!hasTrackedConversation || isFinalUserDraft) {
    return {
      messages: messages.map((message, currentIndex) =>
        currentIndex === index ? edited : message,
      ),
      invalidatesConversation: false,
    };
  }

  return {
    messages: withUserDraft([...messages.slice(0, index), edited]),
    invalidatesConversation: false,
  };
}
