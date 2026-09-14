import assert from "node:assert/strict";
import test from "node:test";
import {
  editPlaygroundMessage,
  removePlaygroundMessage,
  addPlaygroundAttachment,
  removePlaygroundAttachment,
  type PlaygroundMessage,
  type PlaygroundAttachment,
} from "../src/playground-history.js";

const sampleAttachment: PlaygroundAttachment = {
  name: "notes.txt",
  mimeType: "text/plain",
  dataUrl: "data:text/plain;base64,aGVsbG8=",
};

const trackedHistory: PlaygroundMessage[] = [
  { role: "system", content: "Be concise." },
  { role: "user", content: "First question" },
  { role: "assistant", content: "First answer" },
  { role: "user", content: "Follow-up" },
  { role: "assistant", content: "Follow-up answer" },
  { role: "user", content: "" },
];

test.describe("web / playground-history", () => {
test("assistant messages cannot be edited", () => {
  const result = editPlaygroundMessage(
    trackedHistory,
    2,
    "content",
    "Corrected first answer",
    true,
  );
  assert.equal(result.invalidatesConversation, false);
  assert.equal(result.messages, trackedHistory);
  assert.equal(result.messages[2]?.content, "First answer");
});

test("editing to the same value is a no-op", () => {
  const result = editPlaygroundMessage(trackedHistory, 1, "content", "First question", true);
  assert.equal(result.messages, trackedHistory);
  assert.equal(result.invalidatesConversation, false);
});

test("editing an out-of-bounds index throws", () => {
  assert.throws(() => editPlaygroundMessage(trackedHistory, 99, "content", "x", true), RangeError);
});

test("editing a committed user message preserves the conversation and drops dependent turns", () => {
  const result = editPlaygroundMessage(
    trackedHistory,
    1,
    "content",
    "Edited first question",
    true,
  );
  assert.equal(result.invalidatesConversation, false);
  assert.deepEqual(result.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Edited first question" },
  ]);
});

test("editing the final user draft keeps the tracked conversation", () => {
  const result = editPlaygroundMessage(
    trackedHistory,
    trackedHistory.length - 1,
    "content",
    "Next question",
    true,
  );
  assert.equal(result.invalidatesConversation, false);
  assert.equal(result.messages.at(-1)?.content, "Next question");
});

test("untracked prompts remain freely editable", () => {
  const result = editPlaygroundMessage(
    trackedHistory.slice(0, 3),
    0,
    "content",
    "New instructions",
    false,
  );
  assert.equal(result.invalidatesConversation, false);
  assert.equal(result.messages.length, 3);
});

test("an assistant role cannot be changed", () => {
  const result = editPlaygroundMessage(
    trackedHistory,
    2,
    "role",
    "user",
    true,
  );
  assert.equal(result.invalidatesConversation, false);
  assert.equal(result.messages, trackedHistory);
  assert.equal(result.messages[2]?.role, "assistant");
});

test("assistant messages cannot be removed", () => {
  const result = removePlaygroundMessage(trackedHistory, 2, true);
  assert.equal(result.invalidatesConversation, false);
  assert.equal(result.messages, trackedHistory);
});

test("removing an out-of-bounds index throws", () => {
  assert.throws(() => removePlaygroundMessage(trackedHistory, 99, true), RangeError);
});

test("removing a committed user message drops its dependent turns", () => {
  const result = removePlaygroundMessage(trackedHistory, 1, true);
  assert.equal(result.invalidatesConversation, false);
  assert.deepEqual(result.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "" },
  ]);
});

test("removing the final user draft simply drops it", () => {
  const result = removePlaygroundMessage(trackedHistory, trackedHistory.length - 1, true);
  assert.equal(result.invalidatesConversation, false);
  assert.deepEqual(result.messages, trackedHistory.slice(0, -1));
});

test("removing from an untracked history simply filters it out", () => {
  const untracked = trackedHistory.slice(0, 2); // [system, user] - no assistant turn yet
  const result = removePlaygroundMessage(untracked, 1, false);
  assert.equal(result.invalidatesConversation, false);
  assert.deepEqual(result.messages, [{ role: "system", content: "Be concise." }]);
});

test("attaching a file to an out-of-bounds index throws", () => {
  assert.throws(() => addPlaygroundAttachment(trackedHistory, 99, sampleAttachment, true), RangeError);
});

test("assistant messages cannot receive attachments", () => {
  const result = addPlaygroundAttachment(trackedHistory, 2, sampleAttachment, true);
  assert.equal(result.messages, trackedHistory);
  assert.equal(result.invalidatesConversation, false);
});

test("attaching a file to the final user draft keeps the tracked conversation", () => {
  const result = addPlaygroundAttachment(
    trackedHistory,
    trackedHistory.length - 1,
    sampleAttachment,
    true,
  );
  assert.deepEqual(result.messages.at(-1)?.attachments, [sampleAttachment]);
  assert.equal(result.invalidatesConversation, false);
});

test("attaching a file to a committed user message rebases dependent turns", () => {
  const result = addPlaygroundAttachment(trackedHistory, 1, sampleAttachment, true);
  assert.deepEqual(result.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "First question", attachments: [sampleAttachment] },
  ]);
});

test("attaching a file to an untracked prompt stays freely editable", () => {
  const result = addPlaygroundAttachment(trackedHistory.slice(0, 2), 1, sampleAttachment, false);
  assert.deepEqual(result.messages[1]?.attachments, [sampleAttachment]);
});

test("removing an attachment at an out-of-bounds index throws", () => {
  assert.throws(() => removePlaygroundAttachment(trackedHistory, 99, 0, true), RangeError);
});

test("assistant messages cannot have attachments removed", () => {
  const result = removePlaygroundAttachment(trackedHistory, 2, 0, true);
  assert.equal(result.messages, trackedHistory);
  assert.equal(result.invalidatesConversation, false);
});

test("removing an attachment from the final user draft keeps the tracked conversation", () => {
  const withAttachment = addPlaygroundAttachment(
    trackedHistory,
    trackedHistory.length - 1,
    sampleAttachment,
    true,
  ).messages;
  const result = removePlaygroundAttachment(
    withAttachment,
    withAttachment.length - 1,
    0,
    true,
  );
  assert.deepEqual(result.messages.at(-1)?.attachments, []);
});

test("removing an attachment from a committed user message rebases dependent turns", () => {
  const withAttachment = trackedHistory.map((message, index) => index === 1 ? { ...message, attachments: [sampleAttachment] } : message);
  const result = removePlaygroundAttachment(withAttachment, 1, 0, true);
  assert.deepEqual(result.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "First question", attachments: [] },
  ]);
});

test("removing an absent attachment leaves an empty attachment list", () => {
  const result = removePlaygroundAttachment(trackedHistory, trackedHistory.length - 1, 0, true);
  assert.deepEqual(result.messages.at(-1)?.attachments, []);
  assert.equal(result.messages.length, trackedHistory.length);
});

test("removing an attachment from an untracked prompt stays freely editable", () => {
  const withAttachment = addPlaygroundAttachment(trackedHistory.slice(0, 2), 1, sampleAttachment, false).messages;
  const result = removePlaygroundAttachment(withAttachment, 1, 0, false);
  assert.deepEqual(result.messages[1]?.attachments, []);
});
});
