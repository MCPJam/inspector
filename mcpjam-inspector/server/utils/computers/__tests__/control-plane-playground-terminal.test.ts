import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  preparePlaygroundTerminalSandbox,
  provisionPlaygroundTerminalSandbox,
  touchSandbox,
} from "../control-plane-client.js";

describe("provisionPlaygroundTerminalSandbox", () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  let calls: Array<{ url: string; init: RequestInit }>;
  let respond: () => Response;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    calls = [];
    respond = () => new Response("{}", { status: 200 });
    global.fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond();
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("posts the conversation and the chosen environment under the member's bearer", async () => {
    respond = () =>
      json(200, { sandboxRowId: "row", sandboxId: "sbx", workdir: "/w" });
    const result = await provisionPlaygroundTerminalSandbox({
      bearer: "token",
      projectId: "p1",
      chatSessionId: "c1",
      projectEnvironmentId: "env_1",
    });
    expect(result).toEqual({
      ok: true,
      value: { sandboxRowId: "row", sandboxId: "sbx", workdir: "/w" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://example.convex.site/playground/sandbox/terminal/provision",
    );
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      projectId: "p1",
      chatSessionId: "c1",
      projectEnvironmentId: "env_1",
    });
  });

  it("prepares on its own route, sending no purpose to the turn's", async () => {
    respond = () => json(404, { error: "Not found" });
    const result = await preparePlaygroundTerminalSandbox({
      bearer: "token",
      projectId: "p1",
      chatSessionId: "c1",
      harness: "claude-code",
    });
    // A backend without the route answers 404, which reads as switched off.
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://example.convex.site/playground/sandbox/terminal/prepare",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      projectId: "p1",
      chatSessionId: "c1",
      harness: "claude-code",
    });
  });

  it("omits the environment when none is chosen", async () => {
    respond = () => json(200, { sandboxRowId: "row", sandboxId: "sbx" });
    await provisionPlaygroundTerminalSandbox({
      bearer: "token",
      projectId: "p1",
      chatSessionId: "c1",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      projectId: "p1",
      chatSessionId: "c1",
    });
  });

  it("says the box was prepared before Send only when the backend answers true", async () => {
    const box = { sandboxRowId: "row", sandboxId: "sbx" };
    const provision = () =>
      provisionPlaygroundTerminalSandbox({
        bearer: "token",
        projectId: "p1",
        chatSessionId: "c1",
      });
    respond = () => json(200, { ...box, prepared: true });
    expect(await provision()).toEqual({
      ok: true,
      value: { ...box, prepared: true },
    });
    for (const other of [false, "true", 1, null, {}]) {
      respond = () => json(200, { ...box, prepared: other });
      expect(await provision()).toEqual({ ok: true, value: box });
    }
  });

  it("hands a cap refusal back with its status and code, never retrying it", async () => {
    respond = () =>
      json(429, {
        error: "Live Playground computer limit (4) reached.",
        code: "user_terminal_cap",
      });
    const result = await provisionPlaygroundTerminalSandbox({
      bearer: "token",
      projectId: "p1",
      chatSessionId: "c1",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: "user_terminal_cap",
    });
    expect(calls).toHaveLength(1);
  });

  describe("capacity", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits out a full pool (or a box still starting up) instead of failing the turn", async () => {
      let n = 0;
      respond = () =>
        ++n < 3
          ? json(503, { error: "at capacity", code: "at_capacity" })
          : json(200, { sandboxRowId: "row", sandboxId: "sbx" });
      const pending = provisionPlaygroundTerminalSandbox({
        bearer: "token",
        projectId: "p1",
        chatSessionId: "c1",
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await pending).toEqual({
        ok: true,
        value: { sandboxRowId: "row", sandboxId: "sbx" },
      });
      expect(calls).toHaveLength(3);
    });

    it("gives up with a capacity refusal once the budget is spent", async () => {
      respond = () => json(503, { error: "at capacity", code: "at_capacity" });
      const pending = provisionPlaygroundTerminalSandbox({
        bearer: "token",
        projectId: "p1",
        chatSessionId: "c1",
        timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await pending).toMatchObject({
        ok: false,
        status: 503,
        code: "at_capacity",
      });
    });
  });
});

describe("touchSandbox", () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  let bodies: unknown[];
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    bodies = [];
    global.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  it("sends `ended` only on a turn's final touch", async () => {
    await touchSandbox({ sandboxRowId: "row", sandboxId: "sbx" });
    await touchSandbox({ sandboxRowId: "row", sandboxId: "sbx", ended: true });
    expect(bodies).toEqual([
      { sandboxRowId: "row", sandboxId: "sbx" },
      { sandboxRowId: "row", sandboxId: "sbx", ended: true },
    ]);
  });
});
