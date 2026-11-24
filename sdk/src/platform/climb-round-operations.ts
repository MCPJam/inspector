/**
 * The climb operations around a round: submit a saved server as a round, read
 * or wait for its result, overrule it, and stop the climb. A round measures one
 * server (usually a mock with one change) against the best so far in every
 * environment of the climb, on the steering and validation cases only. The
 * backend settles it with the keep rule; these operations show what it settled
 * and never recompute it.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import { suitePermalink } from "./climb-operations.js";
import {
  climbInput,
  projectInput,
  resolveClimbProject,
  resolveServerId,
  text,
  type WithProject,
} from "./climb-support.js";
import type {
  PlatformClimbContinued,
  PlatformClimbDecision,
  PlatformClimbRoundRead,
  PlatformClimbRoundSubmitted,
  PlatformClimbStopped,
} from "./climb-types.js";

/** The longest a read of a round may hold the call: surfaces end a call that sits much longer. */
export const MAX_ROUND_WAIT_SECONDS = 50;

const roundNumber = z.number().int().min(1).describe("The round's number, as `get_climb` lists it.");

const submitInput = z.object({
  project: projectInput,
  climb: climbInput,
  server: text.describe(
    "The saved server to measure as this round, by name or ID: a mock you made with `create_mock_server`, or the best so far submitted unchanged."
  ),
  serverVersion: text.optional().describe("The mock version this round runs. Omit for the version you just saved: the round records it, and a later edit to the mock does not change it."),
  idempotencyKey: text.max(256).optional().describe("Retry handle. A repeat with the same key returns the same round and charges nothing."),
});

export type SubmitClimbRoundInput = z.infer<typeof submitInput>;
export type SubmitClimbRoundResult = WithProject<PlatformClimbRoundSubmitted>;

export const submitClimbRoundOperation: PlatformOperation<SubmitClimbRoundInput, SubmitClimbRoundResult> = {
  name: "submit_climb_round",
  title: "Submit a climb round",
  description:
    "Submit a saved server as the next round of a climb. The server can be a mock or any saved server of the project; a code round's change is that server's code, such as a saved server that runs your branch. Once a code round is kept, its server is the best so far, so leave its code as it is and run the next code change on another saved server (a later round on the same server would be measured against itself). It runs the steering and validation cases in every environment of the climb, with this server replacing the climbed one, and the best so far is measured again in the same round when its numbers are old or the suite changed (the answer says so). Returns at once with the estimate and the runs; read `get_climb_round` for the result. Refused, with what is needed and what is left, past the round limit or the credit limit, while a round runs, when the real server's listing cannot be compared, and on a climb for pass rate whose steering cases all pass. One round runs at a time. THIS LAUNCHES PAID RUNS.",
  readOnly: false,
  risk: "spend",
  permalink: suitePermalink,
  inputSchema: submitInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project, info } = await resolveClimbProject(context, input.project);
    const serverId = await resolveServerId(client, project, input.server, signal);
    const submitted = await client.submitClimbRound(
      {
        projectId: project.id,
        climbId: input.climb,
        serverId,
        ...(input.serverVersion ? { serverVersion: input.serverVersion } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
      { signal }
    );
    return { ...submitted, project: info };
  },
};

const getRoundInput = z.object({
  project: projectInput,
  climb: climbInput,
  round: roundNumber,
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_ROUND_WAIT_SECONDS)
    .optional()
    .describe(`Hold the call until the round settles, for at most this many seconds (up to ${MAX_ROUND_WAIT_SECONDS}). Omit to read it now. \`settled\` says whether it did.`),
});

export type GetClimbRoundInput = z.infer<typeof getRoundInput>;
export type GetClimbRoundResult = WithProject<PlatformClimbRoundRead>;

