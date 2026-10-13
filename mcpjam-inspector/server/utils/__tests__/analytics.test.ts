import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const captureMock = vi.fn();
const flagMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return {
      capture: captureMock,
      shutdown: shutdownMock,
      isFeatureEnabled: flagMock,
    };
  }),
}));

// HOSTED_MODE is a module-load-time const computed from the ambient
// process.env — pinning it here (rather than relying on the CI shell
// happening not to have VITE_MCPJAM_HOSTED_MODE set) is what makes the
// "self_hosted" deployment assertion below deterministic. The hosted case
// is covered by analytics.hosted.test.ts, which pins the opposite value.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, HOSTED_MODE: false };
});

import {
  captureServerEvent,
  evaluateBrowserRollout,
  shutdownAnalytics,
} from "../analytics.js";

function fakeContext(overrides: {
  requestLogContext?: Record<string, unknown>;
  guestId?: string;
}): Context {
  return {
    var: { requestLogContext: overrides.requestLogContext },
    get: (key: string) =>
      key === "guestId" ? (overrides.guestId ?? undefined) : undefined,
  } as unknown as Context;
}

describe("captureServerEvent", () => {
  beforeEach(() => {
    captureMock.mockClear();
    delete process.env.VITE_DISABLE_POSTHOG_LOCAL;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(async () => {
    await shutdownAnalytics();
  });

  it("uses the WorkOS external id (client actorKey), never the Convex userId", () => {
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          userExternalId: "user_01H00000000000000000000000",
          userId: "convex_internal_id",
        },
      }),
      "send_message_server",
      { origin: "playground" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const call = captureMock.mock.calls[0][0];
    expect(call.distinctId).toBe("user_01H00000000000000000000000");
    expect(call.event).toBe("send_message_server");
    expect(call.properties.origin).toBe("playground");
    expect(call.properties.$insert_id).toEqual(expect.any(String));
    expect(call.properties.source).toBe("server");
    // Real (non-hosted) config in this test file — the hosted case is
    // covered by analytics.hosted.test.ts, which mocks HOSTED_MODE at
    // module-load time.
    expect(call.properties.deployment).toBe("self_hosted");
  });

  it("falls back to guestExternalId then the guestId context var", () => {
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          guestExternalId: "a1234567-1234-4234-8234-123456789abc",
        },
      }),
      "execute_tool_server",
    );
    captureServerEvent(
      fakeContext({ guestId: "b1234567-1234-4234-8234-123456789abc" }),
      "execute_tool_server",
    );

    expect(captureMock.mock.calls[0][0].distinctId).toBe(
      "a1234567-1234-4234-8234-123456789abc",
    );
    expect(captureMock.mock.calls[1][0].distinctId).toBe(
      "b1234567-1234-4234-8234-123456789abc",
    );
  });

  it("drops events with no resolvable actor instead of capturing anonymously", () => {
    captureServerEvent(fakeContext({}), "send_message_server");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it.each(["VITE_DISABLE_POSTHOG_LOCAL", "DO_NOT_TRACK"])(
    "evaluates browser rollout with %s disabled without capturing events",
    async (setting) => {
      process.env[setting] = "true";
      flagMock.mockResolvedValueOnce(true);
      expect(
        await evaluateBrowserRollout(
          "local-browser-enabled",
          "user_01H00000000000000000000000",
        ),
      ).toBe(true);
      expect(flagMock).toHaveBeenLastCalledWith(
        "local-browser-enabled",
        "user_01H00000000000000000000000",
        {
          sendFeatureFlagEvents: false,
          personProperties: { local_browser_security_version: "1" },
        },
      );
      captureServerEvent(
        fakeContext({
          requestLogContext: {
            userExternalId: "user_01H00000000000000000000000",
          },
        }),
        "send_message_server",
      );
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it("honors DO_NOT_TRACK", () => {
    process.env.DO_NOT_TRACK = "1";
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          userExternalId: "user_01H00000000000000000000000",
        },
      }),
      "send_message_server",
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("honors VITE_DISABLE_POSTHOG_LOCAL", () => {
    process.env.VITE_DISABLE_POSTHOG_LOCAL = "true";
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          userExternalId: "user_01H00000000000000000000000",
        },
      }),
      "send_message_server",
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("drops arbitrary org/project attribution", () => {
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          userExternalId: "user_01H00000000000000000000000",
          orgId: "org_1",
          projectId: "proj_1",
        },
      }),
      "eval_suite_run_started_server",
    );
    const props = captureMock.mock.calls[0][0].properties;
    expect(props.organization_id).toBeUndefined();
    expect(props.project_id).toBeUndefined();
  });

  it("generates a fresh $insert_id per event", () => {
    const ctx = fakeContext({
      requestLogContext: { userExternalId: "user_01H00000000000000000000000" },
    });
    captureServerEvent(ctx, "send_message_server");
    captureServerEvent(ctx, "send_message_server");
    expect(captureMock.mock.calls[0][0].properties.$insert_id).not.toBe(
      captureMock.mock.calls[1][0].properties.$insert_id,
    );
  });
});
