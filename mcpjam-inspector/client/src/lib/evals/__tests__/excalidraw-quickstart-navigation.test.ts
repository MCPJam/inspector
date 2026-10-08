import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { runExcalidrawQuickstart } from "../excalidraw-quickstart";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";

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

describe("runExcalidrawQuickstart suite shape", () => {
  function convexWith(hosts: Array<{ hostId: string }>) {
    return {
      query: vi.fn(async (name: string) => {
        if (name === "servers:getProjectServers")
          return [{ _id: "srv-excalidraw", name: EXCALIDRAW_SERVER_NAME }];
        if (name === "serverAttachments:listServerAttachments")
          return [
            {
              _id: "group-1",
              name: "Excalidraw",
              serverIds: ["srv-excalidraw"],
              resolvedServerNames: ["Excalidraw"],
            },
          ];
        if (name === "hosts:listHosts") return hosts;
        return null;
      }),
    } as unknown as ConvexReactClient;
  }

  it("makes an environment suite when the backend can", async () => {
    const createTestSuite = vi.fn().mockResolvedValue({ _id: "suite-9" });
    await runExcalidrawQuickstart(
      options({
        convex: convexWith([{ hostId: "host-1" }]),
        existingQuickstartSuiteId: null,
        createTestSuite,
        environmentSuites: true,
        navigate: vi.fn(),
      }),
    );
    const args = createTestSuite.mock.calls[0]![0];
    expect(args.environmentTargets).toEqual([
      { hostId: "host-1", serverAttachmentId: "group-1" },
    ]);
    expect(args).not.toHaveProperty("hostAttachments");
    expect(args).not.toHaveProperty("environment");
  });

  it("keeps the legacy suite on an older backend", async () => {
    const createTestSuite = vi.fn().mockResolvedValue({ _id: "suite-9" });
    await runExcalidrawQuickstart(
      options({
        convex: convexWith([{ hostId: "host-1" }]),
        existingQuickstartSuiteId: null,
        createTestSuite,
        navigate: vi.fn(),
      }),
    );
    const args = createTestSuite.mock.calls[0]![0];
    expect(args.serverAttachmentId).toBe("group-1");
    expect(args.hostAttachments).toEqual([
      { namedHostId: "host-1", enabledOptionalServerIds: [] },
    ]);
    expect(args).not.toHaveProperty("environmentTargets");
  });
});
