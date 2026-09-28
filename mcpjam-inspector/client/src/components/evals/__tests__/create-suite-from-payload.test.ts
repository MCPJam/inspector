import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { createSuiteFromPayload } from "../create-suite-from-payload";

describe("createSuiteFromPayload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an environment suite in one call when the backend takes it", async () => {
    const createTestSuite = vi.fn().mockResolvedValue({ _id: "suite-1" });
    const setSuiteEnvironments = vi.fn();
    const created = await createSuiteFromPayload({
      projectId: "project-1",
      payload: {
        name: "Refunds",
        environmentIds: ["env-1", "env-2"],
        hostAttachments: [{ namedHostId: "host-1" }],
        serverAttachmentId: "group-1",
      },
      createTestSuite,
      setSuiteEnvironments,
      oneCall: true,
    });
    expect(created._id).toBe("suite-1");
    // No legacy client, group or server list rides along.
    expect(createTestSuite).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "Refunds",
      environmentIds: ["env-1", "env-2"],
    });
    expect(setSuiteEnvironments).not.toHaveBeenCalled();
  });

  it("keeps the two-call path on an older backend", async () => {
    const createTestSuite = vi.fn().mockResolvedValue({ _id: "suite-1" });
    const setSuiteEnvironments = vi.fn().mockResolvedValue(null);
    await createSuiteFromPayload({
      projectId: "project-1",
      payload: {
        name: "Refunds",
        environmentIds: ["env-1"],
        hostAttachments: [{ namedHostId: "host-1" }],
      },
      createTestSuite,
      setSuiteEnvironments,
      oneCall: false,
    });
    expect(createTestSuite).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "Refunds",
      environment: { servers: [] },
      hostAttachments: [{ namedHostId: "host-1" }],
    });
    expect(setSuiteEnvironments).toHaveBeenCalledWith({
      suiteId: "suite-1",
      environmentIds: ["env-1"],
    });
  });

  it("a failed second call keeps the suite and says so", async () => {
    const created = await createSuiteFromPayload({
      projectId: "project-1",
      payload: { name: "Refunds", environmentIds: ["env-1"] },
      createTestSuite: vi.fn().mockResolvedValue({ _id: "suite-1" }),
      setSuiteEnvironments: vi.fn().mockRejectedValue(new Error("boom")),
      oneCall: false,
    });
    expect(created._id).toBe("suite-1");
    expect(toastError).toHaveBeenCalled();
  });

  it("a payload without environments stays on the legacy create", async () => {
    const createTestSuite = vi.fn().mockResolvedValue({ _id: "suite-1" });
    await createSuiteFromPayload({
      projectId: "project-1",
      payload: { name: "Skeleton" },
      createTestSuite,
      setSuiteEnvironments: vi.fn(),
      oneCall: true,
    });
    expect(createTestSuite).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "Skeleton",
      environment: { servers: [] },
    });
  });
});
