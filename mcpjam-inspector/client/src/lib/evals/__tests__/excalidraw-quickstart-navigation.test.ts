import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { runExcalidrawQuickstart } from "../excalidraw-quickstart";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const navigateEvals = vi.hoisted(() => vi.fn());
vi.mock("@/components/evals/create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: navigateEvals,
}));

/**
 * The quickstart is reached from BOTH eval surfaces, and each owns its own
 * URL prefix. Landing is therefore the caller's to decide — hard-coding the
 * shipped tab's navigator sent an Evaluate reader to `/evals/...`, i.e. the
 * other surface's copy of the suite they had just made.
 */
function options(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    convex: {} as ConvexReactClient,
    createTestSuite: vi.fn(),
    createTestCase: vi.fn(),
    createServerAttachment: vi.fn(),
    handleConnect: vi.fn(),
    isExcalidrawConnected: true,
    existingQuickstartSuiteId: "suite-1",
    previewedHostId: null,
    ...overrides,
  } as Parameters<typeof runExcalidrawQuickstart>[0];
}

describe("runExcalidrawQuickstart landing", () => {
  it("lands where the caller says, not on the shipped Evals tab", async () => {
    const navigate = vi.fn();
    navigateEvals.mockClear();

    await runExcalidrawQuickstart(options({ navigate }));

    expect(navigate).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-1",
    });
    expect(navigateEvals).not.toHaveBeenCalled();
  });

  it("still lands on the Evals tab when no caller says otherwise", async () => {
    navigateEvals.mockClear();

    await runExcalidrawQuickstart(options());

    expect(navigateEvals).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-1",
    });
  });
});
