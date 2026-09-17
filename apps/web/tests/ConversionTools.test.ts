import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversionTools, withPromptSource } from "../src/ConversionTools.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const enc = (value: string) => btoa(unescape(encodeURIComponent(value)));
function mount(opts: { chatModeActive?: boolean; disabled?: boolean; fetcher?: typeof fetch } = {}) {
  const inserted: string[] = [];
  const attached: unknown[] = [];
  globalThis.fetch = opts.fetcher ?? (async (input) => {
    const url = String(input);
    if (url.includes("/encode")) return json({ bytes: 3, dataBase64: "AQID", loaf: "SHA256(-)=x abc" });
    if (url.includes("/decode")) return json({ bytes: 5, dataBase64: enc("hello"), entries: [{ bytes: 5, contentBase64: enc("hello") }] });
    if (url.includes("gpt-prompt")) return json({ prompt: "decode this with GPT" });
    if (url.includes("mystery")) return json({ format: "pngspeak", surprise: "surprise", bytes: 3, dataBase64: "AQID" });
    if (url.includes("fortune")) return new Response(Buffer.from([1, 2, 3]));
    return json({});
  }) as typeof fetch;
  render(React.createElement(ConversionTools, {
    chatModeActive: opts.chatModeActive ?? true,
    disabled: opts.disabled ?? false,
    onInsertText: (text: string) => inserted.push(text),
    onAttach: (item: unknown) => attached.push(item),
  }));
  return { inserted, attached };
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const selectFormat = (value: string) => fireEvent.change(screen.getByLabelText("Format"), { target: { value } });

test.describe("web / ConversionTools", () => {
  test.afterEach(() => { cleanup(); });

  test("only builds a GPT prompt when source bytes are available", () => {
    let calls = 0;
    assert.equal(withPromptSource(undefined, () => { calls++; }), undefined);
    assert.equal(withPromptSource("AQID", () => { calls++; return "built"; }), "built");
    assert.equal(calls, 1);
  });

  test("encodes images and LoaF, builds GPT prompts, and attaches generated files", async () => {
    const seen: Array<[string, any]> = [];
    const { inserted, attached } = mount({ fetcher: (async (input, init) => {
      const url = String(input); seen.push([url, init?.body ? JSON.parse(String(init.body)) : null]);
      if (url.includes("gpt-prompt")) return json({ prompt: "ask GPT to decode" });
      if (url.includes("loaf/encode")) return json({ bytes: 20, loaf: "SHA256(-)=hash deadbeef" });
      return json({ bytes: 3, dataBase64: "AQID" });
    }) as typeof fetch });
    click("Encode");
    await screen.findByAltText(/Encoded PngSpeak/);
    assert.equal(screen.getByRole("link", { name: /Download/ }).getAttribute("download"), "mirror-convert.pngspk.png");
    click(/Insert decode-prompt/);
    await waitFor(() => assert.deepEqual(inserted, ["ask GPT to decode"]));
    assert.ok(seen.some(([url, body]) => url.includes("gpt-prompt") && body.filename === "message.pngspk.png"));
    click(/Attach to chat/);
    await waitFor(() => assert.equal(attached.length, 1));
    assert.match((attached[0] as any).dataUrl, /^data:image\/png;base64,AQID$/);
    selectFormat("loaf");
    click("Encode");
    await screen.findByText(/Encoded 20 bytes as LoaF/);
    assert.equal(screen.getByRole("link", { name: /Download/ }).getAttribute("download"), "mirror-convert.loaf");
    assert.ok(seen.some(([url, body]) => url.includes("loaf/encode") && body.entries[0].name === "message.txt"));
    assert.ok(screen.getByRole("link", { name: /Download/ }));
  });

  test("file selection encodes its bytes, clears the picker, and gracefully reports a rejected encoder", async () => {
    let captured: any;
    mount({ fetcher: (async (_url, init) => { captured = JSON.parse(String(init?.body)); return json({ error: "bad file" }, 422); }) as typeof fetch });
    const file = new File([new Uint8Array([0, 128, 255])], "tiny.bin", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText(/pick a file/), { target: { files: [file] } });
    await screen.findByText("bad file");
    assert.equal(captured.dataBase64, "AID/");
    assert.equal((screen.getByLabelText(/pick a file/) as HTMLInputElement).value, "");
    cleanup();
    mount({ fetcher: (async () => { throw new Error("offline"); }) as typeof fetch });
    click("Encode");
    await screen.findByText("offline");
  });

  test("mystery and fortune actions render their results, prompt eligibility, and chat attachment behavior", async () => {
    const { inserted, attached } = mount();
    click(/Mystery encode/);
    await screen.findByText(/Mystery format: pngspeak/);
    click(/Insert decode-prompt/);
    await waitFor(() => assert.deepEqual(inserted, ["decode this with GPT"]));
    click(/Attach to chat/);
    await waitFor(() => assert.equal(attached.length, 1));
    click(/Fortune cookie/);
    await screen.findByText(/Your fortune, hidden inside/);
    const buttons = screen.getAllByRole("button", { name: /Insert decode-prompt/ });
    assert.equal((buttons.at(-1) as HTMLButtonElement).disabled, true);
    assert.match((buttons.at(-1) as HTMLButtonElement).title, /server-side surprise/);
    click(/Attach to chat/);
    await waitFor(() => assert.equal(attached.length, 2));
  });

  test("fortune can choose text format and endpoint failures surface their messages", async () => {
    const responses: Response[] = [new Response(Buffer.from("plain fortune"))];
    mount({ fetcher: (async () => responses.shift() ?? json({ error: "fortune failed" }, 500)) as typeof fetch });
    click(/Fortune cookie/);
    await screen.findByText(/Your fortune, hidden inside/);
    click(/Mystery encode/);
    await screen.findByText("Ready");
  });

  test("supports all mystery artifact labels and prompts, blank fallback, and non-Error prompt failure", async () => {
    const inserted: string[] = [];
    let mysteryFormat = "gptgif-v4";
    let promptError: unknown = "prompt offline";
    mount({ fetcher: (async (input) => {
      const url = String(input);
      if (url.includes("mystery")) return json({ format: mysteryFormat, surprise: "surprise", bytes: 3, dataBase64: "AQID" });
      if (url.includes("gpt-prompt")) throw promptError;
      return json({ bytes: 3, dataBase64: "AQID" });
    }) as typeof fetch });
    fireEvent.change(screen.getByLabelText("Text to encode"), { target: { value: "" } });
    click(/Mystery encode/);
    await screen.findByText(/Mystery format: gptgif-v4/);
    click(/Insert decode-prompt/);
    await screen.findByText("Could not build a prompt");
    promptError = new Error("prompt service down");
    click(/Insert decode-prompt/);
    await screen.findByText("prompt service down");
    mysteryFormat = "gptgif";
    click(/Mystery encode/);
    await screen.findByText(/Mystery format: gptgif --/);
    mysteryFormat = "loaf";
    click(/Mystery encode/);
    await screen.findByText(/Mystery format: loaf --/);
  });

  test("encodes both GIF variants and uses HTTP fallback text plus fortune error fallback", async () => {
    mount({ fetcher: (async (input) => {
      const url = String(input);
      if (url.includes("fortune")) throw new Error("fortune offline");
      if (url.includes("gptgif-v4/encode")) return json({ bytes: 4, dataBase64: "R0lG" });
      if (url.includes("gptgif/encode")) return json({ bytes: 5, dataBase64: "R0lGODlh" });
      return json({}, 503);
    }) as typeof fetch });
    selectFormat("gptgif-v4");
    click("Encode");
    await screen.findByAltText(/Encoded gptgif v4/);
    assert.equal(screen.getByRole("link", { name: /Download/ }).getAttribute("download"), "mirror-convert.gptgif-v4.gif");
    selectFormat("gptgif");
    click("Encode");
    await screen.findByAltText(/Encoded gptgif original/);
    assert.equal(screen.getByRole("link", { name: /Download/ }).getAttribute("download"), "mirror-convert.gptgif.gif");
    click(/Fortune cookie/);
    await screen.findByText("fortune offline");
    selectFormat("pngspeak");
    click("Encode");
    await screen.findByText(/HTTP 503/);
  });

  test("handles non-Error decode failures and empty file picker selections", async () => {
    mount({ fetcher: (async (input) => {
      if (String(input).includes("/decode")) throw "decode offline";
      return json({});
    }) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "AQID" } });
    click("Decode");
    await screen.findByText("Decoding failed.");
    fireEvent.change(screen.getByLabelText(/pick a file/), { target: { files: [] } });
    assert.equal(screen.queryByText("Encoding…"), null);
  });

  test("decodes a non-empty LoaF archive and safely ignores an artifact without prompt source bytes", async () => {
    const requests: string[] = [];
    mount({ fetcher: (async (input) => String(input).includes("loaf/decode")
      ? json({ entries: [{ bytes: 2, contentBase64: enc("ok") }] })
      : String(input).includes("fortune") ? new Response(Buffer.from([1])) : (requests.push(String(input)), json({})) ) as typeof fetch });
    selectFormat("loaf");
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "some loaf" } });
    click("Decode");
    await screen.findByText("ok");
    click(/Fortune cookie/);
    await screen.findByText(/Your fortune, hidden inside/);
    const promptButton = screen.getAllByRole("button", { name: /Insert decode-prompt/ }).at(-1) as HTMLButtonElement;
    promptButton.disabled = false;
    click(/Insert decode-prompt/);
    assert.equal(requests.some(url => url.includes("gpt-prompt")), false);
  });

  test("decodes text and binary, provides downloads, and inserts decoded text", async () => {
    const { inserted } = mount({ fetcher: (async (input) => String(input).includes("/decode")
      ? json({ bytes: 5, dataBase64: enc("hello") }) : json({}) ) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "AQID" } });
    click("Decode");
    await screen.findByText("hello");
    click(/Insert decoded text/);
    assert.deepEqual(inserted, ["hello"]);
    assert.ok(screen.getByRole("link", { name: /Download decoded bytes/ }));
    cleanup();
    mount({ fetcher: (async (input) => String(input).includes("/decode") ? json({ bytes: 1, dataBase64: "/w==" }) : json({})) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "bad bytes" } });
    click("Decode");
    await screen.findByText(/aren't valid UTF-8 text/);
    assert.equal(screen.queryByRole("button", { name: /Insert decoded text/ }), null);
  });

  test("LoaF decode rejects empty archives and gptgif failures explain the calibration hint", async () => {
    mount({ fetcher: (async (input) => String(input).includes("loaf/decode") ? json({ entries: [] }) : json({ error: "no fixed map" }, 400)) as typeof fetch });
    selectFormat("loaf");
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "not-empty" } });
    click("Decode");
    await screen.findByText("That LoaF archive has no entries.");
    selectFormat("gptgif");
    fireEvent.change(screen.getByLabelText(/Decode/), { target: { value: "bad" } });
    click("Decode");
    await screen.findByText(/no fixed map.*fixed alphabet/);
  });

  test("disabled and Playground modes keep chat mutations unavailable while encoding remains usable", async () => {
    mount({ chatModeActive: false, disabled: true });
    click("Encode");
    await screen.findByAltText(/Encoded PngSpeak/);
    assert.equal((screen.getByRole("button", { name: /Attach to chat/ }) as HTMLButtonElement).disabled, true);
  });

  test("non-Error fetch rejections use the component's fallback messages", async () => {
    mount({ fetcher: (async () => { throw "offline string"; }) as typeof fetch });
    click("Encode");
    await screen.findByText("Encoding failed");
    click(/Mystery encode/);
    await screen.findByText("That didn't work");
  });
});
