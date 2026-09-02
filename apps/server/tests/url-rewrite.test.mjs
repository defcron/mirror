import assert from "node:assert/strict";
import test from "node:test";
import {
  isRewritableContentType,
  requestOrigin,
  rewriteChatGptUrls,
} from "../dist/url-rewrite.js";

test("rewrites absolute ChatGPT URLs to the Mirror origin", () => {
  const input = [
    'fetch("https://chatgpt.com/backend-api/f/conversation")',
    'new URL("https://www.chatgpt.com/backend-api/models")',
  ].join("\n");
  const output = rewriteChatGptUrls(input, "http://127.0.0.1:3000");
  assert.equal(output.includes("https://chatgpt.com"), false);
  assert.equal(output.includes("https://www.chatgpt.com"), false);
  assert.match(output, /http:\/\/127\.0\.0\.1:3000\/backend-api\/f\/conversation/);
  assert.match(output, /http:\/\/127\.0\.0\.1:3000\/backend-api\/models/);
});

test("rewrites JSON-escaped ChatGPT URLs", () => {
  const input = String.raw`{"url":"https:\/\/chatgpt.com\/backend-api\/conversation\/init"}`;
  const output = rewriteChatGptUrls(input, "https://mirror.example");
  assert.equal(
    output,
    String.raw`{"url":"https:\/\/mirror.example\/backend-api\/conversation\/init"}`,
  );
});

test("rewrites ChatGPT subdomains, legacy host, and websocket origins", () => {
  const input = [
    'fetch("https://ab.chatgpt.com/ces/v1/rgstr")',
    'fetch("https://chat.openai.com/backend-api/models")',
    'new WebSocket("wss://chatgpt.com/backend-api/celsius/ws")',
    String.raw`{"url":"https:\/\/events.chatgpt.com\/collect"}`,
  ].join("\n");
  const output = rewriteChatGptUrls(input, "https://mirror.example");
  assert.equal(output.includes("chatgpt.com"), false);
  assert.equal(output.includes("chat.openai.com"), false);
  assert.match(output, /https:\/\/mirror\.example\/ces\/v1\/rgstr/);
  assert.match(output, /wss:\/\/mirror\.example\/backend-api\/celsius\/ws/);
  assert.equal(output.includes(String.raw`https:\/\/mirror.example\/collect`), true);
});

test("only buffers textual asset types for rewriting", () => {
  assert.equal(isRewritableContentType("application/javascript; charset=utf-8"), true);
  assert.equal(isRewritableContentType("application/json"), true);
  assert.equal(isRewritableContentType("text/css"), true);
  assert.equal(isRewritableContentType("application/octet-stream"), false);
  assert.equal(isRewritableContentType("image/png"), false);
});

test("builds a same-origin proxy URL from the incoming request", () => {
  assert.equal(requestOrigin("http", "localhost:3000"), "http://localhost:3000");
  assert.equal(requestOrigin("https", "mirror.example"), "https://mirror.example");
  assert.equal(requestOrigin("http", undefined), null);
});
