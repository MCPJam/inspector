import assert from "node:assert/strict";
import test from "node:test";
import { attachCliDurationMs } from "../src/lib/rpc-logs.js";

test("attachCliDurationMs adds _durationMs on objects", () => {
  const payload = attachCliDurationMs(
    { content: [{ type: "text", text: "ok" }] },
    42,
  );
  assert.deepEqual(payload, {
    content: [{ type: "text", text: "ok" }],
    _durationMs: 42,
  });
});

test("attachCliDurationMs leaves arrays unchanged", () => {
  const items = [{ name: "echo" }, { name: "ping" }];
  const payload = attachCliDurationMs(items, 42);
  assert.equal(payload, items);
  assert.equal("_durationMs" in (payload as object), false);
});

test("attachCliDurationMs leaves non-objects unchanged", () => {
  assert.equal(attachCliDurationMs("ok", 42), "ok");
  assert.equal(attachCliDurationMs(null, 42), null);
  assert.equal(attachCliDurationMs(undefined, 42), undefined);
});
