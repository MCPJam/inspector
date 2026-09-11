import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvalServerPreviewPage } from "../eval-server-preview-page";
import { buildEvalServerPreview } from "../eval-server-preview-model";
import { clearEvalServerPreviewDraft } from "../eval-server-preview-state";

const server = { id: "srv-asana", name: "Asana MCP" };

describe("EvalServerPreviewPage", () => {
  beforeEach(() => {
    clearEvalServerPreviewDraft(server.id);
  });

  it("renders the first-run suites step from the preview fixture", () => {
    render(
      <EvalServerPreviewPage
        server={server}
        preview={buildEvalServerPreview(server)}
        onOpenCase={vi.fn()}
        onRunFirstEvals={vi.fn()}
      />,
    );

    expect(screen.getByTestId("eval-server-preview")).toBeTruthy();
    const stepper = screen.getByTestId("eval-server-preview-stepper");
    expect(stepper).toHaveTextContent("Review suites and findings");
    expect(stepper).toHaveTextContent("Confirm run");
    expect(stepper).toHaveClass("w-full");
    expect(stepper).not.toHaveClass("max-w-md");
    expect(
      screen.getByRole("heading", {
        name: "Here are the suites we'd run first.",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("eval-server-preview-meta")).toHaveTextContent(
      "Asana MCP · 15 cases",
    );
    expect(
      screen.getByTestId("eval-server-preview-meta"),
    ).not.toHaveTextContent("no assertions yet");
    expect(screen.getAllByTestId("eval-server-preview-suite")).toHaveLength(3);
    expect(screen.getByTestId("eval-server-preview-findings")).toBeTruthy();
    expect(screen.getByText("What else we found so far")).toBeTruthy();
    expect(screen.getByText("Deprecated tools still advertised")).toBeTruthy();
    expect(screen.getByText("Access tokens expire after 1 hour")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a suite" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import tests" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a case" })).toBeNull();
    expect(
      screen.queryByText("These cases have no assertions yet."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Run first evals" }),
    ).toBeNull();
  });

  it("expands a suite and opens a case on the existing case route", () => {
    const onOpenCase = vi.fn();
    const preview = buildEvalServerPreview(server);
    render(
      <EvalServerPreviewPage
        server={server}
        preview={preview}
        onOpenCase={onOpenCase}
        onRunFirstEvals={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("eval-server-preview-case")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /^Create and assign work/ }),
    );
    const cases = screen.getAllByTestId("eval-server-preview-case");
    expect(cases.length).toBe(6);
    fireEvent.click(cases[0]!);
    expect(onOpenCase).toHaveBeenCalledWith({
      suiteId: preview.suites[0]!.id,
      caseId: preview.suites[0]!.cases[0]!.id,
      title: preview.suites[0]!.cases[0]!.title,
    });
  });

  it("adds an empty suite and opens Describe and Import only", () => {
    const onOpenCase = vi.fn();
    render(
      <EvalServerPreviewPage
        server={server}
        preview={buildEvalServerPreview(server)}
        onOpenCase={onOpenCase}
        onRunFirstEvals={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add a suite" }));
    expect(screen.getAllByTestId("eval-server-preview-suite")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Add cases" }));
    expect(screen.getByTestId("eval-server-preview-add-cases")).toBeTruthy();
    expect(screen.getByTestId("suite-detail-empty-cases")).toBeTruthy();
    expect(screen.getByTestId("suite-empty-action-describe")).toBeTruthy();
    expect(screen.getByTestId("suite-empty-action-import")).toBeTruthy();
    expect(screen.queryByTestId("suite-empty-action-generate")).toBeNull();
    expect(
      screen.getByText("Describe a behavior or import an existing test file."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("suite-empty-action-describe"));
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(onOpenCase.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        title: "New case",
      }),
    );
  });

  it("removes a suite and a case from the first-run list", () => {
    const preview = buildEvalServerPreview(server);
    render(
      <EvalServerPreviewPage
        server={server}
        preview={preview}
        onOpenCase={vi.fn()}
        onRunFirstEvals={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^Create and assign work/ }),
    );
    expect(screen.getAllByTestId("eval-server-preview-case")).toHaveLength(6);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Create a task from a short brief",
      }),
    );
    expect(screen.getAllByTestId("eval-server-preview-case")).toHaveLength(5);
    expect(screen.getByTestId("eval-server-preview-meta")).toHaveTextContent(
      "14 cases",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Create and assign work" }),
    );
    expect(screen.getAllByTestId("eval-server-preview-suite")).toHaveLength(2);
    expect(screen.getByTestId("eval-server-preview-meta")).toHaveTextContent(
      "9 cases",
    );
  });

  it("moves Run first evals to Confirm run with exploratory defaults", () => {
    const onRunFirstEvals = vi.fn();
    render(
      <EvalServerPreviewPage
        server={server}
        preview={buildEvalServerPreview(server)}
        onOpenCase={vi.fn()}
        onRunFirstEvals={onRunFirstEvals}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("eval-server-preview-confirm")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirm run" })).toBeTruthy();
    expect(screen.getByTestId("eval-server-preview-back")).toHaveTextContent(
      "Back",
    );
    expect(screen.queryByTestId("eval-server-preview-meta")).toBeNull();
    expect(screen.queryByText(/Asana MCP · 15 cases/)).toBeNull();
    expect(screen.getByTestId("eval-server-preview-clients")).toHaveTextContent(
      "ChatGPT",
    );
    expect(screen.getByTestId("eval-server-preview-clients")).toHaveTextContent(
      "Claude",
    );
    expect(screen.getByText(/This first run is exploratory/)).toBeTruthy();
    expect(screen.getByLabelText("Iterations per case")).toHaveValue(5);
    expect(
      screen.getByText(/Leave it if you are just looking around/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run first evals" }));
    expect(onRunFirstEvals).toHaveBeenCalledWith(
      expect.objectContaining({ iterationsPerCase: 5 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("eval-server-preview")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Here are the suites we'd run first.",
      }),
    ).toBeTruthy();
  });
});
