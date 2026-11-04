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
  async function showCases() {
    const loadReport = vi.fn().mockResolvedValue({ groups: [{ cases }] });
    render(
      <SuiteReportCases
        suiteKind="apps"
        incompleteReason={null}
        load
        {...(page === "history"
          ? { reportUrl: "https://artifacts.test/apps.json", loadReport }
          : { inlineCases: cases })}
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
});
