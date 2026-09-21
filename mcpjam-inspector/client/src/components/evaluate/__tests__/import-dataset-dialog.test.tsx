import { useState } from "react";
import { EvalGeneratedDrafts } from "../eval-generated-drafts";
import {
  useEvalGeneration,
  evalSuiteKey,
} from "@/lib/mcpjam-agent/eval-workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test";
import { ImportDatasetDialog } from "../import-dataset-dialog";
import {
  authoringRequest,
  readAuthoringJob,
} from "@/lib/apis/eval-authoring-api";
// Reviewing an authoring draft renders the model picker, which reads shared
// app state this suite does not mount.
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/lib/apis/eval-authoring-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authoringRequest: vi.fn(),
  readAuthoringJob: vi.fn(),
}));
const source = {
  format: "markdown" as const,
  method: "ai" as const,
  fileName: "cases.md",
  fileHash: "a".repeat(64),
  excerpt: "Find projects",
  startLine: 1,
  endLine: 1,
  extractorVersion: "markdown-v2",
};
const draft = {
  version: 1 as const,
  draftId: "draft-1",
  revision: 0,
  case: {
    title: "Find projects",
    steps: [
      { id: "p1", kind: "prompt" as const, prompt: "Find my projects" },
      {
        id: "a1",
        kind: "assert" as const,
        assertion: { type: "widgetRendered", toolName: "list_projects" },
      },
    ],
    expectedOutput: "Project names appear",
    isNegativeTest: false,
    runs: 1,
    models: [],
  },
  source,
  issues: [],
  additions: [],
  review: "required" as const,
};
/** The status a poll sees once the job has finished authoring. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    status: "completed",
    phase: "publish",
    error: null,
    warnings: [],
    drafts: [draft],
    ...overrides,
  } as never;
}
const props = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "project",
  suiteId: "suite",
};
function upload(name = "cases.md", content = "Find projects") {
  const file = new File([content], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  fireEvent.change(screen.getByLabelText("Document file"), {
    target: { files: [file] },
  });
}
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ImportDatasetDialog
        {...props}
        open={open}
        onOpenChange={(next) => {
          props.onOpenChange(next);
          setOpen(next);
        }}
      />
      <EvalGeneratedDrafts {...props} suiteName="Suite" defaultOpen={false} />
    </>
  );
}
/** Start a job from the dialog and wait for its drafts to reach the review list. */
async function extract() {
  upload();
  fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
  await screen.findByRole("article", { name: `Draft: ${draft.case.title}` });
}
/**
 * An imported draft opens in the step editor already — what a reader agrees to
 * is the case, not a paragraph about it — so "reviewing" is just being there.
 */
