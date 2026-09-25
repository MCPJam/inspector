import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  getAllFlags: vi.fn(),
  constructPostHog: vi.fn(),
  validateGuestToken: vi.fn(),
  verifyAuthKitToken: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => {
    mocks.constructPostHog();
    return {
      getAllFlags: mocks.getAllFlags,
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: mocks.validateGuestToken,
}));

vi.mock("../../../services/authkit-jwt.js", () => ({
  verifyAuthKitToken: mocks.verifyAuthKitToken,
}));

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: false,
}));

import clientFlags from "../flags.js";
import { shutdownAnalytics } from "../../../utils/analytics.js";
import { CLIENT_FEATURE_FLAG_KEYS } from "../../../../shared/client-feature-flags.js";

// posthog-js generates a v7 UUID for a visitor it has not identified.
const ANONYMOUS_ID = "0192a3f1-8c5e-7b3d-8f21-6a4c9e0d1b2f";

function createApp() {
  const app = new Hono();
  app.route("/api/web/flags", clientFlags);
  return app;
}

async function getFlags(query = "", headers: Record<string, string> = {}) {
  const response = await createApp().request(`/api/web/flags${query}`, {
    headers,
  });
  return { response, body: (await response.json()) as { flags: unknown } };
}

describe("GET /api/web/flags", () => {
  beforeEach(() => {
    mocks.getAllFlags.mockReset().mockResolvedValue({});
    mocks.constructPostHog.mockReset();
    mocks.validateGuestToken
      .mockReset()
      .mockResolvedValue({ valid: false, reason: "invalid" });
    mocks.verifyAuthKitToken
      .mockReset()
      .mockRejectedValue(new Error("not verified"));
  });

  afterEach(async () => {
    await shutdownAnalytics();
  });

  it("returns only allowlisted keys with flag-shaped values", async () => {
    mocks.getAllFlags.mockResolvedValueOnce({
      "computers-enabled": true,
      "guest-credit-wall-copy": "treatment",
      xaa: false,
      "unlisted-flag": true,
      "registry-enabled": { nested: true },
    });

    const { response, body } = await getFlags(`?distinct_id=${ANONYMOUS_ID}`);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      flags: {
        "computers-enabled": true,
        "guest-credit-wall-copy": "treatment",
        xaa: false,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Authorization");
  });

  it("evaluates exactly the allowlist, whatever the request names", async () => {
    await getFlags(
      `?distinct_id=${ANONYMOUS_ID}&flag_keys=unlisted-flag&key=unlisted-flag`,
    );

    expect(mocks.getAllFlags).toHaveBeenCalledTimes(1);
    const [distinctId, options] = mocks.getAllFlags.mock.calls[0];
    expect(distinctId).toBe(ANONYMOUS_ID);
    expect(options.flagKeys).toEqual([...CLIENT_FEATURE_FLAG_KEYS]);
    expect(options.flagKeys).not.toContain("unlisted-flag");
    expect(options).not.toHaveProperty("sendFeatureFlagEvents", true);
  });

  it("sends the person properties the server knows, and a known platform", async () => {
    await getFlags(`?distinct_id=${ANONYMOUS_ID}&platform=mac`);
    await getFlags(`?distinct_id=${ANONYMOUS_ID}&platform=unexpected`);

    expect(mocks.getAllFlags.mock.calls[0][1].personProperties).toEqual({
      deployment: "self_hosted",
      local_browser_security_version: "1",
      platform: "mac",
    });
    expect(mocks.getAllFlags.mock.calls[1][1].personProperties).toEqual({
      deployment: "self_hosted",
      local_browser_security_version: "1",
    });
  });

  it("evaluates the verified guest, not a distinct_id the request names", async () => {
    mocks.validateGuestToken.mockResolvedValueOnce({
      valid: true,
      guestId: "guest-7",
    });

    await getFlags("?distinct_id=user_someone_else", {
      Authorization: "Bearer guest-token",
    });

    expect(mocks.validateGuestToken).toHaveBeenCalledWith("guest-token");
    expect(mocks.getAllFlags.mock.calls[0][0]).toBe("guest-7");
  });

  it("evaluates the verified signed-in user", async () => {
    mocks.verifyAuthKitToken.mockResolvedValueOnce({ sub: "user_1" });

    await getFlags("?distinct_id=user_someone_else", {
      Authorization: "Bearer access-token",
    });

    expect(mocks.verifyAuthKitToken).toHaveBeenCalledWith("access-token");
    expect(mocks.getAllFlags.mock.calls[0][0]).toBe("user_1");
  });

  it("answers an unverified bearer with no values", async () => {
    const { response, body } = await getFlags("?distinct_id=user_1", {
      Authorization: "Bearer unverified-token",
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ flags: {} });
    expect(mocks.getAllFlags).not.toHaveBeenCalled();
  });

  it.each([
    ["no identity", ""],
    ["an oversized id", `?distinct_id=${"x".repeat(201)}`],
    ["an id with spaces", "?distinct_id=two%20words"],
    ["a signed-in user's id without a bearer", "?distinct_id=user_01HZX5J8K2"],
    [
      "a guest id without a bearer",
      "?distinct_id=5b0e3c6d-2f1a-4e8b-9c7d-1a2b3c4d5e6f",
    ],
  ])("answers %s with no values", async (_name, query) => {
    const { response, body } = await getFlags(query);

    expect(response.status).toBe(200);
    expect(body).toEqual({ flags: {} });
    expect(mocks.getAllFlags).not.toHaveBeenCalled();
  });

  it("answers with defaults when PostHog is unavailable", async () => {
    mocks.getAllFlags.mockRejectedValueOnce(new Error("unavailable"));
    const failed = await getFlags(`?distinct_id=${ANONYMOUS_ID}`);
    expect(failed.response.status).toBe(200);
    expect(failed.body).toEqual({ flags: {} });

    await shutdownAnalytics();
    mocks.constructPostHog.mockImplementationOnce(() => {
      throw new Error("not configured");
    });
    const unconfigured = await getFlags(`?distinct_id=${ANONYMOUS_ID}`);
    expect(unconfigured.response.status).toBe(200);
    expect(unconfigured.body).toEqual({ flags: {} });
  });
});
