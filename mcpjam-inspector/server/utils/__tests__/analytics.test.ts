import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const captureMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => ({ capture: captureMock, shutdown: shutdownMock })),
}));

import { captureServerEvent, shutdownAnalytics } from "../analytics.js";

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
          userExternalId: "user_workos_1",
          userId: "convex_internal_id",
        },
      }),
      "send_message_server",
      { origin: "playground" },
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    const call = captureMock.mock.calls[0][0];
    expect(call.distinctId).toBe("user_workos_1");
    expect(call.event).toBe("send_message_server");
    expect(call.properties.origin).toBe("playground");
    expect(call.properties.$insert_id).toEqual(expect.any(String));
    expect(call.properties.source).toBe("server");
  });

  it("falls back to guestExternalId then the guestId context var", () => {
    captureServerEvent(
      fakeContext({ requestLogContext: { guestExternalId: "guest_ctx" } }),
      "execute_tool_server",
    );
    captureServerEvent(
      fakeContext({ guestId: "guest_var" }),
      "execute_tool_server",
    );

    expect(captureMock.mock.calls[0][0].distinctId).toBe("guest_ctx");
    expect(captureMock.mock.calls[1][0].distinctId).toBe("guest_var");
  });

  it("drops events with no resolvable actor instead of capturing anonymously", () => {
    captureServerEvent(fakeContext({}), "send_message_server");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("honors the opt-out env vars", () => {
    process.env.DO_NOT_TRACK = "1";
    captureServerEvent(
      fakeContext({ requestLogContext: { userExternalId: "u1" } }),
      "send_message_server",
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("attaches org/project attribution when present", () => {
    captureServerEvent(
      fakeContext({
        requestLogContext: {
          userExternalId: "u1",
          orgId: "org_1",
          projectId: "proj_1",
        },
      }),
      "eval_suite_run_started_server",
    );
    const props = captureMock.mock.calls[0][0].properties;
    expect(props.organization_id).toBe("org_1");
    expect(props.project_id).toBe("proj_1");
  });

  it("generates a fresh $insert_id per event", () => {
    const ctx = fakeContext({ requestLogContext: { userExternalId: "u1" } });
    captureServerEvent(ctx, "send_message_server");
    captureServerEvent(ctx, "send_message_server");
    expect(captureMock.mock.calls[0][0].properties.$insert_id).not.toBe(
      captureMock.mock.calls[1][0].properties.$insert_id,
    );
  });
});
