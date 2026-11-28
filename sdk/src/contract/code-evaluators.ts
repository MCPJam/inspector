import { z } from "zod";

/**
 * Code evaluators, setup and cleanup scripts, and grading-box settings on an
 * eval suite (EFTW-90): one authoring shape for the API, the SDK, MCP, the CLI
 * and suite files.
 *
 * The limits mirror the platform's (`convex/lib/codeEvaluatorConfig.ts`) so a
 * bad value is refused before the write. The platform still checks every one,
 * and normalizes: blank scripts and an empty evaluator list clear the field.
 */

/** A suite takes at most this many code evaluators. */
export const MAX_CODE_EVALUATORS = 10;
/** Per script, in UTF-8 bytes. */
export const MAX_CODE_SCRIPT_BYTES = 64 * 1024;
/**
 * Every evaluator and script body on a suite together. A write that sends
 * only some of them is checked against the stored rest by the platform.
 */
export const MAX_CODE_SCRIPTS_TOTAL_BYTES = 256 * 1024;
/** Paths a suite may copy into the grading box. */
export const MAX_GRADING_FILES = 20;
/** Declared files must live under the box user's home. */
export const GRADING_FILES_ROOT = "/home/user/";
/** Per declared path, in characters, as the platform counts them. */
export const MAX_GRADING_FILE_PATH_CHARS = 512;

export const CODE_EVALUATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The extension picks the interpreter: `.sh` bash, `.py` python3, `.ts`/`.js` node. */
export const CODE_EVALUATOR_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(sh|py|ts|js)$/;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const scriptSchema = z
  .string()
  .refine((script) => utf8Bytes(script) <= MAX_CODE_SCRIPT_BYTES, {
    message: `Scripts can be at most ${MAX_CODE_SCRIPT_BYTES.toLocaleString("en-US")} bytes.`,
  });

/**
 * Why a declared path is refused, or `undefined`: absolute, under
 * `/home/user/`, and outside hidden folders, so a copied file can't be the
 * grader's own input or code Python or Node load on start.
 */
export function gradingFilePathProblem(path: string): string | undefined {
  if (path.length > MAX_GRADING_FILE_PATH_CHARS) {
    return `is longer than ${MAX_GRADING_FILE_PATH_CHARS} characters`;
  }
  if ([...path].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\u007f")) {
    return "has a control character";
  }
  if (!path.startsWith(GRADING_FILES_ROOT)) {
    return `must start with ${GRADING_FILES_ROOT}`;
  }
  const rest = path.slice(GRADING_FILES_ROOT.length).replace(/\/$/, "");
  if (!rest) return `must name a file or folder inside ${GRADING_FILES_ROOT}`;
  for (const segment of rest.split("/")) {
    if (!segment) return 'has an empty folder name ("//")';
    if (segment === "..") return 'contains ".."';
    if (segment.startsWith(".")) {
      return "is inside a hidden folder or names a hidden file";
    }
  }
  return undefined;
}

export const codeEvaluatorSchema = z.strictObject({
  id: z
    .string()
    .regex(CODE_EVALUATOR_ID_PATTERN, {
      message: 'Use 1 to 64 letters, digits, "-" or "_".',
    })
    .describe("Stable id; the score row is code:<id>."),
  name: z.string().trim().min(1).max(100).optional(),
  fileName: z
    .string()
    .regex(CODE_EVALUATOR_FILE_NAME_PATTERN, {
      message: "Use a file name ending in .sh, .py, .ts or .js.",
    })
    .describe("The extension picks the interpreter."),
  script: scriptSchema
    .refine((script) => script.trim().length > 0, {
      message: "The script is empty.",
    })
    .describe(
      'Reads the iteration from $MCPJAM_ITERATION and writes {"score": 0 to 1, "reason": "..."} to $MCPJAM_RESULT.'
    ),
  role: z
    .enum(["required", "advisory"])
    .optional()
    .describe(
      "Required gates the iteration; advisory only reports. Default advisory."
    ),
  threshold: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe("The score an iteration needs to pass. Default 1."),
  evaluator: z
    .strictObject({
      id: z.string().min(1).max(64),
      version: z.number().int().min(1),
    })
    .optional(),
});

