/**
 * The end of a climb: `confirm_climb` runs the one-time confirmation on the
 * cases no round ran. `verify_climb` checks the real server after the kept
 * changes are in its code. Both sit outside the round and credit limits, run on
 * a stopped climb, and take `dryRun`, which returns the estimate and starts
 * nothing.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import { suitePermalink } from "./climb-operations.js";
import { MAX_ROUND_WAIT_SECONDS } from "./climb-round-operations.js";
import { climbInput, projectInput, resolveClimbProject, resolveServerId, text, type WithProject } from "./climb-support.js";
import type { PlatformClimbConfirmed, PlatformClimbVerified } from "./climb-types.js";

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

const verifyInput = z.object({
  project: projectInput,
  climb: climbInput,
  commit: text.max(64).optional().describe("The commit the server runs, as the full or short sha. Recorded on the runs and the climb. MCPJam cannot check which code a server runs: it records what you give."),
  branch: text.max(200).optional().describe("The branch of that commit."),
  repositoryUrl: text.max(512).optional().describe("The repository's URL."),
  dirty: z.boolean().optional().describe("True when the checkout had uncommitted changes. Recorded beside the commit."),
  server: text.optional().describe("A saved server that runs the new code, by name or ID, in place of the climbed one. A mock is refused."),
  serverVersion: text.max(200).optional().describe("The version the server reports, as recorded."),
  dryRun: z.boolean().optional().describe("Return the listing check and the estimate, and start nothing."),
  runAnyway: z.boolean().optional().describe("Run the pair even though the listing check found a kept change missing or different."),
  waitSeconds: z.number().int().min(0).max(MAX_ROUND_WAIT_SECONDS).optional().describe(`Hold the call until the verification settles, for at most this many seconds (up to ${MAX_ROUND_WAIT_SECONDS}). \`settled\` says whether it did.`),
});

export type VerifyClimbInput = z.infer<typeof verifyInput>;
export type VerifyClimbResult = WithProject<PlatformClimbVerified>;

export const verifyClimbOperation: PlatformOperation<VerifyClimbInput, VerifyClimbResult> = {
  name: "verify_climb",
  title: "Verify a climb on the real server",
  description:
    "After the kept changes are applied to the server's code and the server runs them, check that the gain the mock showed holds on the real server. First it reads the server's listing and names each kept change as applied, missing or different; if any is missing or different it stops there and starts no run, unless `runAnyway`. Then it runs the same cases in the same environments twice, back to back, both through a mock: the server as it is now, and the server with a mock in front that puts the old values back (the baseline measured now). The climb's rule settles the pair and the result says whether the gain holds, per environment, with the gain the mock showed beside it, the baseline then and now, and the commit. A kept change that cannot be put back (a tool the new code removed) means only the server runs, and its numbers are set beside the climb's recorded ones with their age. Run it on a stopped climb; at most three per climb, one at a time, outside the round and credit limits. `dryRun` returns the check and the estimate. THIS LAUNCHES PAID RUNS.",
  readOnly: false,
  risk: "spend",
  permalink: suitePermalink,
  inputSchema: verifyInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project, info } = await resolveClimbProject(context, input.project);
    const targetServerId = input.server ? await resolveServerId(client, project, input.server, signal) : undefined;
    const commit = {
      ...(input.commit ? { sha: input.commit } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
      ...(input.dirty !== undefined ? { dirty: input.dirty } : {}),
    };
    const verified = await client.verifyClimb(
      {
        projectId: project.id,
        climbId: input.climb,
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        ...(input.runAnyway !== undefined ? { runAnyway: input.runAnyway } : {}),
        ...(input.waitSeconds !== undefined ? { waitSeconds: input.waitSeconds } : {}),
        ...(targetServerId ? { targetServerId } : {}),
        ...(input.serverVersion ? { serverVersion: input.serverVersion } : {}),
        ...(Object.keys(commit).length > 0 ? { commit } : {}),
      },
      { signal }
    );
    return { ...verified, project: info };
  },
};
