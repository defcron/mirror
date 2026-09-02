import { parentPort, workerData } from "node:worker_threads";
import { generateProofToken, type GenerateProofOptions } from "./proof.js";

try {
  parentPort?.postMessage(generateProofToken(workerData as GenerateProofOptions));
} catch (error) {
  throw error;
}
