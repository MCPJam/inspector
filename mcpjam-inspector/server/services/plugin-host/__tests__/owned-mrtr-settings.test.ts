import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";
import { createOwnedPluginMrtr } from "../owned-mrtr";
import type { ResolvedInvocationContext } from "../invocation";

function fixture() {
  const executeTool = vi
    .fn()
    .mockResolvedValue({ content: [], structuredContent: { units: "mm" } });
  const service = createOwnedPluginMrtr({
    c: {} as Context,
    bearer: "test-bearer",
    projectId: "project",
    serverId: "server",
    sourceBinding: { hostId: "host", hostRevision: "revision" },
    assertCurrent: async () => {},
    manager: () =>
      ({
        getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
        executeTool,
      }) as unknown as MCPClientManager,
  });
  const authorization: ResolvedInvocationContext = {
    owner: {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      instanceId: "instance",
      generation: 1,
      serverId: "server",
      bindingId: "binding",
      placement: "interactive",
    },
    origin: "settings",
    revision: "revision",
    tool: { name: "settings.read" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["settings"],
  };
  return { service, authorization, executeTool };
}

describe("modern structured settings", () => {
  it.each(["settings.read", "settings.update"])(
    "executes %s with the original arguments and no retry",
    async (name) => {
      const f = fixture();
      const args = name.endsWith("update") ? { set: { showGrid: false } } : {};
      const signal = new AbortController().signal;
      await expect(
        f.service.execute(
          f.authorization,
          "operation",
          { name, arguments: args },
          signal,
        ),
      ).resolves.toMatchObject({ structuredContent: { units: "mm" } });
      expect(f.executeTool).toHaveBeenCalledExactlyOnceWith(
        "server",
        name,
        args,
        {
          metadata: undefined,
          request: { signal },
          retry: { retries: 0, retryDelayMs: 0 },
        },
      );
    },
  );

  it("refuses a settings form before persisting a continuation, and releases the operation", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f.service.execute(
        f.authorization,
        "operation",
        { name: "settings.read" },
        signal,
        () =>
          f.service.collector({
            state: {
              opId: "operation",
              round: 0,
              maxRounds: 4,
              pendingInputRequests: {},
              method: "tools/call",
              originalParams: { name: "settings.read" },
            },
            inputRequests: {},
          }),
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_CONTINUATION_UNSUPPORTED" });
    expect(f.executeTool).not.toHaveBeenCalled();
    await expect(
      f.service.execute(
        f.authorization,
        "next",
        { name: "settings.read" },
        signal,
      ),
    ).resolves.toHaveProperty("structuredContent");
  });

  it("still refuses unsupported invocation origins before executing", async () => {
    const f = fixture();
    await expect(
      f.service.execute(
        { ...f.authorization, origin: "mention" },
        "operation",
        { name: "search" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CONTINUATION_ORIGIN_UNSUPPORTED" });
    expect(f.executeTool).not.toHaveBeenCalled();
  });
});
