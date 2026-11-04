import { describe, expect, it } from "vitest";
import {
  isMissingInputCheck,
  missingInputForCheck,
  missingInputMessage,
} from "../src/conformance-input.js";

describe("missing conformance inputs", () => {
  const skipped = {
    id: "tasks-result-type-discipline",
    status: "skipped",
    skipReason: "could-not-run",
  };

  it.each(["tasksProbe", "logProbe", "inputRequiredProbe", "toolCallProbe"])(
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
