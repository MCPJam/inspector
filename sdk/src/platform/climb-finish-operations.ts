/**
 * The end of a climb: `confirm_climb` runs the one-time confirmation on the
 * cases no round ran. It sits outside the round and credit limits, runs on a
 * stopped climb, and takes `dryRun`, which returns the estimate and starts
 * nothing.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import { suitePermalink } from "./climb-operations.js";
import { MAX_ROUND_WAIT_SECONDS } from "./climb-round-operations.js";
import { climbInput, projectInput, resolveClimbProject, type WithProject } from "./climb-support.js";
import type { PlatformClimbConfirmed } from "./climb-types.js";

const confirmInput = z.object({
  project: projectInput,
  climb: climbInput,
  dryRun: z.boolean().optional().describe("Return what the confirmation would cost and which refusal applies, and start nothing."),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_ROUND_WAIT_SECONDS)
    .optional()
    .describe(`Hold the call until the confirmation settles, for at most this many seconds (up to ${MAX_ROUND_WAIT_SECONDS}). \`settled\` says whether it did; \`get_climb\` returns the result later.`),
});

export type ConfirmClimbInput = z.infer<typeof confirmInput>;
export type ConfirmClimbResult = WithProject<PlatformClimbConfirmed>;

export const confirmClimbOperation: PlatformOperation<ConfirmClimbInput, ConfirmClimbResult> = {
  name: "confirm_climb",
  title: "Confirm a climb",
  description:
    "Run the one-time confirmation of a stopped climb: two run groups back to back on the confirmation cases no round ran, the mock with no changes and the best server, in every environment. The result is the difference in the climb's measure per environment with a 95% interval found by resampling cases (pass rate beside it when the measure is something else), and says when the interval includes zero, which means the gain is within noise and should not be shipped on. It runs once: a second call is refused, and so is one on a climb that kept nothing or set no cases aside. It sits outside the round and credit limits and returns its estimate; `dryRun` returns the estimate alone. THIS LAUNCHES PAID RUNS.",
  readOnly: false,
  risk: "spend",
  permalink: suitePermalink,
  inputSchema: confirmInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const confirmed = await context.client.confirmClimb(
      { projectId: project.id, climbId: input.climb, dryRun: input.dryRun, waitSeconds: input.waitSeconds },
      { signal: context.signal }
    );
    return { ...confirmed, project: info };
  },
};
