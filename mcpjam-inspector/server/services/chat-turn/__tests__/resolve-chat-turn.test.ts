import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { resolveChatTurn } from "../resolve-chat-turn.js";
import { composeTurnEnvironment } from "../compose-turn-environment.js";
import { resolveEnvironmentForRuntime } from "../../environments/runtime.js";
import { ErrorCode } from "../../../routes/web/errors.js";

vi.mock("../compose-turn-environment.js", () => ({
  composeTurnEnvironment: vi.fn(),
}));
vi.mock("../../environments/runtime.js", async (original) => ({
  ...(await original<typeof import("../../environments/runtime.js")>()),
  resolveEnvironmentForRuntime: vi.fn(),
}));
const client = new ConvexHttpClient("https://test.convex.cloud");
const common = {
  client,
  bearer: "test-bearer",
  access: { kind: "project" as const, projectId: "project" },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(client, "action").mockReset();
  vi.mocked(composeTurnEnvironment).mockResolvedValue({
    environmentId: "hidden",
    harness: null,
  });
  vi.mocked(resolveEnvironmentForRuntime).mockResolvedValue({
    environmentRef: { environmentId: "hidden", name: "", revision: 1 },
    host: { hostId: "host", runtimeConfig: {} },
    servers: { effectiveServerIds: [] },
  });
});

