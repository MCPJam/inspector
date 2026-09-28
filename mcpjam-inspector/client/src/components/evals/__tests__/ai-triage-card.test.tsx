import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import type { EvalSuiteRun } from "../types";
import { AiTriageCard } from "../ai-triage-card";

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));

type ServerQuality = NonNullable<EvalSuiteRun["serverQuality"]>;
type ToolInsight = ServerQuality["toolInsights"][number];

const baseRun: EvalSuiteRun = {
  _id: "run-1",
  suiteId: "suite-1",
  createdBy: "user",
  runNumber: 1,
  configRevision: "rev1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  createdAt: 1,
  completedAt: 2,
  summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
};

function tool(toolName: string, rating: ToolInsight["rating"]): ToolInsight {
  return { toolName, rating, issues: [], suggestions: [] };
}

function makeServerQuality(toolInsights: ToolInsight[]): ServerQuality {
  return {
    summary: "",
    generatedAt: 1,
    modelUsed: "m",
    toolInsights,
    workflowInsights: [],
  };
}

function renderCard(serverQuality: ServerQuality) {
  return render(
    <AiTriageCard
      run={baseRun}
      iterations={[]}
      serverQuality={serverQuality}
      pending={false}
      requested={true}
      failedGeneration={false}
      error={null}
      onRetry={vi.fn()}
    />,
  );
}

function improveTitles(): string[] {
  return screen
    .getAllByText(/^Improve /)
    .map((el) => el.textContent ?? "");
}

describe("AiTriageCard", () => {
  it("shows top 3 rows and Top 3 of N subtitle when more than 3 suggestions", () => {
    renderCard(
      makeServerQuality([
        tool("tool-a", "poor"),
        tool("tool-b", "poor"),
        tool("tool-c", "poor"),
        tool("tool-d", "poor"),
        tool("tool-e", "poor"),
      ]),
    );

    expect(screen.getByText("Top 3 of 5 suggested fixes")).toBeInTheDocument();
    expect(improveTitles()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show 2 more" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("expands to all rows and collapses with Show less", async () => {
    const user = userEvent.setup();
    renderCard(
      makeServerQuality([
        tool("tool-a", "poor"),
        tool("tool-b", "poor"),
        tool("tool-c", "poor"),
        tool("tool-d", "poor"),
        tool("tool-e", "poor"),
      ]),
    );

    await user.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(improveTitles()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(improveTitles()).toHaveLength(3);
  });

  it("shows all rows without expander when at most 3 suggestions", () => {
    renderCard(
      makeServerQuality([tool("tool-a", "poor"), tool("tool-b", "poor")]),
    );

    expect(screen.getByText("2 suggested fixes")).toBeInTheDocument();
    expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
    expect(improveTitles()).toHaveLength(2);
  });

  it("uses compact category labels and icon-only row copy buttons", () => {
    renderCard(makeServerQuality([tool("export_to_excalidraw", "poor")]));

    expect(screen.getByText("Tool")).toBeInTheDocument();
    expect(screen.queryByText("TOOL DESCRIPTION")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Copy fix prompt: Improve export_to_excalidraw/i,
      }),
    ).toHaveClass("w-7");
  });

  it("drops nested card chrome when embedded in the run-detail split", () => {
    render(
      <AiTriageCard
        run={baseRun}
        iterations={[]}
        serverQuality={makeServerQuality([tool("export_to_excalidraw", "poor")])}
        pending={false}
        requested={true}
        failedGeneration={false}
        error={null}
        onRetry={vi.fn()}
        embedded
      />,
    );

    const section = screen
      .getByRole("heading", { name: "Suggested fixes" })
      .closest("section");
    expect(section).not.toHaveClass("rounded-lg");
    expect(section).not.toHaveClass("border");
    expect(screen.queryByText(/^Accuracy$/)).not.toBeInTheDocument();
  });
});

describe("AiTriageCard refusals", () => {
  function renderRefused(props: { signInRequired: boolean; error: string }) {
    const onRetry = vi.fn();
    render(
      <AiTriageCard
        run={baseRun}
        iterations={[]}
        serverQuality={null}
        pending={false}
        requested={true}
        failedGeneration={false}
        error={props.error}
        signInRequired={props.signInRequired}
        onRetry={onRetry}
      />,
    );
    return { onRetry };
  }

  it("offers sign-in, not a failure and a retry, when a guest is refused", async () => {
    const user = userEvent.setup();
    signInMock.mockReset();
    const { onRetry } = renderRefused({
      signInRequired: true,
      error: "Sign in to use AI analysis. It's off for guests.",
    });

    expect(screen.getByText("Sign in to analyze")).toBeInTheDocument();
    expect(
      screen.getByText("Sign in to use AI analysis. It's off for guests."),
    ).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Analysis failed")).not.toBeInTheDocument();
    // Retrying cannot work: the refusal is about who is asking.
    expect(
      screen.queryByRole("button", { name: /Retry/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps Retry for an ordinary failure", async () => {
    const user = userEvent.setup();
    const { onRetry } = renderRefused({
      signInRequired: false,
      error: "The judge model timed out.",
    });

    expect(screen.getByText("Analysis failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
