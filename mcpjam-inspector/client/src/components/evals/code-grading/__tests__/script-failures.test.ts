import { describe, expect, it } from "vitest";
import {
  iterationScriptFailures,
  readScriptResult,
  runScriptFailures,
  setupScriptFailures,
} from "../script-failures";

const failed = {
  status: "failed",
  exitCode: 1,
  output:
    "Resetting /home/user/app/data\nrm: cannot remove '/home/user/app/data/invoices.db': Device or resource busy",
  durationMs: 812,
};

describe("reading what the runner recorded", () => {
  it("narrows a stored result and refuses anything else", () => {
    expect(readScriptResult(failed)).toEqual(failed);
    expect(
      readScriptResult({ status: "exploded", output: "" }),
    ).toBeUndefined();
    expect(readScriptResult("failed")).toBeUndefined();
    expect(readScriptResult({ status: "passed" })).toEqual({
      status: "passed",
      output: "",
    });
  });
});

describe("Setup failed", () => {
  const iteration = { metadata: { iterationScripts: { setup: failed } } };

  it("says which script failed and that the agent didn't run", () => {
    const [failure] = iterationScriptFailures(iteration);
    expect(failure.slot).toBe("iterationSetup");
    expect(failure.error).toMatchObject({
      title:
        "Couldn't set up this iteration. Fix the script under Setup and cleanup in suite settings.",
      oneLine:
        "The Before each iteration script stopped with an error, so the agent didn't run. This iteration is left out of the pass rate.",
      nextSteps: ["After you fix the script, run the suite again."],
      severity: "error",
      origin: "user_config",
      rawMessage: failed.output,
    });
    expect(failure.rawLabel).toBe("Script output");
    expect(
      setupScriptFailures(iteration, null).map((item) => item.slot),
    ).toEqual(["iterationSetup"]);
  });

  it("words a timeout and a script that couldn't start", () => {
    const timedOut = iterationScriptFailures({
      metadata: {
        iterationScripts: {
          setup: { status: "timeout", output: "waiting", durationMs: 300000 },
        },
      },
    });
    expect(timedOut[0].error.oneLine).toBe(
      "The Before each iteration script was stopped at its time limit, so the agent didn't run. This iteration is left out of the pass rate.",
    );
    const [noBox] = iterationScriptFailures({
      metadata: {
        iterationScripts: {
          setup: { status: "error", output: "", error: "no capacity" },
        },
      },
    });
    expect(noBox.error.oneLine).toContain("script couldn't start, so");
    // No output, so the panel keeps its usual heading over the cause.
    expect(noBox.rawLabel).toBeUndefined();
    expect(noBox.error.rawMessage).toBe("no capacity");
  });

  it("redacts a secret the script printed", () => {
    const [failure] = iterationScriptFailures({
      metadata: {
        iterationScripts: {
          setup: {
            status: "failed",
            exitCode: 22,
            output: "curl: Authorization: Bearer sk-live-123456789",
          },
        },
      },
    });
    expect(failure.error.rawMessage).not.toContain("sk-live-123456789");
  });

  it("ignores a setup that passed", () => {
    const passed = {
      metadata: {
        iterationScripts: {
          setup: { ...failed, status: "passed", exitCode: 0 },
        },
      },
    };
    expect(iterationScriptFailures(passed)).toEqual([]);
    expect(setupScriptFailures(passed, null)).toEqual([]);
    expect(setupScriptFailures({}, null)).toEqual([]);
  });

  it("blames the run's setup script for an iteration it left Setup failed", () => {
    const run = { scriptResults: { runSetup: failed } };
    expect(
      setupScriptFailures({ status: "setup_failed" }, run).map(
        (item) => item.slot,
      ),
    ).toEqual(["runSetup"]);
    // An iteration that ran is not explained by it.
    expect(setupScriptFailures({ status: "completed" }, run)).toEqual([]);
  });
});

describe("the cleanup warning", () => {
  it("is a warning that leaves results unchanged", () => {
    const [failure] = iterationScriptFailures({
      metadata: { iterationScripts: { cleanup: failed } },
    });
    expect(failure.slot).toBe("iterationCleanup");
    expect(failure.error).toMatchObject({
      title:
        "Couldn't clean up after this iteration. Fix the script under Setup and cleanup in suite settings.",
      oneLine:
        "The After each iteration script stopped with an error. This iteration's results are unchanged.",
      severity: "warning",
    });
  });
});

describe("run script failures", () => {
  it("reads run setup and run cleanup off the run row", () => {
    const failures = runScriptFailures({
      scriptResults: {
        runSetup: failed,
        runCleanup: { status: "timeout", output: "" },
      },
    });
    expect(failures.map((failure) => failure.error.oneLine)).toEqual([
      "The Before the run script stopped with an error, so no iteration started.",
      "The After the run script was stopped at its time limit. The run's results are unchanged.",
    ]);
    expect(runScriptFailures({})).toEqual([]);
  });
});
