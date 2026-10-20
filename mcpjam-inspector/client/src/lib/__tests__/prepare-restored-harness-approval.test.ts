import { describe, expect, it, vi } from "vitest";
import { prepareRestoredHarnessApproval } from "../prepare-restored-harness-approval";

describe("prepareRestoredHarnessApproval", () => {
  it("resolves the saved selection even before the live selection hydrates", async () => {
    const resolve = vi.fn().mockResolvedValue([{ serverId: "server-1" }]);
    expect(await prepareRestoredHarnessApproval({
      selection: { sessionId: "chat", serverNames: ["DeepWiki"] },
      targetKey: "claude", currentSessionId: () => "chat", currentTargetKey: () => "claude", resolve,
    })).toEqual({ serverNames: ["DeepWiki"], serverIds: ["server-1"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(["DeepWiki"]);
  });

  it.each(["session", "target"])("refuses a changed %s during resolution", async (changed) => {
    await expect(prepareRestoredHarnessApproval({
      selection: { sessionId: "chat", serverNames: ["DeepWiki"] }, targetKey: "claude",
      currentSessionId: () => changed === "session" ? "other" : "chat",
      currentTargetKey: () => changed === "target" ? "other" : "claude",
      resolve: async () => [{ serverId: "server-1" }],
    })).rejects.toThrow("The chat changed");
  });
});
