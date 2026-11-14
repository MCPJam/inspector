import { afterEach, describe, expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import { progressStore } from "../../services/progress-store";
import { bindLocalTaskOwnerScope } from "../task-owner-binding";

describe("local Task progress ownership", () => {
  afterEach(() => {
    progressStore.clearAllProgress("server");
    progressStore.clearAllProgress("other");
  });
  it("clears the previous owner's cached progress on rebinding", () => {
    const manager = {} as MCPClientManager;
    bindLocalTaskOwnerScope(manager, ["server", "other"], "a");
    const progress = {
      progressToken: "token",
      progress: 1,
      message: "private to a",
      timestamp: new Date().toISOString(),
    };
    progressStore.publish({ ...progress, serverId: "server" });
    progressStore.publish({ ...progress, serverId: "other" });
    bindLocalTaskOwnerScope(manager, ["server"], "b");
    expect(progressStore.getLatestProgress("server")).toBeUndefined();
    expect(progressStore.getLatestProgress("other")?.message).toBe(
      "private to a",
    );
  });
  it("does not erase progress when the verified owner is unchanged", () => {
    const manager = {} as MCPClientManager;
    bindLocalTaskOwnerScope(manager, ["server"], "a");
    progressStore.publish({
      serverId: "server",
      progressToken: "token",
      progress: 1,
      timestamp: new Date().toISOString(),
    });
    bindLocalTaskOwnerScope(manager, ["server"], "a");
    expect(progressStore.getLatestProgress("server")?.progress).toBe(1);
  });
});
