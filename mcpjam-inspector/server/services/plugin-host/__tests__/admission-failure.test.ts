import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";

const f = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.query }),
}));

import {
  admitPluginWorkspace,
  pluginAdmissionFailure,
  PluginWorkspaceAdmissionError,
  readPluginExecutionContext,
} from "../admission.js";
import { pluginChatRefusal } from "../../../routes/web/chat-v2-plugin-refusal.js";
import { PluginInvocationError } from "../invocation.js";

const descriptor = { version: 1, workspaceId: "playground:chat" } as never;
const fetchFailed = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    }),
  });

describe("plugin workspace admission failures", () => {
  beforeEach(() => f.query.mockReset());

  it("names an unreachable backend instead of denying the project", async () => {
    f.query.mockRejectedValueOnce(fetchFailed());
    const error = await admitPluginWorkspace({
      descriptor,
      projectId: "project",
      bearer: "token",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginWorkspaceAdmissionError);
    expect(error).toMatchObject({
      status: 503,
      code: "PLUGIN_WORKSPACE_UNREACHABLE",
      failure: "unreachable",
    });
  });

  it("keeps a backend refusal a denial", async () => {
    f.query.mockRejectedValueOnce(
      new ConvexError({ code: "FORBIDDEN", message: "rollout off" }),
    );
    await expect(
      admitPluginWorkspace({ descriptor, projectId: "project", bearer: "t" }),
    ).rejects.toMatchObject({ status: 403, code: "PLUGIN_WORKSPACE_DENIED" });
  });

  it("says when the sign-in lapsed rather than denying", async () => {
    f.query.mockRejectedValueOnce(
      new Error('{"code":"Unauthenticated","message":"Token expired"}'),
    );
    await expect(
      readPluginExecutionContext({
        projectId: "project",
        bearer: "t",
        expectedActorId: "actor",
        serverIds: ["server"],
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PLUGIN_WORKSPACE_SIGN_IN_EXPIRED",
    });
  });

  it("treats the admission deadline as unreachable and caller aborts as cancelled", () => {
    const cancelled = new PluginWorkspaceAdmissionError(true);
    expect(pluginAdmissionFailure(cancelled, true).code).toBe(
      "PLUGIN_WORKSPACE_UNREACHABLE",
    );
    expect(pluginAdmissionFailure(cancelled, false)).toBe(cancelled);
    expect(pluginAdmissionFailure(new Error("Server Error"), false).code).toBe(
      "PLUGIN_WORKSPACE_DENIED",
    );
    // A ConvexError payload is the backend deciding, whatever its wording.
    expect(
      pluginAdmissionFailure(
        new ConvexError({ code: "UNAUTHENTICATED_JWT", message: "jwt" }),
        false,
      ).code,
    ).toBe("PLUGIN_WORKSPACE_DENIED");
  });

  it("answers a chat turn with the refusal's own status and plain words", () => {
    expect(
      pluginChatRefusal(new PluginWorkspaceAdmissionError("unreachable")),
    ).toEqual({
      status: 503,
      code: "INTERNAL_ERROR",
      message: expect.stringContaining("couldn't reach its backend"),
      details: { pluginCode: "PLUGIN_WORKSPACE_UNREACHABLE" },
    });
    expect(
      pluginChatRefusal(new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE")),
    ).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: expect.stringContaining("can't send chat messages"),
    });
    expect(pluginChatRefusal(new Error("other"))).toBeUndefined();
  });
});
