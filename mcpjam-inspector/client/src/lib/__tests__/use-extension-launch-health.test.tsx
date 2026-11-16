import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsLaunchObservation } from "../use-extension-launch-health";
const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../analytics", () => ({ track: mocks.track }));

describe("settings launch discovery accounting", () => {
  it("waits for explicit opening and keeps discovery failure with the eventual editor", () => {
    mocks.track.mockClear();
    const view = renderHook(({ active, failed }) =>
      useSettingsLaunchObservation("private-owner", "codex", active, failed),
    { initialProps: { active: false, failed: true } });
    expect(mocks.track).not.toHaveBeenCalled();
    view.rerender({ active: true, failed: true });
    expect(mocks.track).toHaveBeenCalledOnce();
    view.rerender({ active: true, failed: false });
    act(() => view.result.current.ready());
    expect(mocks.track).toHaveBeenCalledOnce();
    expect(mocks.track.mock.calls[0][1]).toMatchObject({
      launch_kind: "settings", host_profile: "codex", outcome: "failure", failure_stage: "execution",
    });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain("private-owner");
  });
});
