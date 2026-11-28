import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { wakePlaygroundSandbox } from "../control-plane-client.js";

/**
 * What a wake sends. The backend takes the panel's user from the browser
 * token it minted, which the panel sends as the bearer; a backend that
 * predates that reads `verifiedUserId` beside the service credential, so the
 * panel sends both until every backend takes the token.
 */
describe("wakePlaygroundSandbox", () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token-0123456789";
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  const sent = () => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    return {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
  };

  it("sends the panel's browser token as the bearer, with the verified user for an older backend", async () => {
    await wakePlaygroundSandbox({
      bearer: "browser-token",
      sandboxRowId: "row-1",
      verifiedUserId: "users_1",
    });

    const request = sent();
    expect(request.url).toBe(
      "https://example.convex.site/playground/sandbox/wake",
    );
    expect(request.headers).toMatchObject({
      authorization: "Bearer browser-token",
      "x-inspector-service-token": "service-token-0123456789",
    });
    expect(request.body).toEqual({
      sandboxRowId: "row-1",
      verifiedUserId: "users_1",
    });
  });

  it("sends a user's own bearer alone, with no service credential", async () => {
    await wakePlaygroundSandbox({ bearer: "user-jwt", sandboxRowId: "row-1" });

    const request = sent();
    expect(request.headers).toMatchObject({ authorization: "Bearer user-jwt" });
    expect(request.headers).not.toHaveProperty("x-inspector-service-token");
    expect(request.body).toEqual({ sandboxRowId: "row-1" });
  });
});
