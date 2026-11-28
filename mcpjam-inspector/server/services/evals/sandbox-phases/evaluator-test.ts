/**
 * "Test on a past iteration" (EFTW-90, plan step I5): an unsaved code
 * evaluator, run once against one stored iteration of a finished run, in a
 * fresh box booted from the run's own image, writing nothing.
 *
 * With a stored grading archive the draft grades exactly what the run graded
 * (`input: "stored"`); otherwise the runs' own builder rebuilds the input from
 * the stored iteration (`input: "transcript"`), without the declared files.
 * The box is prepared and the draft run by the functions a run uses
 * (`iteration-phases.ts`), under the same 60-second limit, and released
 * however the test ends.
 */
import {
  scorePassed,
  type CodeEvaluatorTestRequest,
  type CodeEvaluatorTestResult,
} from "@mcpjam/sdk/contract";
import { z } from "zod";
import { attachRunningSandbox } from "../../../utils/computers/attach-sandbox.js";
import {
  provisionCodeEvaluatorPreview,
  type CodeEvaluatorPreviewReply,
} from "../../../utils/computers/code-evaluator-preview-client.js";
import {
  releaseSandbox,
  type ControlPlaneResult,
} from "../../../utils/computers/control-plane-client.js";
import { logger } from "../../../utils/logger.js";
import {
  codeEvaluatorPassThreshold,
  type CodeEvaluatorOutcome,
} from "./code-score-family.js";
import type { PhaseSandbox } from "./exec.js";
import { fetchGradingArchive, readGradingArchive } from "./grading-archive.js";
import { buildGradingInput, type GradingInputSource } from "./grading-input.js";
import {
  PHASE_LIMITS_MS,
  prepareGradingBox,
  runCodeEvaluator,
  type GradedCodeEvaluator,
  type GradingBoxInput,
} from "./iteration-phases.js";
import { PHASE_BOX_RELEASE_TIMEOUT_MS } from "./phase-box.js";

/** The id a draft without one runs under; it names its result file. */
export const DRAFT_EVALUATOR_ID = "draft";

/** A refusal from the backend, in its own words. */
export type EvaluatorTestRefusal = Extract<
  ControlPlaneResult<never>,
  { ok: false }
>;

export type EvaluatorTestOutcome =
  | { ok: true; result: CodeEvaluatorTestResult }
  | { ok: false; refusal: EvaluatorTestRefusal };

/** Where a test reads the stored iteration from, as the member. */
export type EvaluatorTestSources = {
  /** The iteration as stored, for the rebuilt input. */
  readTranscript: (iterationId: string) => Promise<GradingInputSource>;
  /** The paths the iteration's run froze in `grading.files`. */
  readDeclaredFiles: (runId: string) => Promise<readonly string[]>;
};

/** Injected in tests; the real ones talk to the control plane and E2B. */
export type EvaluatorTestDeps = {
  provision: typeof provisionCodeEvaluatorPreview;
  attach: (sandboxId: string) => Promise<PhaseSandbox>;
  release: (sandboxRowId: string) => Promise<void>;
  fetchArchive: typeof fetchGradingArchive;
};

const defaultDeps: EvaluatorTestDeps = {
  provision: provisionCodeEvaluatorPreview,
  attach: (sandboxId) => attachRunningSandbox(sandboxId),
  release: (sandboxRowId) =>
    releaseSandbox({
      sandboxRowId,
      // Its own clock, not the request's: it must run after an abort too.
      signal: AbortSignal.timeout(PHASE_BOX_RELEASE_TIMEOUT_MS),
    }),
  fetchArchive: fetchGradingArchive,
};

const nonEmpty = z.string().refine((value) => value.trim() !== "");

/** The provision reply's fields a test uses. */
const previewBoxSchema = z.object({
  sandboxId: nonEmpty,
  sandboxRowId: nonEmpty,
  runId: nonEmpty,
  network: z.enum(["none", "web"]).catch("none"),
  gradingFiles: z
    .object({ url: nonEmpty, bytes: z.number().nonnegative() })
    .nullish()
    .catch(() => {
      // Unusable, so the test rebuilds its input and says so.
      logger.warn("[evals] test box named an unusable grading archive");
      return undefined;
    }),
});

type PreviewBox = z.infer<typeof previewBoxSchema>;

/** The provision reply's fields, or the row to release when it is unusable. */
function readPreviewBox(
  reply: CodeEvaluatorPreviewReply,
): { ok: true; box: PreviewBox } | { ok: false; sandboxRowId?: string } {
  const parsed = previewBoxSchema.safeParse(reply);
  if (parsed.success) return { ok: true, box: parsed.data };
  const sandboxRowId = nonEmpty.safeParse(reply?.sandboxRowId).data;
  return { ok: false, ...(sandboxRowId ? { sandboxRowId } : {}) };
}

