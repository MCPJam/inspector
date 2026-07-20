/**
 * The evals group's own contract: exact tool set, honest annotations (the
 * destructive set is run + generate + delete — each spends money/quota or destroys
 * data), dispatch shapes, and the quota-exhausted command error passing
 * through as a tool error (the quota decision itself lives in EvalsTab's
 * handler — see EvalsTab.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommandResponse } from "@/shared/inspector-command.js";

const { dispatchInspectorCommandMock } = vi.hoisted(() => ({
  dispatchInspectorCommandMock: vi.fn(),
}));

vi.mock("../../ui-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui-actions")>();
  return { ...actual, dispatchInspectorCommand: dispatchInspectorCommandMock };
});

import { buildEvalsUiTools } from "../evals";

const EVALS_TOOL_NAMES = [
  "ui_open_eval_suite_form",
  "ui_run_eval_suite",
  "ui_cancel_eval_run",
  "ui_generate_eval_tests",
  "ui_delete_eval_suite",
];

function getTool(name: string) {
  const tool = buildEvalsUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`evals group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildEvalsUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the five evals tools", () => {
    expect(buildEvalsUiTools().map((t) => t.name)).toEqual(EVALS_TOOL_NAMES);
  });

  it("annotates every tool completely and honestly", () => {
    // open form: prepares only (prefill-over-commit), stays inside MCPJam;
    // idempotent — a retry just restores the same create route + prefill.
    expect(getTool("ui_open_eval_suite_form").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // run: real model + MCP traffic that spends quota → destructive (the
    // guide gates money spends on the confirmation pill); NOT idempotent.
    expect(getTool("ui_run_eval_suite").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // cancel: stops work, re-cancelling changes nothing.
    expect(getTool("ui_cancel_eval_run").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // generate: spends money and mutates the suite → destructive.
    expect(getTool("ui_generate_eval_tests").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // delete: irreversible → destructive; re-deleting fails cleanly.
    expect(getTool("ui_delete_eval_suite").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildEvalsUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly generate + delete behind the destructive approval pill", () => {
    const destructive = buildEvalsUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual([
      "ui_run_eval_suite",
      "ui_generate_eval_tests",
      "ui_delete_eval_suite",
    ]);
  });

  it("run and generate declare their spending in the description", () => {
    expect(getTool("ui_run_eval_suite").description).toMatch(
      /eval iteration quota/i,
    );
    expect(getTool("ui_generate_eval_tests").description).toMatch(
      /spends money/i,
    );
  });

  it("ui_open_eval_suite_form dispatches openEvalSuiteForm with an optional name prefill", async () => {
    await getTool("ui_open_eval_suite_form").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "openEvalSuiteForm",
      payload: {},
    });

    await getTool("ui_open_eval_suite_form").execute({ name: "Asana smoke" });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "openEvalSuiteForm",
      payload: { name: "Asana smoke" },
    });
  });

  it("ui_open_eval_suite_form rejects a non-string name without dispatching", async () => {
    const result = await getTool("ui_open_eval_suite_form").execute({
      name: 42,
    });
    expect(result.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_run_eval_suite dispatches runEvalSuite and requires 'suite'", async () => {
    await getTool("ui_run_eval_suite").execute({ suite: "Asana smoke" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "runEvalSuite",
      payload: { suite: "Asana smoke" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_run_eval_suite").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_run_eval_suite surfaces the quota-exhausted command error as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "execution_failed",
        message:
          "Cannot start a run: Eval iteration limit reached. Resets Jul 18, 9:00 AM. (25/25 eval iterations used)",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_run_eval_suite").execute({
      suite: "Asana smoke",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("execution_failed");
    expect(result.content[0].text).toContain("Eval iteration limit reached");
  });

  it("ui_cancel_eval_run dispatches cancelEvalRun and requires 'runId'", async () => {
    await getTool("ui_cancel_eval_run").execute({ runId: "j1234567890" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "cancelEvalRun",
      payload: { runId: "j1234567890" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_cancel_eval_run").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_generate_eval_tests dispatches generateEvalTests and requires 'suite'", async () => {
    await getTool("ui_generate_eval_tests").execute({ suite: "Asana smoke" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "generateEvalTests",
      payload: { suite: "Asana smoke" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_generate_eval_tests").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_delete_eval_suite dispatches deleteEvalSuite and requires 'suite'", async () => {
    await getTool("ui_delete_eval_suite").execute({ suite: "Asana smoke" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "deleteEvalSuite",
      payload: { suite: "Asana smoke" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_delete_eval_suite").execute({
      suite: "   ",
    });
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("surfaces unknown-suite command errors (invalid_request) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "invalid_request",
        message: 'No eval suite matches "Nope".',
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_delete_eval_suite").execute({
      suite: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});
