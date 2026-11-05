import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MCPCheckResult, MCPTasksCheckResult, OAuthConformanceStepResult } from "@mcpjam/sdk";
import { CatalogRow, CheckRow, OAuthStepRow } from "../ConformanceCheckRows";

function check(overrides: Partial<MCPCheckResult>): MCPCheckResult {
  return {
    id: "server-initialize",
    category: "core",
    title: "Server Initialize",
    description: "Server responds to initialize and reports capabilities.",
    status: "passed",
    durationMs: 420,
    ...overrides,
  };
}

describe("CheckRow", () => {
  it("keeps debugging data behind More details and labels the requests clearly", () => {
    const probes = [
      { method: "tasks/get", outcome: "rejected", code: -32021 },
      { method: "tasks/update", outcome: "rejected", code: -32021 },
      { method: "subscriptions/listen", outcome: "answered" },
      { method: "tasks/cancel", outcome: "rejected", code: -32021 },
    ];
    const error = "subscriptions/listen was answered instead of rejected";
    render(
      <CheckRow
        check={check({
          status: "failed",
          error: { message: error },
          details: { taskId: "task-123", probes },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Server Initialize/ }));

    const toggle = screen.getByRole("button", { name: "More details" });
    const taskId = screen.getByText("task-123");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(taskId.closest("[inert]")).not.toBeNull();
    expect(screen.getByText(error).closest("[inert]")).toBeNull();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      document.getElementById(toggle.getAttribute("aria-controls")!),
    ).toContainElement(taskId);
    expect(taskId.closest("[inert]")).toBeNull();
    expect(screen.getByText("Task ID:")).toBeInTheDocument();
    expect(screen.getByText("Requests tested:")).toBeInTheDocument();
    expect(screen.queryByText("Probes:")).toBeNull();
    expect(screen.getByText(/"method": "tasks\/get"/).textContent).toBe(
      JSON.stringify(probes, null, 2),
    );

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(taskId.closest("[inert]")).not.toBeNull();
    expect(screen.getByText(error).closest("[inert]")).toBeNull();
  });

  it.each([undefined, {}, { missingInput: "tasksProbe" }])(
    "omits More details when there is no debugging data (%j)",
    (details) => {
      render(<CheckRow check={check({ details })} />);
      fireEvent.click(screen.getByRole("button", { name: /^Server Initialize/ }));
      expect(screen.queryByRole("button", { name: "More details" })).toBeNull();
    },
  );

  it.each([true, false])(
    "shows a gray Not run row for missing input (marked: %s)",
    (marked) => {
      const message =
        "no probe tool could be selected automatically: tools are chosen by `execution.taskSupport`";
      const taskCheck: MCPTasksCheckResult = {
        id: "tasks-result-type-discipline",
        category: "creation",
        title: "Result Type Discipline",
        description: "Checks the task creation result.",
        status: "skipped",
        skipReason: "could-not-run",
        durationMs: 0,
        error: { message },
        details: marked ? { missingInput: "tasksProbe" } : undefined,
      };
      render(<CheckRow check={taskCheck} />);
      expect(screen.getByText("Not run")).toHaveAttribute(
        "title",
        "This check needs an input before it can run.",
      );
      expect(screen.queryByText(message)).toBeNull();
      expect(
        screen.getAllByText(
          "Select a tool that creates a task in setup, then run again.",
        ).length,
      ).toBeGreaterThan(0);
      const icon = screen.getByRole("button").querySelector("span > span");
      expect(icon).toHaveClass("bg-muted", "text-muted-foreground");
      expect(icon).not.toHaveTextContent("!");
      fireEvent.click(screen.getByRole("button"));
      expect(screen.queryByText(message)).toBeNull();
    },
  );

  it("shows how long a check that ran took", () => {
    render(<CheckRow check={check({})} />);
    expect(screen.getByText("420ms")).toBeInTheDocument();
  });

  it("leaves the duration off a skipped check", () => {
    render(
      <CheckRow
        check={check({
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
        })}
      />,
    );
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
  });

  it("tags a timed-out check and shows why it could not run", () => {
    render(
      <CheckRow
        check={check({
          status: "skipped",
          skipReason: "could-not-run",
          durationMs: 0,
          error: { message: "The server did not answer within 15 seconds." },
          details: { timedOut: true, timeoutMs: 15_000 },
        })}
      />,
    );
    expect(screen.getByText("Timed out")).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /Server Initialize/ })).getByText(
        "The server did not answer within 15 seconds.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves the timeout tag off a check that ran", () => {
    render(<CheckRow check={check({})} />);
    expect(screen.queryByText("Timed out")).not.toBeInTheDocument();
  });
});