type PreparedInput =
  | { input: "stored" | "transcript"; boxInput: GradingBoxInput }
  | { input: "stored"; problem: string };

/** The run's own grading input when it was stored, or one rebuilt now. */
async function gradingInputFor(
  box: PreviewBox,
  iterationId: string,
  sources: EvaluatorTestSources,
  deps: EvaluatorTestDeps,
  signal: AbortSignal | undefined,
): Promise<PreparedInput> {
  if (!box.gradingFiles) {
    const input = buildGradingInput(await sources.readTranscript(iterationId));
    return {
      input: "transcript",
      boxInput: { iterationJson: JSON.stringify(input), files: [] },
    };
  }
  const fetched = await deps.fetchArchive(box.gradingFiles, signal);
  if (!fetched.ok) return { input: "stored", problem: fetched.problem };
  const declared = await sources.readDeclaredFiles(box.runId);
  const stored = await readGradingArchive(fetched.archive, declared);
  return stored.ok
    ? { input: "stored", boxInput: stored.input }
    : { input: "stored", problem: stored.problem };
}

/** Prepare the box and run the draft, as `gradeIteration` does for a run. */
async function runInBox(
  deps: EvaluatorTestDeps,
  box: PreviewBox,
  boxInput: GradingBoxInput,
  evaluator: GradedCodeEvaluator,
  iterationId: string,
  signal: AbortSignal | undefined,
): Promise<CodeEvaluatorOutcome> {
  try {
    const sandbox = await deps.attach(box.sandboxId);
    await prepareGradingBox(sandbox, boxInput);
    return await runCodeEvaluator(sandbox, evaluator, {
      runId: box.runId,
      iterationId,
      timeoutMs: PHASE_LIMITS_MS.evaluator,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // The box itself failed (lost, unreachable): a run's words for it.
    return {
      kind: "error",
      error: `The grading box failed: ${error instanceof Error ? error.message : String(error)}`,
      output: "",
    };
  }
}

function toTestResult(
  box: PreviewBox,
  iterationId: string,
  input: "stored" | "transcript",
  threshold: number,
  outcome: CodeEvaluatorOutcome,
): CodeEvaluatorTestResult {
  return {
    runId: box.runId,
    iterationId,
    input,
    network: box.network,
    result:
      outcome.kind === "scored"
        ? {
            status: "scored",
            score: outcome.score,
            threshold,
            passed: scorePassed(outcome.score, threshold),
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          }
        : { status: "error", error: outcome.error },
    logs: {
      output: outcome.output,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      durationMs: outcome.durationMs ?? 0,
    },
  };
}

/**
 * Test one draft evaluator on one stored iteration. A backend refusal comes
 * back in its own words; anything the evaluator does wrong is a result with
 * a run's error string. A failed read of the stored iteration throws, after
 * the box is released.
 */
export async function testCodeEvaluator(
  args: {
    bearer: string;
    suiteId: string;
    request: CodeEvaluatorTestRequest;
    sources: EvaluatorTestSources;
    signal?: AbortSignal;
  },
  deps: EvaluatorTestDeps = defaultDeps,
): Promise<EvaluatorTestOutcome> {
  const { request, signal } = args;
  const provisioned = await deps.provision({
    bearer: args.bearer,
    suiteId: args.suiteId,
    iterationId: request.iterationId,
    ...(request.network ? { network: request.network } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!provisioned.ok) return { ok: false, refusal: provisioned };
  const read = readPreviewBox(provisioned.value);
  const sandboxRowId = read.ok ? read.box.sandboxRowId : read.sandboxRowId;
  try {
    if (!read.ok) {
      const error =
        "The test box started without the details needed to use it.";
      return { ok: false, refusal: { ok: false, status: 502, error } };
    }
    const { box } = read;
    const prepared = await gradingInputFor(
      box,
      request.iterationId,
      args.sources,
      deps,
      signal,
    );
    const evaluator: GradedCodeEvaluator = {
      id: request.evaluator.id ?? DRAFT_EVALUATOR_ID,
      fileName: request.evaluator.fileName,
      script: request.evaluator.script,
    };
    const outcome: CodeEvaluatorOutcome =
      "problem" in prepared
        ? { kind: "error", error: prepared.problem, output: "" }
        : await runInBox(
            deps,
            box,
            prepared.boxInput,
            evaluator,
            request.iterationId,
            signal,
          );
    return {
      ok: true,
      result: toTestResult(
        box,
        request.iterationId,
        prepared.input,
        codeEvaluatorPassThreshold(request.evaluator),
        outcome,
      ),
    };
  } finally {
    // A release that fails leaves the box to the reaper; it must not fail
    // the test, which already has its answer.
    if (sandboxRowId) {
      await deps.release(sandboxRowId).catch((error: unknown) => {
        logger.warn("[evals] could not release a test box", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}
