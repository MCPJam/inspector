import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SuiteReportCases } from "../ConformanceSavedChecks";
import type { SavedReportCase } from "../use-saved-run-reports";

const failureMessage = "1 listed UI resource violation(s) found";
const description = "Listed UI resources must use a valid URI.";
const skipMessage = "Skipping check because no MCP Apps tools were discovered";

const cases: SavedReportCase[] = [
  {
    id: "ui-resources-listed-valid",
    title: "Listed UI Resources Valid",
    status: "failed",
    description,
    durationMs: 12,
    error: failureMessage,
  },
  {
    id: "ui-tool-metadata-valid",
    title: "UI Tool Metadata Valid",
    status: "skipped",
    skipReason: "not-applicable",
    durationMs: 0,
    error: skipMessage,
  },
  { id: "legacy", title: "Older saved check", status: "passed" },
];

describe.each(["history", "shared"] as const)("%s check design", (page) => {
  async function showCases(reportedCases: SavedReportCase[] = cases) {
    const loadReport = vi.fn().mockResolvedValue({
      groups: [{ cases: reportedCases }],
    });
    render(
      <SuiteReportCases
        suiteKind="apps"
        incompleteReason={null}
        load
        {...(page === "history"
          ? { reportUrl: "https://artifacts.test/apps.json", loadReport }
          : { inlineCases: reportedCases })}
      />,
    );
    await screen.findByRole("button", { name: /Listed UI Resources Valid/ });
  }

  it("shows the boxed failure and expands to its explanation", async () => {
    await showCases();
    const row = screen.getByRole("button", {
      name: /Listed UI Resources Valid/,
    });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(row).getByText(failureMessage).parentElement).toHaveClass(
      "border-red-500/20",
      "bg-red-500/5",
    );
    expect(within(row).getByText("12ms")).toBeInTheDocument();

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    const explanation = screen.getByText(description);
    expect(explanation.closest("[inert]")).toBeNull();
    const message = screen.getByText(failureMessage);
    expect(message.closest("button")).toBeNull();
    expect(
      explanation.compareDocumentPosition(message) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reveals a not-applicable reason only when its check opens", async () => {
    await showCases();
    const row = screen.getByRole("button", { name: "UI Tool Metadata Valid" });
    expect(within(row).queryByText(skipMessage)).toBeNull();
    expect(screen.getByText(skipMessage).closest("[inert]")).not.toBeNull();
    expect(screen.queryByText("0ms")).toBeNull();

    fireEvent.click(row);

    expect(screen.getByText(skipMessage).closest("[inert]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Older saved check" }),
    ).not.toHaveTextContent("undefinedms");
  });

  it.each(["wrapped", "legacy"])(
    "keeps the timeout badge and individual fields for %s details",
    async (shape) => {
      const details = { timedOut: true, timeoutMs: 15_000 };
      await showCases([
        ...cases,
        {
          id: "ping-timeout",
          title: "Server Ping",
          status: "skipped",
          skipReason: "could-not-run",
          durationMs: 0,
          error: "The server did not answer within 15 seconds.",
          details: shape === "wrapped" ? { details } : details,
        },
      ]);
      const row = screen.getByRole("button", { name: /Server Ping/ });
      expect(within(row).getByText("Timed out")).toBeInTheDocument();

      fireEvent.click(row);

      expect(screen.getByText("Timeout Ms:")).toBeInTheDocument();
      expect(screen.getByText("15000")).toBeInTheDocument();
      expect(screen.queryByText("Details:")).toBeNull();
    },
  );

  it("hides nested input markers and keeps supplemental report evidence", async () => {
    await showCases([
      ...cases,
      {
        id: "tasks-result-type-discipline",
        title: "Result Type Discipline",
        status: "skipped",
        skipReason: "could-not-run",
        error: "A required tool is missing",
        details: {
          details: { missingInput: "tasksProbe", toolName: "create_task" },
          errorDetails: "The selected tool was unavailable.",
          observed: "No task-creating tool was discovered.",
          warnings: ["Check the configured tools."],
        },
      },
    ]);
    const row = screen.getByRole("button", { name: /Result Type Discipline/ });
    expect(within(row).getByText("Not run")).toBeInTheDocument();

    fireEvent.click(row);

    expect(screen.getByText("Tool Name:")).toBeInTheDocument();
    expect(screen.getByText("create_task")).toBeInTheDocument();
    expect(screen.queryByText("Details:")).toBeNull();
    expect(
      screen.queryByText(/missingInput|Missing Input|tasksProbe/),
    ).toBeNull();
    expect(screen.getByText("Error Details:")).toBeInTheDocument();
    expect(
      screen.getByText("The selected tool was unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("Observed:")).toBeInTheDocument();
    expect(
      screen.getByText("No task-creating tool was discovered."),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "Check the configured tools.",
    );
  });
});
