import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudflareTrace } from "../dist/egress.js";

test.describe("server / egress", () => {
test("parses Cloudflare trace fields without requiring IP data", () => {
  const trace = parseCloudflareTrace(
    "fl=123\r\nip=203.0.113.8\r\nwarp=on\r\nloc=YY\r\n",
  );
  assert.equal(trace.warp, "on");
  assert.equal(trace.fl, "123");
});

test("does not mistake malformed trace lines for fields", () => {
  assert.deepEqual(parseCloudflareTrace("warp\n=on\nwarp=off\n"), {
    warp: "off",
  });
});

test("getEgressStatus reports a defensive copy of the current status", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const first = egress.getEgressStatus();
  assert.equal(first.mode, "direct");
  assert.equal(first.required, true);
  assert.equal(first.verified, false);
  first.mode = "warp"; // mutating the returned copy must not affect internal state
  assert.equal(egress.getEgressStatus().mode, "direct");
});

test("verifyRequiredEgress reports warp verified on a genuine trace", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("warp=on\nloc=YY\n", { status: 200 });
    const status = await egress.verifyRequiredEgress();
    assert.equal(status.mode, "warp");
    assert.equal(status.verified, true);
    assert.equal(status.error, null);
    assert.equal(egress.getEgressStatus().mode, "warp");
  } finally {
    globalThis.fetch = original;
  }
});

test("verifyRequiredEgress throws and records an error when the trace endpoint fails", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    await assert.rejects(egress.verifyRequiredEgress(), /WARP egress could not be verified/);
    const status = egress.getEgressStatus();
    assert.equal(status.mode, "direct");
    assert.equal(status.verified, false);
    assert.match(status.error, /HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});

test("verifyRequiredEgress throws when the trace doesn't actually report warp=on", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("warp=off\n", { status: 200 });
    await assert.rejects(egress.verifyRequiredEgress(), /did not report warp=on/);
  } finally {
    globalThis.fetch = original;
  }
});

test("verifyRequiredEgress records a generic message for a non-Error rejection", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw "not an Error instance";
    };
    await assert.rejects(egress.verifyRequiredEgress());
    assert.equal(egress.getEgressStatus().error, "WARP verification failed");
  } finally {
    globalThis.fetch = original;
  }
});

test("monitorRequiredEgress polls on an interval, skips overlapping checks, and can be cancelled", async () => {
  const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
  const original = globalThis.fetch;
  const failures = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  try {
    globalThis.fetch = async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return new Response("warp=off\n", { status: 200 });
    };
    const stop = egress.monitorRequiredEgress((error) => failures.push(error), 10);
    // Let several ticks elapse - the 30ms check duration against a 10ms
    // interval means most ticks are skipped by the in-flight guard, so this
    // asserts "it polls repeatedly and never overlaps", not an exact count.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(failures.length >= 1, "at least one failure should have been reported");
    assert.ok(failures[0] instanceof Error);
    assert.equal(maxConcurrent, 1, "a slow check in flight must not overlap with the next tick");

    stop();
    // A check already in flight at the moment stop() is called is allowed to
    // finish (stop() only prevents the *next* tick's check from starting),
    // so wait out that one straggler before taking the "settled" baseline.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const failuresAtStop = failures.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(failures.length, failuresAtStop, "no more checks should fire once any in-flight check settles after stop()");
  } finally {
    globalThis.fetch = original;
  }
});
});
