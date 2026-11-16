import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getHarnessCredentialReadiness } from "../control-plane-client.js";

describe("getHarnessCredentialReadiness", () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  const ask = () =>
    getHarnessCredentialReadiness({
      bearer: "member-token",
      projectId: "project-1",
      harnessId: "cursor",
    });
  const reply = (body: string, status = 200) =>
    (global.fetch = vi.fn(
      async () => new Response(body, { status }),
    ) as unknown as typeof fetch);

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  it.each(["ready", "missing", "invalid"] as const)(
    "passes %s through",
    async (readiness) => {
      reply(JSON.stringify({ readiness }));
      await expect(ask()).resolves.toEqual({ ok: true, value: { readiness } });
    },
  );

  it.each([
    ["a 2xx body that is not JSON", "<html>gateway</html>"],
    ["an answer it does not know", JSON.stringify({ readiness: "maybe" })],
  ])("reads %s as an unexpected answer, not a crash", async (_case, body) => {
    reply(body);
    await expect(ask()).resolves.toEqual({
      ok: false,
      status: 502,
      error: "unexpected readiness answer",
    });
  });
});
