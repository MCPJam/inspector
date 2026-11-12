import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { errorMock, warnMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
}));
vi.mock("../../logger.js", () => ({
  logger: { error: errorMock, warn: warnMock, info: vi.fn(), debug: vi.fn() },
}));

import { touchSandbox } from "../control-plane-client.js";

describe("touchSandbox", () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token-0123456789";
    errorMock.mockClear();
    warnMock.mockClear();
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  it("a network failure is a retryable miss that does not page", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    }) as unknown as typeof fetch;
    await expect(
      touchSandbox({ sandboxRowId: "row-1", sandboxId: "sbx-1" }),
    ).resolves.toEqual({ outcome: "failed" });
    expect(errorMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("maps 404/409 to gone and 2xx to touched, with the window the backend sent", async () => {
    const reply = (status: number, body: unknown = {}) =>
      (global.fetch = vi.fn(
        async () => new Response(JSON.stringify(body), { status }),
      ) as unknown as typeof fetch);
    const touch = () => touchSandbox({ sandboxRowId: "r", sandboxId: "s" });
    reply(200, { ok: true, lastUsedAt: 1, idleMs: 300_000 });
    expect(await touch()).toEqual({ outcome: "touched", idleMs: 300_000 });
    // An older control plane sends no window: still a touch.
    reply(200);
    expect(await touch()).toEqual({ outcome: "touched" });
    reply(200, { idleMs: "soon" });
    expect(await touch()).toEqual({ outcome: "touched" });
    // A 2xx with a null body (or one that is not JSON) is still a touch.
    reply(200, null);
    expect(await touch()).toEqual({ outcome: "touched" });
    // A window that would become a runaway heartbeat is no window at all.
    for (const idleMs of [3, 300_000.5, 10 * 24 * 60 * 60_000, -1]) {
      reply(200, { idleMs });
      expect(await touch()).toEqual({ outcome: "touched" });
    }
    reply(404);
    expect(await touch()).toEqual({ outcome: "gone" });
    reply(409);
    expect(await touch()).toEqual({ outcome: "gone" });
    reply(500);
    expect(await touch()).toEqual({ outcome: "failed" });
  });
});
