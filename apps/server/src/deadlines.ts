export function deadlineMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 3_600_000 ? parsed : fallback;
}

/** Cancellation races also bound credential refreshes that have no signal API. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", listener!); }
}

export function turnDeadline(controller: AbortController) {
  const fail = () => controller.abort(Object.assign(new Error("Generation deadline exceeded"), { statusCode: 504 }));
  const total = setTimeout(fail, deadlineMs(process.env.MIRROR_TURN_TIMEOUT_MS, 900_000));
  const idleMs = deadlineMs(process.env.MIRROR_IDLE_TIMEOUT_MS, 120_000);
  let idle = setTimeout(fail, idleMs);
  return {
    touch() { clearTimeout(idle); idle = setTimeout(fail, idleMs); },
    close() { clearTimeout(total); clearTimeout(idle); },
  };
}