function step(
  overrides: Partial<OAuthConformanceStepResult>,
): OAuthConformanceStepResult {
  return {
    step: "token_request",
    title: "Token request",
    summary: "Exchange the code for a token.",
    status: "passed",
    durationMs: 310,
    logs: [],
    httpAttempts: [],
    ...overrides,
  };
}

describe("OAuthStepRow", () => {
  it("shows how long a step that ran took", () => {
    render(<OAuthStepRow step={step({})} />);
    expect(screen.getByText("310ms")).toBeInTheDocument();
  });

  it("leaves the duration off a skipped step", () => {
    render(
      <OAuthStepRow
        step={step({
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
        })}
      />,
    );
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
  });

  it("shows a failed step's text details when expanded", () => {
    render(
      <OAuthStepRow
        step={step({
          status: "failed",
          error: {
            message: "The authorization server rejected this run's OAuth client credentials.",
            details:
              "Provider code: invalid_client\nEndpoint: https://auth.example/token",
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText(/Provider code: invalid_client/)).toBeInTheDocument();
  });
});

describe.each(["check", "OAuth step"] as const)("%s expansion", (kind) => {
  it("keeps the explanation and error together outside the expanded button", () => {
    const explanation = "Explain the requirement before the failure.";
    const message = "The server did not meet the requirement.";
    render(
      kind === "check" ? (
        <CheckRow
          check={check({
            description: explanation,
            status: "failed",
            error: { message },
          })}
        />
      ) : (
        <OAuthStepRow
          step={step({
            summary: explanation,
            status: "failed",
            error: { message },
          })}
        />
      ),
    );
    const button = screen.getByRole("button");
    const description = screen.getByText(explanation);
    expect(description.closest("[inert]")).not.toBeNull();
    expect(within(button).getByText(message)).toBeInTheDocument();

    fireEvent.click(button);

    expect(description.closest("[inert]")).toBeNull();
    expect(button).not.toHaveAccessibleName(/Explain the requirement/);
    expect(button).not.toHaveAccessibleName(/The server did not meet/);
    const error = screen.getByText(message);
    expect(error.closest("button")).toBeNull();
    expect(
      description.compareDocumentPosition(error) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(button);

    expect(screen.getByText(explanation)).toBe(description);
    expect(description.closest("[inert]")).not.toBeNull();
    expect(error.closest("[inert]")).not.toBeNull();
    expect(within(button).getByText(message)).toBeInTheDocument();
  });
});

describe("CatalogRow", () => {
  it("shades a check that does not apply but keeps its checkbox working", () => {
    const changes: boolean[] = [];
    render(
      <CatalogRow
        entry={{ id: "c", title: "Some Check", description: "What it does." }}
        selected
        onSelectedChange={(value) => changes.push(value)}
        notApplicable="Nothing to check here."
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Run Some Check" });
    expect(box.closest("label")!.parentElement).toHaveClass("opacity-50");
    fireEvent.click(box);
    expect(changes).toEqual([false]);
  });

  it("does not shade a check that applies", () => {
    render(<CatalogRow entry={{ id: "c", title: "Some Check" }} selected />);
    const box = screen.getByRole("checkbox", { name: "Run Some Check" });
    expect(box.closest("label")!.parentElement).not.toHaveClass("opacity-50");
  });
});
