import { describe, expect, it } from "vitest";
import {
  isMissingInputCheck,
  missingInputForCheck,
  missingInputMessage,
  needsSetupDetails,
  noTaskCreatedMessage,
} from "../src/conformance-input.js";

describe("missing conformance inputs", () => {
  const skipped = {
    id: "tasks-result-type-discipline",
    status: "skipped",
    skipReason: "could-not-run",
  };

  it.each([
    "tasksProbe",
    "logProbe",
    "inputRequiredProbe",
    "toolCallProbe",
    "login",
  ])(
    "recognizes a structured %s gap in raw and saved checks",
    (missingInput) => {
      expect(
        missingInputForCheck({ ...skipped, details: { missingInput } })
      ).toBe(missingInput);
      expect(
        missingInputForCheck({
          ...skipped,
          details: { details: { missingInput } },
        })
      ).toBe(missingInput);
    }
  );

  it("shows a gap's own fix ahead of the generic copy, raw or saved", () => {
    const own = "Your arguments don't match. Fix them in setup, then run again.";
    expect(
      missingInputMessage({
        ...skipped,
        details: needsSetupDetails("tasksProbe", own),
      })
    ).toBe(own);
    expect(
      missingInputMessage({
        ...skipped,
        details: { details: needsSetupDetails("logProbe", own) },
      })
    ).toBe(own);
    expect(
      missingInputMessage({ ...skipped, details: needsSetupDetails("login") })
    ).toBe("This server needs a login. Log in, then run again.");
  });

  it("recognizes an older Tasks report and replaces its raw diagnostic", () => {
    const saved = {
      ...skipped,
      error:
        "no probe tool could be selected automatically: tools are chosen by `execution.taskSupport`",
    };
    expect(isMissingInputCheck(saved)).toBe(true);
    expect(missingInputMessage(saved)).toBe(
      "Select a tool that creates a task in setup, then run again."
    );
  });

  it("never hides actual violations or unrelated execution failures", () => {
    expect(
      isMissingInputCheck({
        ...skipped,
        status: "failed",
        details: { missingInput: "tasksProbe" },
      })
    ).toBe(false);
    expect(
      isMissingInputCheck({ ...skipped, error: "polling task task-1 failed" })
    ).toBe(false);
    expect(
      isMissingInputCheck({
        ...skipped,
        error: "the requested probe tool is not listed by this server",
      })
    ).toBe(false);
    expect(
      isMissingInputCheck({ ...skipped, details: { missingInput: "unknown" } })
    ).toBe(false);
  });
});

describe("a tasks tool that returned no task", () => {
  const skipped = {
    id: "tasks-ttl-shape",
    status: "skipped",
    skipReason: "could-not-run",
  };
  const appText =
    '"hello-task" did not create a task, so there was nothing to check. Select a tool that creates a task in setup, or change its arguments so it does, then run again.';

  it("replaces the CLI text, and the older saved text, with setup copy", () => {
    expect(
      noTaskCreatedMessage({
        ...skipped,
        error: {
          message:
            '"hello-task" returned a normal result instead of a task, so there was nothing to check; pass --tool-name (SDK: toolName) with a tool that creates a task, or --tool-args (SDK: toolArguments) that make this one create a task',
        },
      })
    ).toBe(appText);
    expect(
      noTaskCreatedMessage({
        ...skipped,
        error:
          'the probed tool "hello-task" returned a normal result, so no task existed to inspect; name a task-creating tool with --tool-name (SDK: toolName) or supply --tool-args (SDK: toolArguments) that provoke one',
      })
    ).toBe(appText);
  });

  it("is not a missing input, so it still holds the run back", () => {
    const check = {
      ...skipped,
      error: '"hello-task" returned a normal result instead of a task',
    };
    expect(isMissingInputCheck(check)).toBe(false);
    expect(missingInputMessage(check)).toBeUndefined();
  });

  it("leaves other checks and other reasons alone", () => {
    const error = '"hello-task" returned a normal result instead of a task';
    expect(
      noTaskCreatedMessage({ ...skipped, status: "failed", error })
    ).toBeUndefined();
    expect(
      noTaskCreatedMessage({ ...skipped, id: "modern-ping", error })
    ).toBeUndefined();
    expect(
      noTaskCreatedMessage({ ...skipped, error: "polling task task-1 failed" })
    ).toBeUndefined();
  });
});
