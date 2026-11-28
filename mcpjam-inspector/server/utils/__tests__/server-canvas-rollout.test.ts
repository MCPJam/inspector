import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  flagAccountEmail: vi.fn(),
  validateGuestToken: vi.fn(),
  verifyAuthKitToken: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return {
      isFeatureEnabled: mocks.isFeatureEnabled,
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
vi.mock("../flag-account.js", () => ({
  flagAccountEmail: mocks.flagAccountEmail,
}));
vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: mocks.validateGuestToken,
}));
vi.mock("../../services/authkit-jwt.js", () => ({
  verifyAuthKitToken: mocks.verifyAuthKitToken,
}));
vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  HOSTED_MODE: false,
}));

import {
  ROLLOUT_ANSWER_TTL_MS,
  SERVER_CANVAS_FLAG,
  resetServerCanvasRolloutForTests,
  resolveServerCanvasRollout,
} from "../server-canvas-rollout.js";
import { shutdownAnalytics } from "../analytics.js";

const MEMBER = "user_01H00000000000000000000000";

beforeEach(() => {
  resetServerCanvasRolloutForTests();
  vi.clearAllMocks();
  delete process.env.DO_NOT_TRACK;
  delete process.env.MCPJAM_FEATURE_FLAGS_FILE;
  mocks.validateGuestToken.mockResolvedValue({ valid: false });
  mocks.verifyAuthKitToken.mockResolvedValue({ sub: MEMBER, sid: "sess_1" });
  mocks.flagAccountEmail.mockResolvedValue("member@example.test");
});

afterEach(async () => {
  vi.useRealTimers();
  await shutdownAnalytics();
});

describe("resolveServerCanvasRollout", () => {
  it("is on when PostHog says yes for the verified member, with the flags route's properties", async () => {
    mocks.isFeatureEnabled.mockResolvedValue(true);

    await expect(resolveServerCanvasRollout("Bearer token-1")).resolves.toBe(
      true,
    );
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
      SERVER_CANVAS_FLAG,
      MEMBER,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          deployment: "self_hosted",
          email: "member@example.test",
        },
      },
    );
  });

  it("keeps a yes for a minute without asking again", async () => {
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await resolveServerCanvasRollout("token-1");
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(true);
    expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.flagAccountEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps a no for a minute without asking again, then asks", async () => {
    vi.useFakeTimers();
    mocks.isFeatureEnabled.mockResolvedValue(false);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.flagAccountEmail).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ROLLOUT_ANSWER_TTL_MS);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(true);
    expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(2);
  });

  it("is off when evaluation fails, and does not keep the failure", async () => {
    mocks.isFeatureEnabled.mockRejectedValueOnce(new Error("posthog down"));
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    // PostHog answered nothing for the flag: no decision to keep either.
    mocks.isFeatureEnabled.mockResolvedValueOnce(undefined);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(true);
    expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(3);
  });

  it("is off when the bearer does not verify or is missing", async () => {
    mocks.verifyAuthKitToken.mockRejectedValue(new Error("bad token"));
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    await expect(resolveServerCanvasRollout(undefined)).resolves.toBe(false);
    await expect(resolveServerCanvasRollout("Bearer ")).resolves.toBe(false);
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("is off under DO_NOT_TRACK without asking PostHog", async () => {
    process.env.DO_NOT_TRACK = "1";
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(false);
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("reads a flag file's answer for every identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-canvas-flags-"));
    const path = join(dir, "flags.json");
    writeFileSync(path, JSON.stringify({ [SERVER_CANVAS_FLAG]: true }));
    process.env.MCPJAM_FEATURE_FLAGS_FILE = path;
    try {
      await expect(resolveServerCanvasRollout("token-1")).resolves.toBe(true);
      expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
    } finally {
      delete process.env.MCPJAM_FEATURE_FLAGS_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evaluates a guest by its guest id, without an account lookup", async () => {
    mocks.validateGuestToken.mockResolvedValue({
      valid: true,
      guestId: "0192a3f1-8c5e-7b3d-8f21-6a4c9e0d1b2f",
    });
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await expect(resolveServerCanvasRollout("guest-token")).resolves.toBe(true);
    expect(mocks.flagAccountEmail).not.toHaveBeenCalled();
    expect(mocks.isFeatureEnabled.mock.calls[0]?.[1]).toBe(
      "0192a3f1-8c5e-7b3d-8f21-6a4c9e0d1b2f",
    );
  });
});
