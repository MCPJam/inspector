import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HarnessStartupStatus } from "../harness-startup-status";
import { noteTurnNoticePart } from "@/lib/turn-notice-parts";
import { useHarnessStartupStore } from "@/stores/harness-startup-store";
import { isHarnessStartupDataPart } from "@/shared/harness-startup";

afterEach(() => {
  cleanup();
  useHarnessStartupStore.setState({ phases: {} });
});
const notice = (phase: string | null, chatSessionId?: string) => ({
  type: "data-harness-startup",
  data: { phase, chatSessionId },
});
describe("harness startup progress", () => {
  it("accepts only known phases and null completion", () => {
    expect(isHarnessStartupDataPart(notice("connecting-tools"))).toBe(true);
    expect(isHarnessStartupDataPart(notice(null))).toBe(true);
    expect(isHarnessStartupDataPart(notice("__proto__"))).toBe(false);
    expect(isHarnessStartupDataPart(notice("running arbitrary text"))).toBe(
      false,
    );
  });
  it("renders progress only for the active loading chat", () => {
    noteTurnNoticePart(notice("starting-hosted", "other"), "current");
    noteTurnNoticePart(notice("starting-local"), "current");
    const view = render(
      <HarnessStartupStatus chatSessionId="current" loading />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Starting the local runtime…",
    );
    view.rerender(
      <HarnessStartupStatus chatSessionId="current" loading={false} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<HarnessStartupStatus chatSessionId="other" loading />);
    expect(screen.getByRole("status").textContent).toBe(
      "Starting the cloud computer…",
    );
  });
  it("clears on readiness and the terminal cleanup used for errors and Stop", () => {
    noteTurnNoticePart(notice("connecting-runtime"), "current");
    noteTurnNoticePart(notice(null), "current");
    expect(useHarnessStartupStore.getState().phases.current).toBeUndefined();
    noteTurnNoticePart(notice("connecting-tools"), null);
    useHarnessStartupStore.getState().clear(null);
    expect(useHarnessStartupStore.getState().phases.new).toBeUndefined();
  });
});
