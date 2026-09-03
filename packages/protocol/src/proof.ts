/**
 * ChatGPT Web "sentinel" proof-of-work solver.
 *
 * Ported from the (already reverse-engineered and tested) Python implementation in
 * the `chatgpt-api` reference project: chatgpt_api/providers/chatgpt/proof.py.
 * That project has a passing test suite for this exact algorithm, so this is a
 * faithful port rather than an independent derivation.
 *
 * The server presents a `seed` + `difficulty` (hex string) via
 * POST /backend-api/sentinel/chat-requirements/prepare. The client must find an
 * `attempt` integer such that:
 *
 *   sha3_512(seed + base64(JSON.stringify(config-with-attempt))).hexdigest()
 *
 * has a hex prefix <= difficulty (lexicographic compare on the first
 * `difficulty.length` hex chars). The winning token is `"gAAAAAB" + base64(config)`.
 */

import pkg from "js-sha3";
import { Worker } from "node:worker_threads";
const { sha3_512 } = pkg;

export type ProofConfig = [
  number, // screen area (width*height-ish, synthetic)
  string, // parse_time, e.g. "Tue, 02 Sep 2026 04:00:00 GMT"
  null,
  number, // attempt counter (mutated each iteration)
  string | null, // user agent
  string, // fixed api.js URL sentinel uses internally
  string, // fixed deploy hash
  string, // "en"
  string, // "en-US"
  null,
  string, // "plugins−[object PluginArray]" (note: real minus sign U+2212)
  string, // random react-listening-prop name
  string, // random dom event name
];

const SCREEN_BASES = [3008, 4010, 6000];
const SCREEN_MULTS = [1, 2, 4];
const REACT_PROPS = [
  "_reactListeningcfilawjnerp",
  "_reactListening9ne2dfo1i47",
  "_reactListening410nzwhan2a",
];
const DOM_EVENTS = ["alert", "ontransitionend", "onprogress"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function defaultProofConfig(userAgent: string | null): ProofConfig {
  const screen = pick(SCREEN_BASES) * pick(SCREEN_MULTS);
  const now = new Date();
  const parseTime = now.toUTCString().replace("GMT", "GMT"); // matches "%a, %d %b %Y %H:%M:%S GMT"
  return [
    screen,
    parseTime,
    null,
    0,
    userAgent,
    "https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js",
    "dpl=1440a687921de39ff5ee56b92807faaadce73f13",
    "en",
    "en-US",
    null,
    "plugins−[object PluginArray]",
    pick(REACT_PROPS),
    pick(DOM_EVENTS),
  ];
}

function b64(json: string): string {
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Decode the (optional) `dx`/proof-config hint the server sometimes sends
 * embedded in a `gAAAAAB...~...` style header/string, mirroring
 * decode_proof_config in the Python reference. Returns null if not present
 * or not parseable — callers should fall back to a freshly generated config.
 */
export function decodeProofConfig(proofHeader: string | null | undefined): unknown[] | null {
  if (!proofHeader || !proofHeader.includes("gAAAAAB")) return null;
  const afterMarker = proofHeader.split("gAAAAAB", 2)[1];
  if (!afterMarker) return null;
  let encoded = afterMarker.split("~", 1)[0];
  const pad = (4 - (encoded.length % 4)) % 4;
  encoded += "=".repeat(pad);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface GenerateProofOptions {
  required: boolean;
  seed?: string;
  difficulty?: string;
  userAgent?: string | null;
  proofConfig?: ProofConfig | null;
  maxAttempts?: number;
}

/**
 * Solve the proof-of-work challenge. Returns the `gAAAAAB...` token to send as
 * `openai-sentinel-proof-token`, or null if `required` is false.
 */
export function generateProofToken(opts: GenerateProofOptions): string | null {
  const { required, seed = "", difficulty = "", userAgent = null, proofConfig = null, maxAttempts = 100_000 } = opts;
  if (!required) return null;
  if (!seed || !difficulty || !/^[0-9a-f]+$/i.test(difficulty)) throw new Error("Invalid required proof-of-work challenge");

  const proof: ProofConfig = proofConfig ? ([...proofConfig] as ProofConfig) : defaultProofConfig(userAgent);
  const difficultyLen = difficulty.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    proof[3] = attempt;
    const proofJson = JSON.stringify(proof);
    const proofBase = b64(proofJson);
    const hashValue = sha3_512(seed + proofBase);
    if (hashValue.slice(0, difficultyLen) <= difficulty) {
      return "gAAAAAB" + proofBase;
    }
  }

  // Fallback token used by the real client when it gives up (matches reference impl).
  const fallbackBase = b64(`"${seed}"`);
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}


/**
 * Cooperative async PoW solver. It yields back to Node's event loop every
 * `yieldEvery` attempts so one expensive Sentinel challenge cannot freeze the
 * Fastify process for every other request.
 */
export async function generateProofTokenAsync(
  opts: GenerateProofOptions & { yieldEvery?: number },
): Promise<string | null> {
  const {
    required,
    seed = "",
    difficulty = "",
    userAgent = null,
    proofConfig = null,
    maxAttempts = 100_000,
    yieldEvery = 1_000,
  } = opts;
  if (!required) return null;
  if (!seed || !difficulty || !/^[0-9a-f]+$/i.test(difficulty)) throw new Error("Invalid required proof-of-work challenge");

  const proof: ProofConfig = proofConfig
    ? ([...proofConfig] as ProofConfig)
    : defaultProofConfig(userAgent);
  const difficultyLen = difficulty.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    proof[3] = attempt;
    const proofJson = JSON.stringify(proof);
    const proofBase = b64(proofJson);
    const hashValue = sha3_512(seed + proofBase);
    if (hashValue.slice(0, difficultyLen) <= difficulty) {
      return "gAAAAAB" + proofBase;
    }
    if (attempt > 0 && attempt % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const fallbackBase = b64(`"${seed}"`);
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}

/** Run CPU-bound Sentinel work outside the server event loop. */
export function generateProofTokenInWorker(opts: GenerateProofOptions, signal?: AbortSignal): Promise<string | null> {
  if (!opts.required) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./proof-worker.js", import.meta.url), { workerData: opts });
    const abort = () => {
      void worker.terminate();
      reject(new DOMException("Proof generation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      signal?.removeEventListener("abort", abort);
      resolve(message as string | null);
    });
    worker.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code !== 0 && !signal?.aborted) reject(new Error(`Proof worker exited with code ${code}`));
    });
    if (signal?.aborted) abort();
  });
}
