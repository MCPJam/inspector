import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ImportedDraftEditor } from "../imported-draft-editor";
import {
  importedDraftBlockedReason,
  type GeneratedDraft,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "s",
  projectId: "p",
  suiteId: "suite",
  suiteName: "Suite",
};
const draft: GeneratedDraft = {
  id: "imported",
  revision: "r",
  input: {
    suiteId: "suite",
    title: "Triage stale docs",
    query: "Find stale docs and file an issue for each.",
    expectedOutput: "One issue per stale doc, with no duplicates.",
    steps: [],
    models: [],
    runs: 1,
    isNegativeTest: false,
    expectedToolCalls: [],
  },
  markdownImport: {
    issues: [
      {
        code: "unsupported_workflow",
        message: "Complex multi-turn workflow with fan-out",
      },
      {
        code: "unclear_expectation",
        message: "Cannot verify without knowing the corpus state",
      },
    ],
    warnings: ["Technical extraction warning"],
    source: {
      format: "markdown",
      method: "ai",
      fileName: "cases.md",
      fileHash: "a".repeat(64),
      excerpt: "Raw implementation details",
      startLine: 1,
      endLine: 5,
      extractorVersion: "v1",
    },
  },
};
it("shows only editable case content, without extraction diagnostics or acknowledgment", () => {
  render(<ImportedDraftEditor scope={scope} draft={draft} />);
  expect(screen.getByRole("textbox", { name: "User Prompt" })).toHaveValue(
    draft.input.query,
  );
  expect(screen.getByRole("textbox", { name: "Expected Outcome" })).toHaveValue(
    draft.input.expectedOutput,
  );
  expect(
    screen.queryAllByText(
      /fan-out|corpus state|Technical extraction|Source:|Raw implementation/,
    ),
  ).toHaveLength(0);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText(/reviewed and resolved/)).toBeNull();
});
it("does not block a complete case on model diagnostics or acknowledgment", () => {
  expect(importedDraftBlockedReason(draft)).toBeUndefined();
  expect(
    importedDraftBlockedReason({
      ...draft,
      input: { ...draft.input, expectedOutput: "" },
    }),
  ).toMatch(/Complete the case/);
});