export const getClimbRoundOperation: PlatformOperation<GetClimbRoundInput, GetClimbRoundResult> = {
  name: "get_climb_round",
  title: "Get a climb round",
  description:
    "Read one round: its verdict (kept, reverted or not decided) and why, who submitted it, and for each environment the pass rate and the climb's measure against the best so far, with the noise they are judged against. Validation is totals per environment and never names a case; a reverted round names a steering case that failed and says only that validation regressed. With `waitSeconds` the call holds until the round settles or the bound passes: if `settled` is false, call it again.",
  readOnly: true,
  permalink: suitePermalink,
  inputSchema: getRoundInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const round = await context.client.getClimbRound(
      { projectId: project.id, climbId: input.climb, roundNumber: input.round, waitSeconds: input.waitSeconds },
      { signal: context.signal }
    );
    return { ...round, project: info };
  },
};

const decisionInput = z.object({
  project: projectInput,
  climb: climbInput,
  round: roundNumber,
  decision: z.enum(["kept", "reverted"]).describe("What the round should stand as."),
  reason: text.max(500).describe("Why you are overruling the rule. It is recorded with your name."),
});

export type SetClimbRoundDecisionInput = z.infer<typeof decisionInput>;
export type SetClimbRoundDecisionResult = WithProject<PlatformClimbDecision>;

export const setClimbRoundDecisionOperation: PlatformOperation<SetClimbRoundDecisionInput, SetClimbRoundDecisionResult> = {
  name: "set_climb_round_decision",
  title: "Overrule a climb round",
  description:
    "Overrule a settled round, a not-decided one included, with a reason. The round then stands as you decided and the record keeps who overruled it and why; the best so far becomes the latest round that stands as kept, else the baseline. Refused while a round or a confirmation runs, and once the confirmation has run.",
  readOnly: false,
  risk: "none",
  permalink: suitePermalink,
  inputSchema: decisionInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const result = await context.client.setClimbRoundDecision(
      { projectId: project.id, climbId: input.climb, roundNumber: input.round, decision: input.decision, reason: input.reason },
      { signal: context.signal }
    );
    return { ...result, project: info };
  },
};

const stopInput = z.object({ project: projectInput, climb: climbInput });

export type StopClimbInput = z.infer<typeof stopInput>;
export type StopClimbResult = WithProject<PlatformClimbStopped>;

export const stopClimbOperation: PlatformOperation<StopClimbInput, StopClimbResult> = {
  name: "stop_climb",
  title: "Stop a climb",
  description:
    "Stop a climb for good: no more rounds, and a round or baseline in flight is failed and its runs cancelled. Returns where it ended, the best server so far, the rounds that stand as kept in order, and `prompt`: the kept changes, those that also helped on validation cases first, with each old and new value, for the coding agent that works on the server\'s code. Calling it again changes nothing. A stopped climb can still be confirmed once and verified.",
  readOnly: false,
  risk: "destructive",
  permalink: suitePermalink,
  inputSchema: stopInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const stopped = await context.client.stopClimb({ projectId: project.id, climbId: input.climb }, { signal: context.signal });
    return { ...stopped, project: info };
  },
};

const continueInput = z.object({ project: projectInput, climb: climbInput });

export type ContinueClimbInput = z.infer<typeof continueInput>;
export type ContinueClimbResult = WithProject<PlatformClimbContinued>;

export const continueClimbOperation: PlatformOperation<ContinueClimbInput, ContinueClimbResult> = {
  name: "continue_climb",
  title: "Continue a paused climb or run a failed baseline again",
  description:
    "Resume a climb MCPJam picks for after it paused: a step that failed three times, a turn that twice submitted no round, an Inspector that stopped, the person who started the climb having no sign-in to act as, or the `climbs` feature being off at the time. Read `get_climb`: `paused` says why and what to fix first. This clears the pause and makes the next step due now, or when the round in flight settles, with fresh attempts. A pause is never a failure and never changes `state`. Refused when the climb is not paused or has stopped. The steps spend credits within the climb's own limits. Also runs the baseline again when it failed: `get_climb` shows `baselineFailure` (the climb stays `baselining` with no unit running, and `reason` names the environment that lost iterations), and this registers and launches a new attempt (answers `baselineStarted: true` and its `launch`). Refused when the climb has a baseline or one is running.",
  readOnly: false,
  risk: "spend",
  permalink: suitePermalink,
  inputSchema: continueInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const continued = await context.client.continueClimb({ projectId: project.id, climbId: input.climb }, { signal: context.signal });
    return { ...continued, project: info };
  },
};
