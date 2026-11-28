import { describe, expect, it } from "vitest";
import { forRevision } from "../legacy-result.js";
import { isModern, REVISIONS, useProtocolHarness } from "./protocol-harness.js";
import type { Revision } from "./protocol-harness.js";

const h = useProtocolHarness();
const LEGACY = REVISIONS.filter((r) => !isModern(r));

const MODERN_ONLY = ["resultType", "ttlMs", "cacheScope"];

/**
 * The mock reaches the real server on 2026-07-28 while the caller speaks a
 * 2025 revision. What the caller reads must equal what the real server sends
 * that caller directly, so no 2026-07-28 field shows up.
 */
describe.each(LEGACY)("a forwarded result on %s", (revision) => {
  async function both(method: string, params: Record<string, unknown>) {
    h.state.withPrompts = true;
    const { handler } = await h.connect(
      {},
      { revision, backed: true, realRevision: "2026-07-28" }
    );
    return {
      mock: await h.rpc(handler, revision, method, params),
      direct: await h.rpc(h.realHandler!, revision, method, params),
    };
  }

  it.each([
    ["tools/call", { name: "echo", arguments: { message: "x" } }],
    ["prompts/get", { name: "greet", arguments: { who: "Ada" } }],
    ["resources/read", { uri: "test://greeting" }],
  ])("%s equals the real server's own answer", async (method, params) => {
    const { mock, direct } = await both(method, params);
    expect(direct.result).toBeDefined();
    expect(mock.result).toEqual(direct.result);
    const text = JSON.stringify(mock.result);
    for (const field of [...MODERN_ONLY, "io.modelcontextprotocol/serverInfo"]) {
      expect(text).not.toContain(field);
    }
  });
});

describe("a forwarded result on 2026-07-28", () => {
  it("keeps the fields that revision defines", async () => {
    const revision: Revision = "2026-07-28";
    const { handler } = await h.connect({}, { revision, backed: true });
    const params = { name: "echo", arguments: { message: "x" } };
    const called = await h.rpc(handler, revision, "tools/call", params);
    const direct = await h.rpc(h.realHandler!, revision, "tools/call", params);
    expect(called.result).toMatchObject({
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": expect.anything() },
    });
    expect(called.result).toEqual(direct.result);
  });
});

describe("forRevision", () => {
  const modern = {
    content: [],
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "a", version: "1" }, vendor: 1 },
  };

  it("drops the 2026-07-28 fields for a 2025 caller and keeps the rest of `_meta`", () => {
    expect(forRevision(modern, "2025-11-25")).toEqual({ content: [], _meta: { vendor: 1 } });
  });

  it("removes `_meta` when only the server info was in it", () => {
    expect(forRevision({ _meta: { "io.modelcontextprotocol/serverInfo": {} } }, "2025-06-18")).toEqual({});
  });

  it("returns a 2026-07-28 result as it is", () => {
    expect(forRevision(modern, "2026-07-28")).toBe(modern);
  });
});
