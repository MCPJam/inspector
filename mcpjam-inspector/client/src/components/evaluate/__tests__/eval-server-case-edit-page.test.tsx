import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvalServerCaseEditPage } from "../eval-server-case-edit-page";
import {
  buildEvalServerPreview,
  findPreviewCase,
} from "../eval-server-preview-model";
import {
  clearEvalServerPreviewDraft,
  readEvalServerPreviewDraft,
  writeEvalServerPreviewDraft,
} from "../eval-server-preview-state";

const server = { id: "srv-asana", name: "Asana MCP" };

describe("EvalServerCaseEditPage", () => {
  const preview = buildEvalServerPreview(server);
  const suiteId = preview.suites[0]!.id;
  const caseId = preview.suites[0]!.cases[0]!.id;

  beforeEach(() => {
    clearEvalServerPreviewDraft(server.id);
    writeEvalServerPreviewDraft(server.id, {
      suites: preview.suites,
      openSuiteIds: [suiteId],
      step: "suites",
      clients: [],
      iterationsPerCase: 10,
    });
  });

  it("renders today's case form and writes edits back to the draft", () => {
    const onBack = vi.fn();
    render(
      <EvalServerCaseEditPage
        server={server}
        suiteId={suiteId}
        caseId={caseId}
        onBack={onBack}
      />,
    );

    expect(screen.getByTestId("eval-server-case-edit")).toBeTruthy();
    expect(screen.getByTestId("simple-case-form")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Create a task from a short brief",
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Create a task from a short brief" }),
    );
    fireEvent.change(screen.getByLabelText("Case title"), {
      target: { value: "Create a task from a longer brief" },
    });
    fireEvent.blur(screen.getByLabelText("Case title"));

    const draft = readEvalServerPreviewDraft(server.id);
    expect(findPreviewCase(draft!.suites, suiteId, caseId)?.title).toBe(
      "Create a task from a longer brief",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows a return path when the case is gone", () => {
    clearEvalServerPreviewDraft(server.id);
    const onBack = vi.fn();
    render(
      <EvalServerCaseEditPage
        server={server}
        suiteId={suiteId}
        caseId={caseId}
        onBack={onBack}
      />,
    );

    expect(
      screen.getByText("This case is no longer in the first-run preview."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
