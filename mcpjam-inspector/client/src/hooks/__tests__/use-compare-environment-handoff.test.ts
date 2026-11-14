import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import { useCompareEnvironmentHandoff } from "../use-compare-environment-handoff";

const host = (hostId: string): RecoveryPane => ({
  paneId: hostId,
  target: { kind: "host", hostId },
});
const environment = (environmentId: string): RecoveryPane => ({
  paneId: environmentId,
  target: { kind: "environment", environmentId },
});

function setup(panes: RecoveryPane[], pageEnvironmentId: string | null = null) {
  const calls = {
    restorePanes: vi.fn(),
    setSelectedHostIds: vi.fn(),
    selectEnvironment: vi.fn(),
    clearEnvironment: vi.fn(),
  };
  const { result } = renderHook(() =>
    useCompareEnvironmentHandoff({
      panes,
      pageEnvironmentId,
      environmentTargets: [
        {
          target: { kind: "environment", environmentId: "env_1" },
          label: "E1",
        },
      ],
      ...calls,
    }),
  );
  return { handoff: result.current, calls };
}

describe("useCompareEnvironmentHandoff", () => {
  it("starts Compare from an environment's chat with the environment in pane 0", () => {
    const { handoff, calls } = setup([host("h-env")], "env_1");
    handoff.onSelectedHostIdsChange(["h-env", "h-b"]);
    expect(calls.clearEnvironment).toHaveBeenCalled();
    expect(calls.restorePanes).toHaveBeenCalledWith([
      environment("env_1"),
      host("h-b"),
    ]);
    expect(calls.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("returns to the environment's chat when only its pane is left", () => {
    const { handoff, calls } = setup([environment("env_1"), host("h-b")]);
    handoff.onSelectedHostIdsChange([]);
    expect(calls.selectEnvironment).toHaveBeenCalledWith("env_1");
    expect(calls.restorePanes).toHaveBeenCalledWith([]);
  });

  it("leaves a resting page environment when only a client is left", () => {
    const { handoff, calls } = setup(
      [host("h-a"), environment("env_1")],
      "env_1",
    );
    handoff.onRemovePane("env_1");
    expect(calls.clearEnvironment).toHaveBeenCalled();
    expect(calls.selectEnvironment).not.toHaveBeenCalled();
    expect(calls.restorePanes).toHaveBeenCalledWith([host("h-a")]);
  });

  it("leaves Compare for one client, dropping environment panes", () => {
    const { handoff, calls } = setup([environment("env_1"), host("h-b")]);
    handoff.onPickSingleClient("h-c");
    expect(calls.restorePanes).toHaveBeenCalledWith([host("h-c")]);
    expect(calls.selectEnvironment).not.toHaveBeenCalled();
  });

  it("changes clients beside environment panes without leaving Compare", () => {
    const { handoff, calls } = setup([environment("env_1"), host("h-b")]);
    handoff.onSelectedHostIdsChange(["h-b", "h-c"]);
    expect(calls.setSelectedHostIds).toHaveBeenCalledWith(["h-b", "h-c"]);
    expect(calls.restorePanes).not.toHaveBeenCalled();
  });

  it("names environment panes for the client chip and marks a leading one", () => {
    const { handoff } = setup([environment("env_1"), host("h-b")]);
    expect(handoff.environmentPanes).toEqual([
      { paneId: "env_1", label: "E1" },
    ]);
    expect(handoff.environmentLeads).toBe(true);
    expect(setup([host("h-a")]).handoff.environmentPanes).toEqual([]);
  });
});
