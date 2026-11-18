import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../account-profile-capture.js", () => ({
  captureAccountProfile: mocks.capture,
}));

import { refreshConnectionProfiles } from "../connection-profile-refresh.js";
import { setManagerConnections } from "../mcp-connections.js";

function managerWithTwoAccounts() {
  const manager = {} as MCPClientManager;
  setManagerConnections(manager, {
    srv: [
      { serverId: "srv", connectionId: "a", key: "srv::a", label: "A" },
      { serverId: "srv", connectionId: "b", key: "srv::b", label: "B" },
    ],
  });
  return manager;
}

describe("refreshConnectionProfiles", () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    mocks.capture.mockResolvedValue(undefined);
  });

  it("asks the profile tool about each account when tool approval is off", async () => {
    await refreshConnectionProfiles(managerWithTwoAccounts(), "bearer", "p", {
      toolApprovalRequired: false,
    });
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("calls no tool when the turn requires tool approval", async () => {
    await refreshConnectionProfiles(managerWithTwoAccounts(), "bearer", "p", {
      toolApprovalRequired: true,
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
