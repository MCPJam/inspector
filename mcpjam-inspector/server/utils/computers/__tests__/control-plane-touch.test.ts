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
    ).resolves.toBe("failed");
    expect(errorMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("maps 404/409 to gone and 2xx to touched", async () => {
    const reply = (status: number) =>
      (global.fetch = vi.fn(
        async () => new Response("{}", { status }),
      ) as unknown as typeof fetch);
    reply(200);
    expect(await touchSandbox({ sandboxRowId: "r", sandboxId: "s" })).toBe(
      "touched",
    );
    reply(404);
    expect(await touchSandbox({ sandboxRowId: "r", sandboxId: "s" })).toBe(
      "gone",
    );
    reply(409);
    expect(await touchSandbox({ sandboxRowId: "r", sandboxId: "s" })).toBe(
      "gone",
    );
    reply(500);
    expect(await touchSandbox({ sandboxRowId: "r", sandboxId: "s" })).toBe(
      "failed",
    );
  });
});
