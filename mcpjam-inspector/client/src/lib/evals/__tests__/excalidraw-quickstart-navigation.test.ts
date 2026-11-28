import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { runExcalidrawQuickstart } from "../excalidraw-quickstart";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const navigateEvaluate = vi.hoisted(() => vi.fn());
vi.mock("@/components/evaluate/create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: navigateEvaluate,
}));

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
  it("uses the caller's navigation override", async () => {
    const navigate = vi.fn();
    navigateEvaluate.mockClear();

    await runExcalidrawQuickstart(options({ navigate }));

    expect(navigate).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-1",
    });
    expect(navigateEvaluate).not.toHaveBeenCalled();
  });

  it("defaults to the current Evaluate navigator", async () => {
    navigateEvaluate.mockClear();

    await runExcalidrawQuickstart(options());

    expect(navigateEvaluate).toHaveBeenCalledWith({
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