describe("authorized turn resolution", () => {
  it("composes plain chat without persisting its empty server override", async () => {
    const result = await resolveChatTurn({
      ...common,
      target: { kind: "host", hostId: "host" },
      selection: { kind: "explicit", serverIds: [] },
    });
    expect(result).toMatchObject({
      kind: "project",
      composed: true,
      mode: "interactive",
    });
    expect(composeTurnEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host", projectId: "project" }),
    );
    expect(resolveEnvironmentForRuntime).toHaveBeenCalledWith(client, {
      projectId: "project",
      environmentId: "hidden",
      overrides: { serverIds: [] },
    });
  });
  it("keeps client defaults distinct from environment defaults", async () => {
    await resolveChatTurn({
      ...common,
      target: { kind: "host", hostId: "host" },
      selection: { kind: "client-default" },
    });
    expect(resolveEnvironmentForRuntime).toHaveBeenLastCalledWith(client, {
      projectId: "project",
      environmentId: "hidden",
      serverSelectionSource: "client-default",
    });
    await resolveChatTurn({
      ...common,
      target: { kind: "environment", environmentId: "named" },
      selection: { kind: "environment-default" },
    });
    expect(resolveEnvironmentForRuntime).toHaveBeenLastCalledWith(client, {
      projectId: "project",
      environmentId: "named",
    });
    expect(composeTurnEnvironment).toHaveBeenCalledTimes(1);
  });
  it("never falls back after composition fails", async () => {
    vi.mocked(composeTurnEnvironment).mockRejectedValueOnce(
      new Error("composition failed"),
    );
    await expect(
      resolveChatTurn({
        ...common,
        target: { kind: "host", hostId: "host" },
        selection: { kind: "explicit", serverIds: [] },
      }),
    ).rejects.toThrow("composition failed");
    expect(resolveEnvironmentForRuntime).not.toHaveBeenCalled();
  });
  it("rejects target/access mismatch before resolving", async () => {
    await expect(
      resolveChatTurn({
        ...common,
        target: { kind: "adhoc", projectId: "other" },
        selection: { kind: "environment-default" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(composeTurnEnvironment).not.toHaveBeenCalled();
  });
});


describe("grouped turn preparation", () => {
  const preparedEnvironment = {
    environmentRef: { environmentId: "hidden", name: "", revision: 1 },
    host: { hostId: "host", runtimeConfig: {} },
    servers: { effectiveServerIds: [] },
  };
  it.each([[], ["server"]])(
    "uses the advertised action and preserves explicit selection %s",
    async (serverIds) => {
      const action = vi.spyOn(client, "action").mockResolvedValueOnce({
        kind: "resolved",
        harness: null,
        environment: preparedEnvironment,
      });
      const result = await resolveChatTurn({
        ...common,
        target: { kind: "host", hostId: "host" },
        selection: { kind: "explicit", serverIds },
        prepareChatTurn: true,
      });
      expect(result.environment).toEqual(preparedEnvironment);
      expect(action).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "project",
          hostId: "host",
          serverOverrideIds: serverIds,
        }),
      );
      expect(composeTurnEnvironment).not.toHaveBeenCalled();
      expect(resolveEnvironmentForRuntime).not.toHaveBeenCalled();
    },
  );
  it("keeps external accounts on the existing credential and venue path", async () => {
    vi.spyOn(client, "action").mockResolvedValueOnce({
      kind: "external-account",
      hostId: "host",
      runtimeConfig: { harness: "cursor" },
    });
    await resolveChatTurn({
      ...common,
      target: { kind: "host", hostId: "host" },
      selection: { kind: "explicit", serverIds: [] },
      prepareChatTurn: true,
    });
    expect(composeTurnEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedHost: { hostId: "host", config: { harness: "cursor" } },
      }),
    );
    expect(resolveEnvironmentForRuntime).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    { kind: "resolved", harness: null, environment: {} },
    { kind: "external-account", runtimeConfig: {} },
    {
      kind: "external-account",
      hostId: "host",
      runtimeConfig: { agentLoop: 1 },
    },
    {
      kind: "external-account",
      hostId: "other",
      runtimeConfig: { agentLoop: "cursor" },
    },
    {
      kind: "resolved",
      harness: null,
      environment: {
        ...preparedEnvironment,
        host: { hostId: "other", runtimeConfig: {} },
      },
    },
  ])(
    "refuses an invalid preparation response without replaying setup",
    async (raw) => {
      vi.spyOn(client, "action").mockResolvedValueOnce(raw);
      await expect(
        resolveChatTurn({
          ...common,
          target: { kind: "host", hostId: "host" },
          selection: { kind: "explicit", serverIds: [] },
          prepareChatTurn: true,
        }),
      ).rejects.toMatchObject({ status: 502 });
      expect(composeTurnEnvironment).not.toHaveBeenCalled();
    },
  );
  it("preserves the host-specific not-found classification", async () => {
    vi.spyOn(client, "action").mockRejectedValueOnce({
      data: {
        code: "HOST_UNRESOLVED",
        message: "Client unavailable",
        details: { hostId: "host" },
      },
    });
    await expect(
      resolveChatTurn({
        ...common,
        target: { kind: "host", hostId: "host" },
        selection: { kind: "explicit", serverIds: [] },
        prepareChatTurn: true,
      }),
    ).rejects.toMatchObject({
      status: 404,
      details: { reason: "HOST_UNRESOLVED", hostId: "host" },
    });
    expect(composeTurnEnvironment).not.toHaveBeenCalled();
  });
  it("reports the preparation deadline without retrying setup", async () => {
    vi.spyOn(client, "action").mockRejectedValueOnce(
      new DOMException("Deadline exceeded", "TimeoutError"),
    );
    await expect(
      resolveChatTurn({
        ...common,
        target: { kind: "host", hostId: "host" },
        selection: { kind: "explicit", serverIds: [] },
        prepareChatTurn: true,
      }),
    ).rejects.toMatchObject({ status: 504 });
    expect(composeTurnEnvironment).not.toHaveBeenCalled();
  });
});

describe("a Cursor turn whose org key isn't ready", () => {
  it("is refused as the turn's own key check refuses it, not as a 502", async () => {
    // The wire answer for `prepareChatTurn`'s ConvexError, read by a real
    // Convex client: what reaches the translation is what production sees.
    const backend = new ConvexHttpClient("https://test.convex.cloud", {
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: "error",
            errorMessage: "Uncaught ConvexError: cursor_key_missing",
            errorData: {
              code: "cursor_key_missing",
              message:
                "Ask an org admin to add a Cursor key in Organization → AI providers.",
            },
          }),
          { status: 560, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      resolveChatTurn({
        ...common,
        client: backend,
        target: { kind: "host", hostId: "host" },
        selection: { kind: "client-default" },
        prepareChatTurn: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      message:
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
      details: { reason: "EXTERNAL_ACCOUNT_CREDENTIAL_UNAVAILABLE" },
    });
    expect(composeTurnEnvironment).not.toHaveBeenCalled();
  });
});
