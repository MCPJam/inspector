import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  setup: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("../../swarm-agent", () => ({ reportTargetGrounding: mocks.report }));
vi.mock("../swarm-setup-turn", () => ({
  runSwarmSetupTurn: mocks.setup,
  SwarmSetupError: class extends Error {
    constructor(public partial: unknown) {
      super("setup failed");
    }
  },
}));
vi.mock("../target-discovery", () => ({
  probeReadOnlyTools: mocks.probe,
  abortable: (promise: Promise<unknown>) => promise,
}));
import { prepareTargetGrounding } from "../target-grounding";
import { SwarmSetupError } from "../swarm-setup-turn";
import type { SetupRecord } from "../../../../shared/swarm-grounding";
const empty: SetupRecord = {
  status: "completed",
  readiness: "not_needed",
  prefix: "swarm-test-",
  createdEntities: [],
  observedCreatedEntityCount: 0,
  unsupportedClaims: 0,
  missing: [],
  toolCalls: [],
  writeCallsDispatched: 0,
  retried: false,
  admittedWriteTools: [],
  excludedToolCount: 0,
  startedAt: 0,
  durationMs: 0,
  chatSessionId: "setup",
};
function args() {
  const dispose = vi.fn(async () => {});
  return {
    runId: "run",
    projectId: "p",
    target: { hostId: "h", targetId: "env-a" },
    persona: {},
    modelDefinition: {},
    managerFactory: vi.fn(async () => ({
      manager: {},
      connectedServerIds: ["s"],
      dispose,
    })),
    convexHttpUrl: "https://test",
    bearer: "token",
    signal: new AbortController().signal,
    setupWrites: true,
  } as unknown as Parameters<typeof prepareTargetGrounding>[0];
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setup.mockResolvedValue(empty);
  mocks.report.mockResolvedValue({});
  mocks.probe.mockResolvedValue({ probes: [], probedTools: [] });
});
describe("target preparation", () => {
  it("reports setup before discovery and skips setup when absent", async () => {
    const a = args();
    await prepareTargetGrounding(a);
    expect(mocks.report.mock.calls[0][2]).toMatchObject({
      targetId: "env-a",
      setup: empty,
    });
    expect(mocks.report.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.probe.mock.invocationCallOrder[0],
    );
    mocks.setup.mockClear();
    await prepareTargetGrounding({ ...a, setupWrites: undefined });
    expect(mocks.setup).not.toHaveBeenCalled();
  });
  it("does not retry after a write; records partial evidence and blocks sessions", async () => {
    const partial = {
      ...empty,
      status: "failed",
      readiness: "unavailable",
      writeCallsDispatched: 1,
    } as SetupRecord;
    mocks.setup.mockRejectedValue(new SwarmSetupError(partial));
    await expect(prepareTargetGrounding(args())).rejects.toThrow();
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.report.mock.calls[0][2].setup).toBe(partial);
  });
  it("retries once before any write and proceeds after recovery", async () => {
    mocks.setup
      .mockRejectedValueOnce(
        new SwarmSetupError({
          ...empty,
          status: "failed",
          readiness: "unavailable",
        }),
      )
      .mockResolvedValueOnce(empty);
    await prepareTargetGrounding(args());
    expect(mocks.setup).toHaveBeenCalledTimes(2);
    expect(mocks.setup.mock.calls[1][0].retried).toBe(true);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });
  it("permits skipped/not-assessed, rejects completed/unavailable", async () => {
    mocks.setup.mockResolvedValueOnce({
      ...empty,
      status: "skipped",
      readiness: "not_assessed",
      reason: "no_eligible_write_tools",
    });
    await prepareTargetGrounding(args());
    mocks.setup.mockResolvedValueOnce({
      ...empty,
      readiness: "unavailable",
      reason: "invalid_model_report",
    });
    await expect(prepareTargetGrounding(args())).rejects.toThrow();
  });
  it("disposes discovery managers and degrades on probe/report failures", async () => {
    const a = args();
    const built = await a.managerFactory(a.target);
    mocks.probe.mockRejectedValue(new Error("read failed"));
    mocks.report.mockRejectedValue(new Error("backend offline"));
    await expect(
      prepareTargetGrounding({
        ...a,
        setupWrites: false,
        managerFactory: async () => built,
      }),
    ).resolves.toBeUndefined();
    expect(built.dispose).toHaveBeenCalledTimes(1);
  });
  it("never prepares legacy targets or cancelled runs", async () => {
    const a = args();
    await prepareTargetGrounding({
      ...a,
      target: { ...a.target, targetId: undefined },
    });
    await prepareTargetGrounding({ ...a, signal: AbortSignal.abort() });
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
