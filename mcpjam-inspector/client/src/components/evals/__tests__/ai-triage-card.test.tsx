import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import type { EvalSuiteRun } from "../types";
import { AiTriageCard } from "../ai-triage-card";

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
});
