import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { resolveChatTurn } from "../resolve-chat-turn.js";
import { composeTurnEnvironment } from "../compose-turn-environment.js";
import { resolveEnvironmentForRuntime } from "../../environments/runtime.js";

vi.mock("../compose-turn-environment.js", () => ({
  composeTurnEnvironment: vi.fn(),
}));
vi.mock("../../environments/runtime.js", () => ({
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