function review() {
  expect(screen.getByRole("button", { name: "Close editor" })).toBeVisible();
}
/** Every authoring call the commit path makes, answered as a success. */
function authoringSucceeds() {
  vi.mocked(authoringRequest).mockImplementation(
    async (body: Record<string, unknown>) => {
      if (body.operation === "start") return { jobId: "job-1" };
      if (body.operation === "edit")
        return { revision: 1, draft: { ...draft, revision: 1 } };
      if (body.operation === "commit")
        return { committed: [{ index: 0 }], failed: [] };
      return {};
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useEvalGeneration.setState({ suites: {} });
  authoringSucceeds();
  vi.mocked(readAuthoringJob).mockResolvedValue(job());
});
describe("document case import", () => {
  it("labels file sizes and validation messages in KB", () => {
    renderWithProviders(<ImportDatasetDialog {...props} />);
    expect(screen.getByText(/Up to 100 KB/)).toBeVisible();
    upload("cases.md", "a".repeat(1024));
    expect(screen.getByText(/cases.md · 1.0 KB/)).toBeVisible();
    upload("large.md", "a".repeat(100 * 1024 + 1));
    expect(
      screen.getByText("Split the file into documents of at most 100 KB."),
    ).toBeVisible();
  });

  it("starts an authoring job and only commits after review", async () => {
    // The dialog hands the document to the shared authoring job; nothing is
    // written to the suite until a person has been through the drafts.
    renderWithProviders(<Harness />);
    upload();
    expect(authoringRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
    await screen.findByRole("article", { name: `Draft: ${draft.case.title}` });
    expect(vi.mocked(authoringRequest).mock.calls[0][0]).toMatchObject({
      operation: "start",
      input: { source: "markdown", fileName: "cases.md" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review imported cases" }),
    ).toHaveAttribute("aria-expanded", "true");
    // The draft lands open in the step editor: the case is what gets agreed
    // to, so it is what the reader is shown.
    expect(screen.getByLabelText("Generated case title")).toBeVisible();
    expect(committedCalls()).toHaveLength(0);
    review();
    fireEvent.change(screen.getByLabelText("Generated case title"), {
      target: { value: "My projects" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add My projects to suite" }),
    );
    await waitFor(() => expect(committedCalls()).toHaveLength(1));
    expect(committedCalls()[0][0]).toMatchObject({ draftId: "draft-1" });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Generated case drafts" }),
      ).toBeNull(),
    );
  });

  it("keeps the ordered steps the authoring model wrote", async () => {
    // The point of the authoring path: a document that describes asserts and
    // tool calls arrives as those steps, not as a lone prompt.
    renderWithProviders(<Harness />);
    await extract();
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(props)].drafts[0].input
        .steps,
    ).toHaveLength(2);
  });

  it("takes a CSV or a JSON, not only Markdown", () => {
    // The model reads the document's shape itself, so the picker has no
    // business turning a spreadsheet of scenarios away at the door.
    for (const name of ["cases.csv", "cases.json", "pasted"]) {
      renderWithProviders(<Harness />);
      upload(name);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Extract cases" }),
      ).toBeEnabled();
      cleanup();
    }
  });

  it("clears the previous file when a replacement is too large", () => {
    renderWithProviders(<Harness />);
    upload();
    upload("cases.csv", "x".repeat(100 * 1024 + 1));
    expect(screen.getByRole("alert")).toHaveTextContent("at most 100 KB");
    expect(
      screen.getByRole("button", { name: "Extract cases" }),
    ).toBeDisabled();
  });

  it("requires something to check, and supports discarding unwanted cases", async () => {
    // An authored case is checkable through an assert step, an expected
    // outcome, or a case check. A draft with none of the three cannot be added
    // — it would run and assert nothing.
    vi.mocked(readAuthoringJob).mockResolvedValue(
      job({
        drafts: [
          {
            ...draft,
            case: {
              ...draft.case,
              steps: [draft.case.steps[0]],
              expectedOutput: undefined,
            },
          },
        ],
      }),
    );
    renderWithProviders(<Harness />);
    await extract();
    review();
    expect(
      screen.getByRole("button", { name: `Add ${draft.case.title} to suite` }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Expected Outcome"), {
      target: { value: "Projects appear" },
    });
    expect(
      screen.getByRole("button", { name: `Add ${draft.case.title} to suite` }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${draft.case.title}` }),
    );
    expect(screen.queryByRole("article")).toBeNull();
    expect(committedCalls()).toHaveLength(0);
  });

  it("keeps the draft reviewable and retryable after a lost commit", async () => {
    vi.mocked(authoringRequest).mockImplementationOnce(async () => ({
      jobId: "job-1",
    }));
    let commits = 0;
    vi.mocked(authoringRequest).mockImplementation(
      async (body: Record<string, unknown>) => {
        if (body.operation === "start") return { jobId: "job-1" };
        if (body.operation === "commit") {
          commits += 1;
          if (commits === 1) throw new Error("Connection lost");
          return { committed: [{ index: 0 }], failed: [] };
        }
        return {};
      },
    );
    renderWithProviders(<Harness />);
    await extract();
    review();
    fireEvent.click(
      screen.getByRole("button", { name: `Add ${draft.case.title} to suite` }),
    );
    await screen.findByRole("alert");
    // An accepted draft is already committed backend-side as far as the
    // caller knows, so the editor locks until a retry settles the outcome.
    expect(screen.getByLabelText("Generated case title")).toBeDisabled();
    expect(screen.getByText("Retry save")).toBeVisible();
    fireEvent.click(screen.getByText("Retry save"));
    await waitFor(() => expect(commits).toBe(2));
    expect(committedCalls()[1][0]).toMatchObject({ draftId: "draft-1" });
  });

  it("ignores a start response after cancellation", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(authoringRequest).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderWithProviders(<Harness />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
    await waitFor(() => expect(authoringRequest).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      (vi.mocked(authoringRequest).mock.calls[0][1] as AbortSignal).aborted,
    ).toBe(true);
    await act(async () => resolve({ jobId: "job-1" }));
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("does not block a draft on authoring diagnostics", async () => {
    vi.mocked(readAuthoringJob).mockResolvedValue(
      job({
        drafts: [
          {
            ...draft,
            issues: [
              {
                code: "unsupported_workflow",
                message: "Needs independent checks",
                blocking: false,
              },
            ],
          },
        ],
      }),
    );
    renderWithProviders(<Harness />);
    await extract();
    review();
    // Non-blocking issues are model diagnostics, not gates: a complete case
    // stays addable.
    expect(
      screen.getByRole("button", { name: `Add ${draft.case.title} to suite` }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Add all to suite" }),
    ).toBeEnabled();
  });

  it("preserves imports when navigating away and returns collapsed", async () => {
    const view = renderWithProviders(<Harness />);
    await extract();
    view.unmount();
    renderWithProviders(
      <EvalGeneratedDrafts {...props} suiteName="Suite" defaultOpen={false} />,
    );
    expect(
      screen.getByRole("button", { name: "Review imported cases" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(props)].drafts[0]
        .authoring?.source,
    ).toEqual(source);
  });

  it("replaces the raw limit refusal with the plain sentence", async () => {
    vi.mocked(authoringRequest).mockRejectedValueOnce(
      new Error(
        "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
      ),
    );
    renderWithProviders(<ImportDatasetDialog {...props} />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));

    const alert = await screen.findByRole("alert");
    // Loose on the wording: the sentence is owned by the SDK error catalog,
    // and the point of the test is that the backend's own phrasing is gone.
    expect(alert).toHaveTextContent(/Out of MCPJam credits\./);
    expect(alert).not.toHaveTextContent("Use BYOK");
  });

  it("keeps non-limit errors verbatim", async () => {
    vi.mocked(authoringRequest).mockRejectedValueOnce(
      new Error("You cannot import cases into this suite."),
    );
    renderWithProviders(<ImportDatasetDialog {...props} />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "You cannot import cases into this suite.",
    );
  });
});

function committedCalls() {
  return vi
    .mocked(authoringRequest)
    .mock.calls.filter(
      ([body]) => (body as { operation?: string }).operation === "commit",
    );
}