export const codeEvaluatorsSchema = z
  .array(codeEvaluatorSchema)
  .max(MAX_CODE_EVALUATORS)
  .superRefine((evaluators, ctx) => {
    const total = evaluators.reduce(
      (sum, evaluator) => sum + utf8Bytes(evaluator.script),
      0
    );
    if (total > MAX_CODE_SCRIPTS_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `Code evaluators and scripts can total at most ${MAX_CODE_SCRIPTS_TOTAL_BYTES.toLocaleString("en-US")} bytes. These evaluators total ${total.toLocaleString("en-US")}.`,
      });
    }
    const ids = new Set<string>();
    evaluators.forEach((evaluator, index) => {
      if (ids.has(evaluator.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Code evaluator ids must be unique.",
          path: [index, "id"],
        });
      }
      ids.add(evaluator.id);
    });
  });

/** Bash scripts around the run and around each iteration. A blank one is none. */
export const suiteScriptsSchema = z.strictObject({
  runSetup: scriptSchema.optional(),
  iterationSetup: scriptSchema.optional(),
  iterationCleanup: scriptSchema.optional(),
  runCleanup: scriptSchema.optional(),
});

export const suiteGradingSchema = z.strictObject({
  files: z
    .array(
      z.string().superRefine((path, ctx) => {
        const problem = gradingFilePathProblem(path);
        if (problem) {
          ctx.addIssue({ code: "custom", message: `The path ${problem}.` });
        }
      })
    )
    .max(MAX_GRADING_FILES)
    .optional()
    .describe(
      "Files or folders from the agent's box to copy into the grading box."
    ),
  network: z
    .enum(["none", "web"])
    .optional()
    .describe("none (default): evaluators can't reach the network."),
});

export type CodeEvaluatorInput = z.infer<typeof codeEvaluatorSchema>;
export type SuiteScriptsInput = z.infer<typeof suiteScriptsSchema>;
export type SuiteGradingInput = z.infer<typeof suiteGradingSchema>;

/**
 * "Test on a past iteration": an unsaved evaluator, run once against one
 * stored iteration of a finished run, in a fresh box, saving nothing. It
 * carries what running it reads, with a saved evaluator's limits.
 */
export const codeEvaluatorDraftSchema = codeEvaluatorSchema
  .pick({ fileName: true, script: true, threshold: true })
  .extend({
    id: codeEvaluatorSchema.shape.id
      .optional()
      .describe("Names the draft's result file. Default draft."),
  });

/**
 * How long one test may take: a box boot, the 60-second evaluator limit and
 * the release, with room for a capacity answer. Well past a client's usual
 * 30-second deadline, so every client of the route asks for this instead.
 */
export const CODE_EVALUATOR_TEST_TIMEOUT_MS = 5 * 60_000;

export const codeEvaluatorTestRequestSchema = z.strictObject({
  iterationId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe("An iteration of one of the suite's finished runs."),
  evaluator: codeEvaluatorDraftSchema,
  network: suiteGradingSchema.shape.network.describe(
    "The grading box's network for this test. Omit it to use the suite's saved setting."
  ),
});

export type CodeEvaluatorDraft = z.infer<typeof codeEvaluatorDraftSchema>;
export type CodeEvaluatorTestRequest = z.infer<
  typeof codeEvaluatorTestRequestSchema
>;

/** What one test did. The suite, the run and its scores stay as they were. */
export type CodeEvaluatorTestResult = {
  runId: string;
  iterationId: string;
  /**
   * `stored`: the run's exact iteration.json and declared files.
   * `transcript`: rebuilt from the stored iteration, without declared files.
   */
  input: "stored" | "transcript";
  network: "none" | "web";
  /** A run's error strings for the same failures. */
  result:
    | {
        status: "scored";
        score: number;
        threshold: number;
        passed: boolean;
        reason?: string;
      }
    | { status: "error"; error: string };
  /** The output tail, at most 8 KB. */
  logs: { output: string; exitCode?: number; durationMs: number };
};
