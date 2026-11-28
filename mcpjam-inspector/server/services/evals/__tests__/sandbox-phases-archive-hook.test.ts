import { beforeEach, describe, expect, it, vi } from "vitest";

// EFTW-90: the hosted flow stores a graded iteration's archive after grading,
// while cleanup runs, and hands its storage id to the terminal write.

const upload = vi.hoisted(() => vi.fn());
vi.mock("../sandbox-phases/grading-archive-upload.js", () => ({
  GRADING_ARCHIVE_UPLOAD_TIMEOUT_MS: 30_000,
  uploadGradingArchive: upload,
}));

import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import {
  finishIterationPhases,
  iterationPhaseContext,
} from "../sandbox-phases/iteration-hooks.js";
import type { PhaseBoxDeps } from "../sandbox-phases/phase-box.js";
import { buildIterationFinishParams } from "../finalize-iteration.js";

const evaluator = {
  id: "totals",
  fileName: "check.sh",
  script: "echo",
  role: "required" as const,
};
const input = {
  version: 1 as const,
  scenario: { title: "Case" },
  transcript: { toolCalls: [] },
  trace: { messages: [] },
};

/** Any phase's box: commands succeed and the evaluator scores 1. */
function anyBox(): PhaseSandbox {
  const files = new Map<string, string>();
  return {
    files: {
      write: vi.fn(async (path: string, data: string) => {
        files.set(path, data);
        return {};
      }),
      read: vi.fn(async (path: string) => {
        const data = files.get(path);
        if (data === undefined) throw new Error("not found");
        return data;
      }),
    },
    commands: {
      run: vi.fn(async (cmd: string, opts?: { background?: boolean }) => {
        if (!opts?.background) return { exitCode: 0 };
        const resultPath = /MCPJAM_RESULT=([^']+)'/.exec(cmd)?.[1];
        if (resultPath) files.set(resultPath, '{"score": 1}');
        return { kill: async () => true, wait: async () => ({ exitCode: 0 }) };
      }),
    },
  } as unknown as PhaseSandbox;
}

function context(log: string[]) {
  const deps: PhaseBoxDeps = {
    provision: (async (args: { phase: string }) => {
      log.push(`provision ${args.phase}`);
      return {
        ok: true,
        value: { sandboxId: args.phase, sandboxRowId: args.phase },
      };
    }) as unknown as PhaseBoxDeps["provision"],
    attach: async () => anyBox(),
    release: async () => {},
  };
  return {
    ...iterationPhaseContext({
      config: {
        codeEvaluators: [evaluator],
        scripts: { iterationCleanup: "echo bye" },
        grading: {},
      },
      runId: "run",
      iterationId: "iteration",
      bearer: () => "member-token",
      deadlineAt: Date.now() + 60_000,
    })!,
    deps,
  };
}

beforeEach(() => {
  upload.mockReset();
});

describe("the grading archive in the hosted flow", () => {
  it("stores what the grading box got and passes the confirmed id on", async () => {
    const log: string[] = [];
    upload.mockImplementation(async () => {
      log.push("upload");
      return "storage-1";
    });
    const result = await finishIterationPhases(
      context(log),
      { input: () => input },
      {},
    );
    expect(upload).toHaveBeenCalledOnce();
    const [args] = upload.mock.calls[0];
    expect(args).toMatchObject({
      runId: "run",
      iterationId: "iteration",
      input: { iterationJson: JSON.stringify(input), files: [] },
    });
    expect(args.bearer()).toBe("member-token");
    expect(args.timeoutMs).toBeGreaterThan(0);
    expect(args.timeoutMs).toBeLessThanOrEqual(30_000);
    // Started after grading, alongside cleanup.
    expect(log).toEqual([
      "provision grading",
      "upload",
      "provision iteration_cleanup",
    ]);
    expect(result).toMatchObject({
      outcomes: { totals: { kind: "scored", score: 1 } },
      gradingFilesStorageId: "storage-1",
    });
    expect(result).not.toHaveProperty("boxInput");
    expect(buildIterationFinishParams(finishArgs(result!))).toMatchObject({
      gradingFilesStorageId: "storage-1",
    });
  });

  it("finishes without the field when nothing was stored", async () => {
    upload.mockResolvedValue(undefined);
    const result = await finishIterationPhases(
      context([]),
      { input: () => input },
      {},
    );
    expect(result).not.toHaveProperty("gradingFilesStorageId");
    expect(result?.outcomes.totals).toMatchObject({ kind: "scored" });
    expect(buildIterationFinishParams(finishArgs(result!))).not.toHaveProperty(
      "gradingFilesStorageId",
    );
  });

  it("stores nothing for an iteration that wasn't graded in a box", async () => {
    const result = await finishIterationPhases(
      context([]),
      { notRun: "Not run: setup failed.", input: () => input },
      {},
    );
    expect(upload).not.toHaveBeenCalled();
    expect(result?.notRun).toBe("Not run: setup failed.");
  });
});

function finishArgs(
  codeGrading: NonNullable<Awaited<ReturnType<typeof finishIterationPhases>>>,
): Parameters<typeof buildIterationFinishParams>[0] {
  return {
    iterationId: "iteration",
    codeGrading,
    passed: true,
    evaluation: {
      toolsCalled: [],
      turnCount: 1,
      failedTurnCount: 0,
      missing: [],
      unexpected: [],
      argumentMismatches: [],
    },
    usage: {},
    messages: [],
    status: "completed",
    startedAt: 0,
    iterationMetadataBase: {},
  };
}
