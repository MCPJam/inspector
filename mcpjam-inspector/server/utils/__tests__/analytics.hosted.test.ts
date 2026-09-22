import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

// HOSTED_MODE is a module-load-time const, so it has to be mocked before
// importing analytics.ts. Kept in its own file so the main analytics tests
// (analytics.test.ts) run with the real (local, self-hosted) config.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, HOSTED_MODE: true };
});

const captureMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => ({ capture: captureMock, shutdown: shutdownMock })),
}));

import { captureServerEvent, shutdownAnalytics } from "../analytics.js";

function fakeContext(overrides: {
  requestLogContext?: Record<string, unknown>;
}): Context {
  return {
    var: { requestLogContext: overrides.requestLogContext },
    get: () => undefined,
  } as unknown as Context;
}

describe("captureServerEvent (hosted mode)", () => {
  beforeEach(() => {
    captureMock.mockClear();
    delete process.env.VITE_DISABLE_POSTHOG_LOCAL;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(async () => {
    await shutdownAnalytics();
  });

  it("stamps deployment: hosted", () => {
    captureServerEvent(
      fakeContext({ requestLogContext: { userExternalId: "u1" } }),
      "send_message_server",
    );
    expect(captureMock.mock.calls[0][0].properties.deployment).toBe(
      "hosted",
    );
  });
});
