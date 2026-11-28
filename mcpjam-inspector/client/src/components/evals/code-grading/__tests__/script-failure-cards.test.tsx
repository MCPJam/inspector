import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeError } from "@mcpjam/sdk/browser";
import {
  IterationErrorCards,
  RunScriptNotices,
  SetupFailedIteration,
} from "../script-failure-cards";
import { iterationScriptFailures } from "../script-failures";

const output =
  "Resetting /home/user/app/data\nif [ $count != 0 ]; then exit 1; fi";
const setupFailed = {
  metadata: {
    iterationScripts: {
      setup: { status: "failed", exitCode: 1, output, durationMs: 900 },
    },
  },
};

describe("Setup failed, on the iteration page", () => {
  it("shows the design's card open, with Edit scripts and the script output", async () => {
    const onEditScripts = vi.fn();
    render(
      <SetupFailedIteration
        failures={iterationScriptFailures(setupFailed)}
        onEditScripts={onEditScripts}
      />,
    );
    const card = within(screen.getByTestId("script-failure-iterationSetup"));
    expect(card.getByText("Setup failed")).toBeInTheDocument();
    expect(
      card.getByText(
        "The Before each iteration script exited 1, so the agent didn't run. This iteration is left out of the pass rate.",
      ),
    ).toBeInTheDocument();
    expect(
      card.getByRole("button", { name: "Hide details" }),
    ).toBeInTheDocument();
    expect(
      card.getByText(
        "Fix the script under Setup and cleanup in suite settings, then run the suite again.",
      ),
    ).toBeInTheDocument();
    // Its own heading, not "Raw error", and `!=` drawn as typed.
    expect(card.getByText("Script output")).toBeInTheDocument();
    expect(card.queryByText("Raw error")).toBeNull();
    const block = card.getByText(/Resetting \/home\/user\/app\/data/);
    expect(block.textContent).toContain("!=");
    expect(block.className).toContain("[font-variant-ligatures:none]");
    expect(
      screen.getByText(
        "The agent didn't run, so this iteration has no transcript or scorecard.",
      ),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(card.getByRole("button", { name: "Edit scripts" }));
    expect(onEditScripts).toHaveBeenCalledTimes(1);
  });

  it("offers no Edit scripts where the suite can't be edited", () => {
    render(
      <SetupFailedIteration failures={iterationScriptFailures(setupFailed)} />,
    );
    expect(screen.queryByRole("button", { name: "Edit scripts" })).toBeNull();
  });
});

describe("IterationErrorCards", () => {
  const environmentFailure = describeError("Server never came up");

  it("replaces the generic setup card when the setup script failed", () => {
    render(
      <IterationErrorCards
        iteration={setupFailed}
        fallback={environmentFailure}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Setup failed")).toBeInTheDocument();
  });

  it("adds the cleanup warning beside any other error, in its own box", () => {
    render(
      <IterationErrorCards
        iteration={{
          metadata: {
            iterationScripts: {
              cleanup: { status: "failed", exitCode: 2, output: "busy" },
            },
          },
        }}
        fallback={environmentFailure}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(
      within(screen.getByTestId("script-failure-iterationCleanup")).getByText(
        "The After each iteration script exited 2. This iteration's results are unchanged.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the cleanup warning alone on an iteration that otherwise finished", () => {
    render(
      <IterationErrorCards
        iteration={{
          metadata: {
            iterationScripts: {
              setup: { status: "passed", exitCode: 0, output: "" },
              cleanup: { status: "timeout", output: "" },
            },
          },
        }}
        fallback={null}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Cleanup failed")).toBeInTheDocument();
  });

  it("keeps the usual card when no script failed", () => {
    render(
      <IterationErrorCards iteration={{}} fallback={environmentFailure} />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Setup failed")).toBeNull();
  });
});

describe("RunScriptNotices, on the run page", () => {
  it("shows run setup and run cleanup failures, one card each", () => {
    render(
      <RunScriptNotices
        run={{
          scriptResults: {
            runSetup: {
              status: "failed",
              exitCode: 127,
              output: "seed: not found",
            },
            runCleanup: { status: "error", output: "", error: "no capacity" },
          },
        }}
        onEditScripts={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "The Before the run script exited 127, so no iteration started.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The After the run script couldn't start. The run's results are unchanged.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Edit scripts" }),
    ).toHaveLength(2);
  });

  it("renders nothing for a run whose scripts passed or that has none", () => {
    const { container } = render(
      <RunScriptNotices
        run={{ scriptResults: { runSetup: { status: "passed", output: "" } } }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
