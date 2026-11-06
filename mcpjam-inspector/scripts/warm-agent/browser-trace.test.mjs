import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installBrowserTrace,
  browserTrace,
  restoreBrowserTrace,
} from "./browser-trace.mjs";

test("observes startup metadata without consuming or storing model output", async () => {
  const original = globalThis.fetch,
    location = globalThis.location;
  const body =
    'data: {"type":"data-harness-startup","data":{"phase":"agent"}}\n\n' +
    'data: {"type":"text-delta","delta":"PRIVATE_RESPONSE"}\n\n' +
    'data: {"type":"finish"}\n\n';
  const page = { evaluate: async (fn) => fn() };
  let ended = 0;
  globalThis.__warmAgentClock = { ended: () => ended++ };
  globalThis.location = { href: "http://localhost/" };
  globalThis.fetch = async () =>
    new Response(body, { headers: { "x-request-id": "request" } });
  try {
    await installBrowserTrace(page);
    const response = await fetch("http://localhost/api/web/chat-v2");
    assert.equal(await response.text(), body);
    await globalThis.__warmBrowserTrace.read;
    assert.equal(ended, 1);
    const trace = await browserTrace(page);
    assert.equal(trace.requestId, "request");
    assert.deepEqual(
      trace.events.map((e) => e.kind),
      ["agent", "text-delta", "finish"],
    );
    assert.ok(!JSON.stringify(trace).includes("PRIVATE_RESPONSE"));
    await restoreBrowserTrace(page);
  } finally {
    globalThis.fetch = original;
    globalThis.location = location;
    delete globalThis.__warmBrowserTrace;
    delete globalThis.__warmAgentClock;
  }
});
