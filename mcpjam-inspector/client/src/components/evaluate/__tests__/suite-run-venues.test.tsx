import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_RUNTIME_COPY } from "@/components/harness/local-runtime-copy";
import { SuiteRunVenues } from "../suite-run-venues";
import type { LocalEvalVenueRow, LocalEvalVenues } from "../use-local-harness-eval-venues";

function venues(rows: LocalEvalVenueRow[]): LocalEvalVenues {
  return { rows, check: vi.fn(), setUp: vi.fn(), startBlockedReason: null };
}

describe("where each client in the run runs", () => {
  it("names the clients that run on this machine and in the cloud, quietly", () => {
    render(
      <SuiteRunVenues
        disabled={false}
        venues={venues([
          { harnessId: "claude-code", name: "Claude Code", state: { kind: "local" } },
          { harnessId: "codex", name: "Codex", state: { kind: "cloud" } },
        ])}
      />,
    );
    expect(screen.getByText("Runs on this machine")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Runs in the cloud")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces where a client runs once its check answers", () => {
    const row = { harnessId: "claude-code", name: "Claude Code" } as const;
    const { container, rerender } = render(
      <SuiteRunVenues disabled={false} venues={venues([{ ...row, state: { kind: "checking" } }])} />,
    );
    // The live region is there before the answer, so screen readers hear the change.
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe("");
    rerender(<SuiteRunVenues disabled={false} venues={venues([{ ...row, state: { kind: "local" } }])} />);
    expect(region?.textContent).toContain("Runs on this machine");
  });

  it("offers setup with what one click allows beside it", () => {
    const state = venues([
      {
        harnessId: "claude-code",
        name: "Claude Code",
        state: { kind: "refused", message: "Claude Code isn't set up for this project on this machine.", fix: "set-up" },
      },
    ]);
    render(<SuiteRunVenues disabled={false} venues={state} />);
    expect(screen.getByText("Can't run here")).toBeTruthy();
    expect(screen.getByText("Claude Code isn't set up for this project on this machine.")).toBeTruthy();
    expect(screen.getByText(LOCAL_RUNTIME_COPY["claude-code"].setup)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(state.setUp).toHaveBeenCalledWith("claude-code");
  });

  it("shows setup progress, and a failed setup with Retry", () => {
    const { rerender } = render(
      <SuiteRunVenues
        disabled={false}
        venues={venues([
          { harnessId: "claude-code", name: "Claude Code", state: { kind: "setting-up", progress: "Downloading Claude Code: 42%" } },
        ])}
      />,
    );
    expect(screen.getByText("Setting up")).toBeTruthy();
    expect(screen.getByText("Downloading Claude Code: 42%")).toBeTruthy();
    const failed = venues([
      { harnessId: "claude-code", name: "Claude Code", state: { kind: "setup-failed", message: "Couldn't download Claude Code." } },
    ]);
    rerender(<SuiteRunVenues disabled={false} venues={failed} />);
    expect(screen.getByText("Setup didn't finish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed.setUp).toHaveBeenCalledWith("claude-code");
  });

  it("retries a check that failed, and offers no button where the fix is another client", () => {
    const state = venues([
      { harnessId: "codex", name: "Codex", state: { kind: "refused", message: "Evals with Codex run locally only on Macs with Apple silicon.", fix: "choose-another" } },
      { harnessId: "claude-code", name: "Claude Code", state: { kind: "refused", message: "Couldn't check whether Claude Code can run on this machine. Check your connection, then retry.", fix: "retry" } },
    ]);
    render(<SuiteRunVenues disabled={false} venues={state} />);
    expect(screen.getByText("Evals with Codex run locally only on Macs with Apple silicon.")).toBeTruthy();
    expect(screen.getByText("Couldn't check")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.check).toHaveBeenCalledWith("claude-code");
  });

  it("renders nothing for a run without harness clients", () => {
    const { container } = render(<SuiteRunVenues disabled={false} venues={venues([])} />);
    expect(container.innerHTML).toBe("");
  });
});
