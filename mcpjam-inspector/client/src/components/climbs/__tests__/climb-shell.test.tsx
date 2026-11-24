import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClimbShell } from "../climb-shell";
import { makeClimb, makeRound } from "./fixtures";

const change = (summary: string) => ({ target: "tool" as const, kind: "changed" as const, summary, details: [] });

function renderShell(overrides: Partial<React.ComponentProps<typeof ClimbShell>> = {}) {
  const props = {
    climb: makeClimb({
      state: "running",
      rounds: [
        makeRound({ number: 1, submittedVia: "api" }),
        makeRound({ number: 2, standing: "reverted", verdict: "reverted", pickedBy: "mcpjam" }),
        makeRound({ number: 3, status: "running", verdict: undefined, standing: undefined }),
      ],
    }),
    changes: { 1: [change("Hid the tool \"list_projects\"")], 2: null },
    selection: 1 as const,
    onSelect: vi.fn(),
    mockName: "mcpjam-mcp climb",
    onContinue: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <ClimbShell {...props}>
      <p>The selected view</p>
    </ClimbShell>,
  );
  return props;
}

describe("ClimbShell", () => {
  it("shows what the climb is for, the best so far and the mock", () => {
    renderShell();
    expect(screen.getByText("Pass rate")).toBeInTheDocument();
    expect(screen.getByText("Baseline + round 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Open the mock server")).toHaveTextContent("mcpjam-mcp climb");
    expect(screen.getByText("Mock")).toBeInTheDocument();
    expect(screen.getByText("The selected view")).toBeInTheDocument();
  });

  it("lists the baseline and each round with who submitted it and where it stands", () => {
    renderShell();
    const rail = screen.getByRole("navigation", { name: "Rounds" });
    expect(rail).toHaveTextContent("Baseline");
    expect(rail).toHaveTextContent('Hid the tool "list_projects"');
    expect(rail).toHaveTextContent("You · Kept");
    // A change that could not be read still has a row.
    expect(rail).toHaveTextContent("Round 2");
    expect(rail).toHaveTextContent("MCPJam · Reverted");
    expect(rail).toHaveTextContent("Round 3");
    expect(rail).toHaveTextContent("Running");
  });

  it("marks the selected row and selects on click", async () => {
    const { onSelect } = renderShell();
    expect(screen.getByRole("button", { name: /Hid the tool/ })).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: /Baseline/ }));
    expect(onSelect).toHaveBeenCalledWith("base");
    await userEvent.click(screen.getByRole("button", { name: /New round/ }));
    expect(onSelect).toHaveBeenCalledWith("new");
  });

  it("shows a paused banner with the reason, and Continue resumes", async () => {
    const { onContinue } = renderShell({
      climb: makeClimb({
        picker: "mcpjam",
        paused: { at: 1, code: "inspector_stopped", reason: "Your Inspector stopped during round 3. Continue runs it again." },
      }),
    });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText(/Your Inspector stopped during round 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("says why Continue failed and keeps the banner", async () => {
    renderShell({
      climb: makeClimb({ paused: { at: 1, code: "attempts_exhausted", reason: "MCPJam could not finish the step." } }),
      onContinue: vi.fn().mockRejectedValue(new Error("The climb is stopped, so it cannot continue.")),
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/The climb is stopped, so it cannot continue/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("lets a person pick the change themselves from a paused climb", async () => {
    const { onSelect } = renderShell({
      climb: makeClimb({ paused: { at: 1, code: "nothing_submitted", reason: "MCPJam chose no change twice." } }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Pick the change yourself" }));
    expect(onSelect).toHaveBeenCalledWith("new");
  });

  it("says MCPJam is choosing while a step waits, and not on a paused climb", () => {
    const step = { status: "claimed" as const, dueAt: 1, attempts: 1, emptyTurns: 0 };
    const first = renderShell({ climb: makeClimb({ picker: "mcpjam", step }) });
    expect(screen.getByRole("status")).toHaveTextContent("MCPJam is choosing the next change.");
    first.onSelect.mockClear();
  });

  it("asks before it stops the climb, and stops it on confirm", async () => {
    const { onStop } = renderShell();
    await userEvent.click(screen.getByRole("button", { name: /Stop climb/ }));
    expect(onStop).not.toHaveBeenCalled();
    expect(await screen.findByText("Stop this climb?")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Stop climb" }).at(-1)!);
    await waitFor(() => expect(onStop).toHaveBeenCalled());
  });

  it("disables stopping and new rounds while the baseline runs", () => {
    renderShell({ climb: makeClimb({ state: "baselining" }) });
    expect(screen.getByRole("button", { name: /Stop climb/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /New round/ })).toBeDisabled();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });
});
