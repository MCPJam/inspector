import { useState } from "react";
import { EvalGeneratedDrafts } from "../eval-generated-drafts";
import {
  useEvalGeneration,
  evalSuiteKey,
} from "@/lib/mcpjam-agent/eval-workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, act } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test";
import { ImportDatasetDialog } from "../import-dataset-dialog";
import {
  extractMarkdownCases,
  saveMarkdownCases,
} from "@/lib/apis/markdown-case-import-api";
vi.mock("@/lib/apis/markdown-case-import-api", () => ({
  extractMarkdownCases: vi.fn(),
  saveMarkdownCases: vi.fn(),
}));
const source = {
  format: "markdown" as const,
  method: "ai" as const,
  fileName: "cases.md",
  fileHash: "a".repeat(64),
  excerpt: "Find projects",
  startLine: 1,
  endLine: 1,
  extractorVersion: "markdown-v1",
};
const draft = {
  draftId: "draft-1",
  title: "Find projects",
  prompt: "Find my projects",
  expectedOutput: "Project names appear",
  source,
  issues: [],
};
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
  fireEvent.change(screen.getByLabelText("Markdown file"), {
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
async function extract() {
  upload();
  fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
  await screen.findByRole("article", { name: `Draft: ${draft.title}` });
}
async function review() {
  fireEvent.click(screen.getAllByRole("button", { name: "Review case" })[0]);
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useEvalGeneration.setState({ suites: {} });
  vi.mocked(extractMarkdownCases).mockResolvedValue({
    ok: true,
    drafts: [draft],
    warnings: [],
  });
  vi.mocked(saveMarkdownCases).mockResolvedValue({
    committed: [
      { index: 0, title: draft.title, testCaseId: "case", replayed: false },
    ],
    failed: [],
  });
});
describe("Markdown case import", () => {
  it("stages extracted cases on the suite page and only saves after review", async () => {
    renderWithProviders(<Harness />);
    upload();
    expect(extractMarkdownCases).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
    await screen.findByRole("article", { name: `Draft: ${draft.title}` });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review Draft Cases" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByLabelText("Generated case title")).toBeNull();
    expect(saveMarkdownCases).not.toHaveBeenCalled();
    await review();
    fireEvent.change(screen.getByLabelText("Generated case title"), {
      target: { value: "My projects" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add My projects to suite" }),
    );
    await waitFor(() => expect(saveMarkdownCases).toHaveBeenCalledOnce());
    expect(
      vi.mocked(saveMarkdownCases).mock.calls[0][0].cases[0],
    ).toMatchObject({ title: "My projects", source });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Generated case drafts" }),
      ).toBeNull(),
    );
  });
  it("clears the previous file when a replacement is invalid", () => {
    renderWithProviders(<Harness />);
    upload();
    upload("cases.csv");
    expect(screen.getByRole("alert")).toHaveTextContent("Only Markdown");
    expect(
      screen.getByRole("button", { name: "Extract cases" }),
    ).toBeDisabled();
  });
  it("requires an outcome and supports discarding unwanted cases", async () => {
    vi.mocked(extractMarkdownCases).mockResolvedValue({
      ok: true,
      drafts: [{ ...draft, expectedOutput: undefined }],
      warnings: [],
    });
    renderWithProviders(<Harness />);
    await extract();
    await review();
    expect(
      screen.getByRole("button", { name: `Add ${draft.title} to suite` }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Expected Outcome"), {
      target: { value: "Projects appear" },
    });
    expect(
      screen.getByRole("button", { name: `Add ${draft.title} to suite` }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${draft.title}` }),
    );
    expect(screen.queryByRole("article")).toBeNull();
    expect(saveMarkdownCases).not.toHaveBeenCalled();
  });
  it("retries an identical payload after a lost response and locks edits until confirmed", async () => {
    vi.mocked(saveMarkdownCases).mockRejectedValueOnce(
      new Error("Connection lost"),
    );
    renderWithProviders(<Harness />);
    await extract();
    await review();
    fireEvent.click(
      screen.getByRole("button", { name: `Add ${draft.title} to suite` }),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Generated case title")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `Remove ${draft.title}` }),
    ).toBeDisabled();
    expect(screen.getByText("Retry save")).toBeVisible();
    fireEvent.click(screen.getByText("Retry save"));
    await waitFor(() => expect(saveMarkdownCases).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(saveMarkdownCases).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]);
  });
  it("ignores an extraction response after cancellation", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(extractMarkdownCases).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderWithProviders(<Harness />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Extract cases" }));
    await waitFor(() => expect(extractMarkdownCases).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(extractMarkdownCases).mock.calls[0][1].aborted).toBe(true);
    await act(async () => resolve({ ok: true, drafts: [draft], warnings: [] }));
    expect(screen.queryByRole("article")).toBeNull();
    expect(saveMarkdownCases).not.toHaveBeenCalled();
  });
  it("keeps failed cases reviewable after adding all and gives edited retries a new key", async () => {
    vi.mocked(extractMarkdownCases).mockResolvedValue({
      ok: true,
      drafts: [draft, { ...draft, draftId: "draft-2", title: "Another case" }],
      warnings: [],
    });
    vi.mocked(saveMarkdownCases).mockImplementation(async (request) =>
      request.cases[0].title === "Another case"
        ? {
            committed: [],
            failed: [
              { index: 0, code: "DUPLICATE", message: "Already exists" },
            ],
          }
        : {
            committed: [
              {
                index: 0,
                title: request.cases[0].title,
                testCaseId: "case",
                replayed: false,
              },
            ],
            failed: [],
          },
    );
    renderWithProviders(<Harness />);
    await extract();
    fireEvent.click(screen.getByRole("button", { name: "Add all to suite" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: `Draft: ${draft.title}` }),
      ).toBeNull(),
    );
    await review();
    expect(screen.getByLabelText("Generated case title")).toBeEnabled();
    const failedRequest = vi.mocked(saveMarkdownCases).mock.calls[1][0];
    fireEvent.change(screen.getByLabelText("Generated case title"), {
      target: { value: "Fixed case" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add Fixed case to suite" }),
    );
    await waitFor(() => expect(saveMarkdownCases).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(saveMarkdownCases).mock.calls[2][0].cases[0].idempotencyKey,
    ).not.toBe(failedRequest.cases[0].idempotencyKey);
  });
  it("allows reviewing extracted case content without exposing extraction diagnostics", async () => {
    vi.mocked(extractMarkdownCases).mockResolvedValue({
      ok: true,
      drafts: [
        {
          ...draft,
          issues: [
            {
              code: "unsupported_workflow",
              message: "Needs independent checks",
            },
          ],
        },
      ],
      warnings: [],
    });
    renderWithProviders(<Harness />);
    await extract();
    await review();
    expect(screen.queryByText("Needs independent checks")).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: `Add ${draft.title} to suite` });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(saveMarkdownCases).toHaveBeenCalledOnce());

  });
  it("preserves imports when navigating away and returns collapsed", async () => {
    const view = renderWithProviders(<Harness />);
    await extract();
    view.unmount();
    renderWithProviders(
      <EvalGeneratedDrafts {...props} suiteName="Suite" defaultOpen={false} />,
    );
    expect(
      screen.getByRole("button", { name: "Review Draft Cases" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(props)].drafts[0]
        .markdownImport?.source,
    ).toEqual(source);
  });
});
