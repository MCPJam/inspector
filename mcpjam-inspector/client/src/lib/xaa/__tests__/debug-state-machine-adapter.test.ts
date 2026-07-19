import { describe, expect, it, vi } from "vitest";

const { createXAAStateMachineMock } = vi.hoisted(() => ({
  createXAAStateMachineMock: vi.fn(() => ({}) as never),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

vi.mock("@/lib/oauth/debug-state-machine-adapter", () => ({
  createDebugRequestExecutor: vi.fn(() => vi.fn()),
}));

vi.mock("../state-machine", () => ({
  createXAAStateMachine: createXAAStateMachineMock,
}));

import { createInspectorXAAStateMachine } from "../debug-state-machine-adapter";

describe("createInspectorXAAStateMachine", () => {
  it("forwards an org to direct hosted private_key_jwt runs", () => {
    createInspectorXAAStateMachine({
      updateState: vi.fn(),
      serverUrl: "https://example.com/mcp",
      issuerBaseUrl: "https://app.mcpjam.com/api/web/xaa/o/org_123",
      organizationId: "org_123",
    });

    expect(createXAAStateMachineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_123",
        mintPathPrefix: "/o/org_123",
        specTokenEndpointAvailable: true,
      }),
    );
  });
});
