import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudflareTrace } from "../dist/egress.js";

test("parses Cloudflare trace fields without requiring IP data", () => {
  const trace = parseCloudflareTrace("fl=123\r\nip=203.0.113.8\r\nwarp=on\r\nloc=YY\r\n");
  assert.equal(trace.warp, "on");
  assert.equal(trace.fl, "123");
});

test("does not mistake malformed trace lines for fields", () => {
  assert.deepEqual(parseCloudflareTrace("warp\n=on\nwarp=off\n"), { warp: "off" });
});
