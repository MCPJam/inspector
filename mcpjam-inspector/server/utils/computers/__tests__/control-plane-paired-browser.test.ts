import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { error: vi.fn(), warn: warnMock, info: vi.fn(), debug: vi.fn() },
}));

import {
  provisionEvalSandbox,
  provisionJourneySandbox,
} from "../control-plane-client.js";

/**
 * A run that pins an image and declares a browser asks for a desktop with
 * `pairBrowser`; a backend that supports it answers with the pinned terminal
 * box and the desktop beside it. One that does not ignores the field, which
 * is why it is only ever sent with a desktop request.
 */
describe("provision with a paired browser", () => {
  const realFetch = global.fetch;
  let bodies: Array<Record<string, unknown>>;
  let reply: Record<string, unknown>;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    bodies = [];
    reply = { sandboxId: "sbx-1", sandboxRowId: "row-1" };
    warnMock.mockClear();
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  const paired = {
    sandboxId: "sbx-1",
    sandboxRowId: "row-1",
    runtimeKind: "terminal",
    workdir: "/workspace",
    browser: {
      sandboxId: "sbx-2",
      sandboxRowId: "row-2",
      runtimeKind: "desktop-browser",
      capabilities: ["bash", "browser"],
    },
  };

  it("sends pairBrowser on an eval desktop request and returns both boxes", async () => {
    reply = paired;
    const result = await provisionEvalSandbox({
      bearer: "token",
      runId: "run-1",
      iterationId: "iter-1",
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    expect(bodies[0]).toEqual({
      runId: "run-1",
      iterationId: "iter-1",
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    expect(result).toEqual({ ok: true, value: paired });
  });

  it("sends pairBrowser on a journey desktop request and returns both boxes", async () => {
    reply = paired;
    const result = await provisionJourneySandbox({
      bearer: "token",
      runId: "run-1",
      targetId: "target-1",
      sessionIdx: 0,
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    expect(bodies[0]).toEqual({
      runId: "run-1",
      targetId: "target-1",
      sessionIdx: 0,
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    expect(result).toEqual({ ok: true, value: paired });
  });

  it("leaves a request without it byte-identical", async () => {
    await provisionEvalSandbox({ bearer: "token", runId: "run-1" });
    await provisionJourneySandbox({
      bearer: "token",
      runId: "run-1",
      targetId: "target-1",
      sessionIdx: 0,
    });
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify({ runId: "run-1" }));
    expect(bodies[1]).toEqual({
      runId: "run-1",
      targetId: "target-1",
      sessionIdx: 0,
    });
  });

  it.each([
    ["no row id", { sandboxId: "sbx-2", runtimeKind: "desktop-browser" }],
    [
      "a terminal kind",
      { sandboxId: "sbx-2", sandboxRowId: "row-2", runtimeKind: "terminal" },
    ],
    ["not an object", "sbx-2"],
  ])("drops a paired box with %s, so the caller sees a terminal answer", async (_label, browser) => {
    reply = { ...paired, browser };
    const evalResult = await provisionEvalSandbox({
      bearer: "token",
      runId: "run-1",
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    const journeyResult = await provisionJourneySandbox({
      bearer: "token",
      runId: "run-1",
      targetId: "target-1",
      sessionIdx: 0,
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    for (const result of [evalResult, journeyResult]) {
      if (!result.ok) throw new Error("expected a box");
      expect(result.value.sandboxRowId).toBe("row-1");
      expect(result.value.browser).toBeUndefined();
    }
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it("passes an unpaired desktop answer through untouched", async () => {
    reply = {
      sandboxId: "sbx-1",
      sandboxRowId: "row-1",
      runtimeKind: "desktop-browser",
    };
    const result = await provisionEvalSandbox({
      bearer: "token",
      runId: "run-1",
      runtimeKind: "desktop-browser",
      pairBrowser: true,
    });
    expect(result).toEqual({ ok: true, value: reply });
    expect(warnMock).not.toHaveBeenCalled();
  });
});
