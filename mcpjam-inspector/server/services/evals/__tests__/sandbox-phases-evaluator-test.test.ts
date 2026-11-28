import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandExitError } from "e2b";
import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import {
  buildGradingArchive,
  fetchGradingArchive,
} from "../sandbox-phases/grading-archive.js";
import {
  buildGradingInput,
  type GradingInputSource,
} from "../sandbox-phases/grading-input.js";
import {
  testCodeEvaluator,
  type EvaluatorTestDeps,
  type EvaluatorTestSources,
} from "../sandbox-phases/evaluator-test.js";

// EFTW-90 (I5): "Test on a past iteration" runs one unsaved evaluator on one
// stored iteration, in a fresh box, through the functions a run grades with.

const SCRIPT = "/mcpjam/evaluators/draft/check.py";

/** What the draft does in the box: its exit, output and result file. */
type Behavior = {
  exit?: number;
  print?: string;
  result?: string;
  hang?: boolean;
  /** Fail the run the way E2B does when the signal fires. */
  abortOn?: AbortSignal;
};

function scriptedBox(behavior: Behavior) {
  const files = new Map<string, string | Uint8Array>();
  const ran: string[] = [];
  const write = vi.fn(
    async (
      pathOrEntries: string | Array<{ path: string; data: Uint8Array }>,
      data?: string,
    ) => {
      if (typeof pathOrEntries === "string") {
        files.set(pathOrEntries, data ?? "");
      } else {
        for (const entry of pathOrEntries) files.set(entry.path, entry.data);
      }
      return {};
    },
  );
  const sandbox = {
    files: {
      write,
      read: vi.fn(async (path: string) => {
        const data = files.get(path);
        if (typeof data !== "string") throw new Error("not found");
        return data;
      }),
    },
    commands: {
      run: vi.fn(
        async (
          cmd: string,
          opts: { background?: boolean; onStdout?: (d: string) => void },
        ) => {
          if (!opts.background) {
            ran.push(cmd);
            return { exitCode: 0 };
          }
          const script = /\/mcpjam\/evaluators\/[^']+/.exec(cmd)?.[0];
          if (script) ran.push(script);
          if (behavior.print) opts.onStdout?.(behavior.print);
          const resultPath = /MCPJAM_RESULT=([^']+)'/.exec(cmd)?.[1];
          if (resultPath && behavior.result !== undefined) {
            files.set(resultPath, behavior.result);
          }
          return {
            kill: async () => true,
            wait: () =>
              new Promise((resolve, reject) => {
                if (behavior.hang) return;
                if (behavior.abortOn) {
                  behavior.abortOn.addEventListener("abort", () =>
                    reject(new Error("This operation was aborted")),
                  );
                  return;
                }
                if (behavior.exit) {
                  reject(
                    new CommandExitError({
                      exitCode: behavior.exit,
                      error: "exit",
                      stdout: "",
                      stderr: "",
                    } as never),
                  );
                  return;
                }
                resolve({ exitCode: 0 });
              }),
          };
        },
      ),
    },
  };
  return { sandbox: sandbox as unknown as PhaseSandbox, files, ran };
}

const source: GradingInputSource = {
  scenario: { title: "Totals add up" },
  messages: [{ role: "user", content: "Sum the invoices" }],
  toolCalls: [{ toolName: "sum", arguments: { ids: [1, 2] } }],
};

function harness(
  box: PhaseSandbox,
  overrides: Partial<EvaluatorTestDeps> & {
    reply?: Record<string, unknown>;
  } = {},
) {
  const released: string[] = [];
  const { reply, ...depOverrides } = overrides;
  const deps: EvaluatorTestDeps = {
    provision: vi.fn(async () => ({
      ok: true as const,
      value: reply ?? {
        sandboxId: "sbx",
        sandboxRowId: "row",
        runId: "run",
        network: "none",
        workdir: "/home/user",
      },
    })),
    attach: vi.fn(async () => box),
    release: vi.fn(async (row: string) => {
      released.push(row);
    }),
    fetchArchive: vi.fn(fetchGradingArchive),
    ...depOverrides,
  };
  const sources: EvaluatorTestSources = {
    readTranscript: vi.fn(async () => source),
    readDeclaredFiles: vi.fn(async () => ["/home/user/out.json"]),
  };
  return { deps, sources, released };
}

function request(evaluator: Record<string, unknown> = {}) {
  return {
    iterationId: "iteration",
    evaluator: { fileName: "check.py", script: "print(1)", ...evaluator },
  };
}

async function run(
  box: PhaseSandbox,
  options: {
    evaluator?: Record<string, unknown>;
    overrides?: Parameters<typeof harness>[1];
    signal?: AbortSignal;
  } = {},
) {
  const h = harness(box, options.overrides);
  const outcome = await testCodeEvaluator(
    {
      bearer: "member-token",
      suiteId: "suite",
      request: request(options.evaluator),
      sources: h.sources,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    h.deps,
  );
  return { outcome, ...h };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a draft's result", () => {
  it("scores a pass against the default threshold of 1, with its output", async () => {
    const box = scriptedBox({
      print: "3 of 3 add up\n",
      result: '{"score": 1, "reason": "all totals match"}',
    });
    const { outcome, released } = await run(box.sandbox);
    expect(outcome).toEqual({
      ok: true,
      result: {
        runId: "run",
        iterationId: "iteration",
        input: "transcript",
        network: "none",
        result: {
          status: "scored",
          score: 1,
          threshold: 1,
          passed: true,
          reason: "all totals match",
        },
        logs: {
          output: "3 of 3 add up\n",
          exitCode: 0,
          durationMs: expect.any(Number),
        },
      },
    });
    expect(released).toEqual(["row"]);
  });

  it("scores a fail below the draft's own threshold", async () => {
    const box = scriptedBox({ result: '{"score": 0.4}' });
    const { outcome } = await run(box.sandbox, {
      evaluator: { threshold: 0.5, id: "totals" },
    });
    expect(outcome.ok && outcome.result.result).toEqual({
      status: "scored",
      score: 0.4,
      threshold: 0.5,
      passed: false,
    });
    // The draft's own id names its script and result files.
    expect(box.ran).toContain("/mcpjam/evaluators/totals/check.py");
  });

  it.each<[string, Behavior, string]>([
    ["a non-zero exit", { exit: 3, print: "boom\n" }, "Exited with code 3."],
    [
      "a missing result file",
      {},
      "It finished without writing a result to $MCPJAM_RESULT.",
    ],
    ["invalid JSON", { result: "nope" }, "Its result file isn't valid JSON."],
    [
      "a score out of range",
      { result: '{"score": 1.5}' },
      'Its result needs a "score" from 0 to 1.',
    ],
  ])("reports %s with a run's words", async (_name, behavior, error) => {
    const box = scriptedBox(behavior);
    const { outcome, released } = await run(box.sandbox);
    expect(outcome.ok && outcome.result.result).toEqual({
      status: "error",
      error,
    });
    expect(released).toEqual(["row"]);
  });

  it("stops a draft at the 60-second limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const box = scriptedBox({ hang: true, print: "still going\n" });
    const pending = run(box.sandbox);
    await vi.advanceTimersByTimeAsync(60_000);
    const { outcome, released } = await pending;
    expect(outcome.ok && outcome.result.result).toEqual({
      status: "error",
      error: "Stopped at its time limit.",
    });
    expect(outcome.ok && outcome.result.logs.output).toBe("still going\n");
    expect(released).toEqual(["row"]);
  });
});

describe("what the draft grades", () => {
  it("rebuilds the input from the stored iteration when no archive was kept", async () => {
    const box = scriptedBox({ result: '{"score": 1}' });
    const { outcome, sources, deps } = await run(box.sandbox);
    expect(sources.readTranscript).toHaveBeenCalledWith("iteration");
    expect(deps.fetchArchive).not.toHaveBeenCalled();
    expect(box.files.get("/mcpjam/iteration.json")).toBe(
      JSON.stringify(buildGradingInput(source)),
    );
    expect(outcome.ok && outcome.result.input).toBe("transcript");
  });

  it("grades the run's own iteration.json and declared files when it kept them", async () => {
    const iterationJson = JSON.stringify({ version: 1, exact: true });
    const archive = buildGradingArchive({
      iterationJson,
      files: [
        {
          type: "file",
          path: "home/user/out.json",
          executable: false,
          data: new TextEncoder().encode('{"total": 3}'),
        },
      ],
    })!;
    const box = scriptedBox({ result: '{"score": 1}' });
    const { outcome, sources } = await run(box.sandbox, {
      overrides: {
        reply: {
          sandboxId: "sbx",
          sandboxRowId: "row",
          runId: "run",
          network: "web",
          gradingFiles: { url: "https://storage.test/a", bytes: 1 },
        },
        fetchArchive: vi.fn(async () => ({ ok: true as const, archive })),
      },
    });
    expect(sources.readTranscript).not.toHaveBeenCalled();
    expect(sources.readDeclaredFiles).toHaveBeenCalledWith("run");
    expect(box.files.get("/mcpjam/iteration.json")).toBe(iterationJson);
    expect(box.files.get("/home/user/out.json")).toEqual(
      new TextEncoder().encode('{"total": 3}'),
    );
    expect(outcome.ok && outcome.result).toMatchObject({
      input: "stored",
      network: "web",
      result: { status: "scored", score: 1 },
    });
  });

  it("refuses a hostile stored archive without running the draft", async () => {
    const archive = gzipSync(
      buildGradingArchive({ iterationJson: "{}", files: [] })!,
    );
    const box = scriptedBox({ result: '{"score": 1}' });
    const { outcome, deps, released } = await run(box.sandbox, {
      overrides: {
        reply: {
          sandboxId: "sbx",
          sandboxRowId: "row",
          runId: "run",
          gradingFiles: { url: "https://storage.test/a", bytes: 1 },
        },
        fetchArchive: vi.fn(async () => ({
          ok: true as const,
          archive: new Uint8Array(archive),
        })),
      },
    });
    expect(outcome.ok && outcome.result).toMatchObject({
      input: "stored",
      result: {
        status: "error",
        error: "Couldn't read the stored grading files for this iteration.",
      },
      logs: { output: "", durationMs: 0 },
    });
    expect(deps.attach).not.toHaveBeenCalled();
    expect(box.ran).toEqual([]);
    expect(released).toEqual(["row"]);
  });
});

describe("the test box", () => {
  it("is released when the box fails, with a run's words for it", async () => {
    const box = scriptedBox({});
    const { outcome, released } = await run(box.sandbox, {
      overrides: {
        attach: vi.fn(async () => {
          throw new Error("sandbox not found");
        }),
      },
    });
    expect(outcome.ok && outcome.result.result).toEqual({
      status: "error",
      error: "The grading box failed: sandbox not found",
    });
    expect(released).toEqual(["row"]);
  });

  it("is released when the stored iteration can't be read, and the failure goes on", async () => {
    const box = scriptedBox({});
    const h = harness(box.sandbox);
    h.sources.readTranscript = vi.fn(async () => {
      throw new Error("read failed");
    });
    await expect(
      testCodeEvaluator(
        {
          bearer: "member-token",
          suiteId: "suite",
          request: request(),
          sources: h.sources,
        },
        h.deps,
      ),
    ).rejects.toThrow("read failed");
    expect(h.released).toEqual(["row"]);
  });

  it("is released when the request is aborted mid-run", async () => {
    const controller = new AbortController();
    const box = scriptedBox({ abortOn: controller.signal });
    const pending = run(box.sandbox, { signal: controller.signal });
    await vi.waitFor(() => expect(box.ran).toContain(SCRIPT));
    controller.abort();
    const { outcome, released } = await pending;
    expect(outcome.ok && outcome.result.result).toMatchObject({
      status: "error",
    });
    expect(released).toEqual(["row"]);
  });

  it("is released when its reply can't be used, and nothing runs", async () => {
    const box = scriptedBox({});
    const { outcome, released, deps } = await run(box.sandbox, {
      overrides: { reply: { sandboxRowId: "row" } },
    });
    expect(outcome).toMatchObject({ ok: false, refusal: { status: 502 } });
    expect(deps.attach).not.toHaveBeenCalled();
    expect(released).toEqual(["row"]);
  });

  it("passes a refusal through untouched, with nothing to release", async () => {
    const box = scriptedBox({});
    const refusal = {
      ok: false as const,
      status: 429,
      error:
        "You just tested an evaluator on this iteration. Wait a few seconds, then try again.",
      code: "EVAL_CODE_EVALUATOR_PREVIEW_COOLDOWN",
    };
    const { outcome, released, deps } = await run(box.sandbox, {
      overrides: { provision: vi.fn(async () => refusal) },
    });
    expect(outcome).toEqual({ ok: false, refusal });
    expect(deps.attach).not.toHaveBeenCalled();
    expect(released).toEqual([]);
  });

  it("asks for the requested network, and the member's bearer", async () => {
    const box = scriptedBox({ result: '{"score": 1}' });
    const h = harness(box.sandbox);
    await testCodeEvaluator(
      {
        bearer: "member-token",
        suiteId: "suite",
        request: { ...request(), network: "web" },
        sources: h.sources,
      },
      h.deps,
    );
    expect(h.deps.provision).toHaveBeenCalledWith({
      bearer: "member-token",
      suiteId: "suite",
      iterationId: "iteration",
      network: "web",
    });
  });
});
