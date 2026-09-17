import { useState } from "react";
import type { PlaygroundAttachment } from "./playground-history.js";

type FormatId = "loaf" | "pngspeak" | "gptgif" | "gptgif-v4";

const FORMAT_LABELS: Record<FormatId, string> = {
  loaf: "LoaF (text archive)",
  pngspeak: "PngSpeak (real PNG)",
  gptgif: "gptgif original (real GIF)",
  "gptgif-v4": "gptgif v4 (real GIF, self-calibrating)",
};

const FORMAT_EXTENSIONS: Record<FormatId, string> = {
  loaf: "loaf",
  pngspeak: "pngspk.png",
  gptgif: "gptgif.gif",
  "gptgif-v4": "gptgif-v4.gif",
};

interface Artifact {
  format: FormatId;
  bytes: number;
  /** The encoded artifact's own bytes (a PNG/GIF/loaf-text), for preview/download/attach. */
  dataBase64: string;
  /** The original, pre-encoding payload bytes -- needed to build a fresh decode-prompt via
   * /api/convert/gpt-prompt, which always encodes from raw payload rather than re-wrapping
   * an already-encoded artifact. Absent for artifacts whose source text the server never
   * reveals (e.g. the fortune endpoint's randomly-picked string) -- the prompt button is
   * disabled in that case rather than sending a broken request. */
  sourceDataBase64?: string;
  mime: string;
  extension: string;
  /** Set for image-producing formats (pngspeak/gptgif/gptgif-v4) -- these are genuinely valid images despite hiding data inside. */
  isImage: boolean;
}

/** @internal Skips prompt building when the source payload is unknown to the client. */
export function withPromptSource<T>(sourceDataBase64: string | undefined, build: () => T): T | undefined {
  if (sourceDataBase64 === undefined) return undefined;
  return build();
}

function toBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}
/** Best-effort UTF-8 decode. Returns null for bytes that aren't valid text (e.g. decoding a pngspeak/gptgif artifact's own binary output back through the wrong format) instead of throwing. */
function tryFromBase64(base64: string): string | null {
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${url} returned HTTP ${res.status}`);
  return json;
}

export function ConversionTools({
  chatModeActive,
  disabled,
  onInsertText,
  onAttach,
}: {
  chatModeActive: boolean;
  disabled: boolean;
  onInsertText: (text: string) => void;
  onAttach: (attachment: PlaygroundAttachment) => void;
}) {
  const [format, setFormat] = useState<FormatId>("pngspeak");
  const [inputText, setInputText] = useState("A secret message, hidden in plain sight.");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [decodeInput, setDecodeInput] = useState("");
  const [decodedResult, setDecodedResult] = useState<{ text: string | null; dataBase64: string; bytes: number } | null>(null);
  const [funResult, setFunResult] = useState<{ label: string; artifact: Artifact } | null>(null);

  // Every mutation that reaches the chat (insert/attach) has to respect the
  // same "don't touch the transcript mid-run" rule as every other Playground
  // control -- `disabled` is running-or-reading-files, `busy` is this panel's
  // own in-flight request.
  const blocked = busy || disabled;

  function normalizeEncodeResult(res: any, sourceDataBase64: string): Artifact {
    if (format === "loaf") {
      return { format, bytes: res.bytes, dataBase64: toBase64(res.loaf), sourceDataBase64, mime: "text/plain", extension: FORMAT_EXTENSIONS[format], isImage: false };
    }
    const mime = format === "pngspeak" ? "image/png" : "image/gif";
    const extension = FORMAT_EXTENSIONS[format];
    return { format, bytes: res.bytes, dataBase64: res.dataBase64, sourceDataBase64, mime, extension, isImage: true };
  }

  async function readFileAsBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function encode(dataBase64: string) {
    setBusy(true);
    setStatus("Encoding…");
    setArtifact(null);
    try {
      const res =
        format === "loaf"
          ? await postJson("/api/convert/loaf/encode", { entries: [{ name: "message.txt", contentBase64: dataBase64 }] })
          : await postJson(`/api/convert/${format}/encode`, { dataBase64 });
      setArtifact(normalizeEncodeResult(res, dataBase64));
      setStatus(`Encoded ${res.bytes} bytes as ${FORMAT_LABELS[format]}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Encoding failed");
    } finally {
      setBusy(false);
    }
  }

  async function decode() {
    setBusy(true);
    setStatus("Decoding…");
    setDecodedResult(null);
    try {
      const res =
        format === "loaf"
          ? await (async () => {
              const decoded = await postJson("/api/convert/loaf/decode", { loaf: decodeInput.trim() });
              const first = decoded.entries?.[0];
              if (!first) throw new Error("That LoaF archive has no entries.");
              return { dataBase64: first.contentBase64, bytes: first.bytes };
            })()
          : await postJson(`/api/convert/${format}/decode`, { dataBase64: decodeInput.trim() });
      setDecodedResult({ text: tryFromBase64(res.dataBase64), dataBase64: res.dataBase64, bytes: res.bytes });
      setStatus(`Decoded ${res.bytes} bytes.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Decoding failed.";
      setStatus(format === "gptgif" ? `${message} (gptgif's original format has no fixed alphabet -- see the hint below.)` : message);
    } finally {
      setBusy(false);
    }
  }

  async function runFun(kind: "mystery" | "fortune") {
    setBusy(true);
    setStatus(kind === "mystery" ? "Picking a random format…" : "Reading a fortune…");
    try {
      if (kind === "mystery") {
        const sourceText = inputText || "hello";
        const res = await fetch(`/api/convert/mystery?text=${encodeURIComponent(sourceText)}`).then((r) => r.json());
        const mime = res.format === "loaf" ? "text/plain" : res.format === "pngspeak" ? "image/png" : "image/gif";
        setFunResult({
          label: `Mystery format: ${res.format} -- ${res.surprise}`,
          // The mystery endpoint returns the artifact only, but we know the
          // plaintext we sent it, so a decode-prompt can still be built.
          artifact: {
            format: res.format,
            bytes: res.bytes,
            dataBase64: res.dataBase64,
            sourceDataBase64: toBase64(sourceText),
            mime,
            extension: FORMAT_EXTENSIONS[res.format as FormatId],
            isImage: mime.startsWith("image/"),
          },
        });
      } else {
        const res = await fetch("/api/convert/fortune?format=pngspeak");
        const buffer = await res.arrayBuffer();
        let binary = "";
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        // No sourceDataBase64 here: the fortune text is a server-side random
        // pick that's never sent back to the client, so there's nothing to
        // rebuild a decode-prompt from -- the prompt button stays disabled.
        setFunResult({ label: "Your fortune, hidden inside a PngSpeak PNG:", artifact: { format: "pngspeak", bytes: buffer.byteLength, dataBase64: btoa(binary), mime: "image/png", extension: FORMAT_EXTENSIONS.pngspeak, isImage: true } });
      }
      setStatus("Ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  async function buildChatPrompt(art: Artifact) {
    return withPromptSource(art.sourceDataBase64, async () => {
      setBusy(true);
      setStatus("Building a chat prompt…");
      try {
        const res = await postJson("/api/convert/gpt-prompt", {
          dataBase64: art.sourceDataBase64,
          format: art.format,
          filename: `message.${art.extension}`,
        });
        onInsertText(res.prompt);
        setStatus("Prompt inserted into the current chat message below.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not build a prompt");
      } finally {
        setBusy(false);
      }
    });
  }

  function attach(art: Artifact) {
    onAttach({ name: `mirror-convert.${art.extension}`, mimeType: art.mime, dataUrl: `data:${art.mime};base64,${art.dataBase64}` });
    setStatus("Attached to the current chat message below.");
  }

  const artifactDataUrl = artifact ? `data:${artifact.mime};base64,${artifact.dataBase64}` : null;

  return (
    <div className="conversion-tools">
      <p className="field-hint">
        Encode text or a file into one of Mirror's ported steganographic formats, then drop the result straight into the
        chat on the left -- as a real attachment, or as a ready-to-paste decoding prompt.
      </p>
      <label>
        <span>Format</span>
        <select value={format} onChange={(event) => { setFormat(event.target.value as FormatId); setArtifact(null); }} disabled={busy}>
          {(Object.keys(FORMAT_LABELS) as FormatId[]).map((id) => (
            <option key={id} value={id}>
              {FORMAT_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Text to encode</span>
        <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} disabled={busy} />
      </label>
      <label className="attach-button">
        📎 Or pick a file to encode instead
        <input
          type="file"
          disabled={busy}
          style={{ display: "none" }}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void encode(await readFileAsBase64(file));
          }}
        />
      </label>
      <div className="conversion-actions">
        <button disabled={busy || !inputText.trim()} onClick={() => void encode(toBase64(inputText))}>
          Encode
        </button>
      </div>
      {status && <p role="status">{status}</p>}
      {artifact && artifactDataUrl && (
        <div className="conversion-result">
          {artifact.isImage && (
            <a href={artifactDataUrl} target="_blank" rel="noreferrer">
              <img className="conversion-preview-image" src={artifactDataUrl} alt={`Encoded ${FORMAT_LABELS[artifact.format]} artifact`} />
            </a>
          )}
          <div className="conversion-result-actions">
            <a href={artifactDataUrl} download={`mirror-convert.${artifact.extension}`}>
              ⬇ Download
            </a>
            <button disabled={blocked} onClick={() => void buildChatPrompt(artifact)}>
              💬 Insert decode-prompt into chat
            </button>
            <button disabled={blocked || !chatModeActive} title={!chatModeActive ? "Switch to Chat mode to attach files" : undefined} onClick={() => attach(artifact)}>
              📎 Attach to chat
            </button>
          </div>
        </div>
      )}

      <hr />
      <p className="field-hint">Mostly-useless fun buttons, because we can:</p>
      <div className="conversion-actions">
        <button disabled={busy} onClick={() => void runFun("mystery")}>
          🎁 Mystery encode
        </button>
        <button disabled={busy} onClick={() => void runFun("fortune")}>
          🥠 Fortune cookie
        </button>
      </div>
      {funResult && (
        <div className="conversion-result">
          <p>{funResult.label}</p>
          {funResult.artifact.isImage && <img className="conversion-preview-image" src={`data:${funResult.artifact.mime};base64,${funResult.artifact.dataBase64}`} alt={funResult.label} />}
          <div className="conversion-result-actions">
            <button
              disabled={blocked || funResult.artifact.sourceDataBase64 === undefined}
              title={funResult.artifact.sourceDataBase64 === undefined ? "This fortune's plaintext is a server-side surprise; there's nothing to build a decode-prompt from." : undefined}
              onClick={() => void buildChatPrompt(funResult.artifact)}
            >
              💬 Insert decode-prompt into chat
            </button>
            <button disabled={blocked || !chatModeActive} onClick={() => attach(funResult.artifact)}>
              📎 Attach to chat
            </button>
          </div>
        </div>
      )}

      <hr />
      <label>
        <span>Decode (paste base64 bytes, or a full .loaf line for LoaF)</span>
        <textarea value={decodeInput} onChange={(event) => setDecodeInput(event.target.value)} disabled={busy} placeholder="Paste the dataBase64/.loaf text from an encode above" />
      </label>
      <div className="conversion-actions">
        <button disabled={busy || !decodeInput.trim()} onClick={() => void decode()}>
          Decode
        </button>
      </div>
      {decodedResult && (
        <div className="conversion-result">
          {decodedResult.text !== null ? (
            <pre>{decodedResult.text}</pre>
          ) : (
            <p>Decoded {decodedResult.bytes} bytes that aren't valid UTF-8 text (probably a binary file, or the wrong format was selected).</p>
          )}
          <div className="conversion-result-actions">
            {decodedResult.text !== null && (
              <button disabled={blocked} onClick={() => onInsertText(decodedResult.text!)}>
                💬 Insert decoded text into chat
              </button>
            )}
            <a href={`data:application/octet-stream;base64,${decodedResult.dataBase64}`} download="decoded.bin">
              ⬇ Download decoded bytes
            </a>
          </div>
        </div>
      )}
      <p className="field-hint">
        For the original gptgif format, self-decoding needs a calibrated cluster map (the format doesn't have a fixed
        alphabet) -- use <code>/api/convert/gptgif/calibrate</code> directly, or ask a model to work it out from the
        decode-prompt above.
      </p>
    </div>
  );
}
