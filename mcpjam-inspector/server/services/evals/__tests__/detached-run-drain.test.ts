import { beforeEach, describe, expect, it, vi } from "vitest";

const { drain } = vi.hoisted(() => ({
  drain: {
    current: undefined as
      undefined | import("../../lifecycle/drain.js").DrainCoordinator,
  },
}));

vi.mock("../../lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lifecycle/drain.js")
  >("../../lifecycle/drain.js");
  return {
    ...actual,
    get serverDrain() {
      return drain.current;
    },
  };
});

import { createDrainCoordinator } from "../../lifecycle/drain.js";
import { detachPreparedEvalRun } from "../detached-run.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function detach(
  prepared: Parameters<typeof detachPreparedEvalRun>[0]["prepared"],
) {
  detachPreparedEvalRun({
    prepared,
    convexAuthToken: "token",
    logPrefix: "[test]",
    logContext: {},
  });
}

beforeEach(() => {
  drain.current = createDrainCoordinator();
});

describe("detached eval runs and the shutdown drain", () => {
  it("registers a run from the moment it detaches until it settles", async () => {
    const run = deferred();
    detach({ suiteId: "suite", runId: "run", execute: () => run.promise });

    expect(drain.current?.counts()).toEqual({ eval_run: 1 });
    run.resolve();
    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
  });

  it("does not register a replay of a finished run, which executes nothing", () => {
    const execute = vi.fn(async () => {});
    detach({
      suiteId: "suite",
      runId: "run",
      execute,
      deduped: true,
      status: "completed",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(drain.current?.counts()).toEqual({});
  });
});
