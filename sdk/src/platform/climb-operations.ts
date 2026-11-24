/**
 * The climb operations that start and read a climb: `start_climb`,
 * `update_climb`, `get_climb`, `list_climbs`. Rounds, the end of a climb and the
 * verification are in `climb-round-operations.ts` and `climb-finish-operations.ts`.
 *
 * A climb repeats rounds on an eval suite, in the suite's environments, with
 * one server of each environment replaced by a mock. The backend keeps the
 * climb and settles every number; the route launches the runs, because opening
 * the real server and building a mock need Node-only code. All of it is behind
 * the `climbs` feature: with the flag off each operation answers
 * `FEATURE_UNAVAILABLE`.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import { derivePermalinks } from "./permalinks.js";
import {
  climbInput,
  measureInput,
  percentToBps,
  projectInput,
  resolveClimbProject,
  resolveEnvironmentIds,
  resolveServerId,
  resolveSuiteId,
  text,
  type WithProject,
} from "./climb-support.js";
import type { PlatformClimb, PlatformClimbListItem, PlatformClimbStarted } from "./climb-types.js";
import { operationInputError } from "./resource-selectors.js";
import type { PlatformPage } from "./types.js";

const sizes = z
  .object({ steering: z.number().int().min(0).optional(), validation: z.number().int().min(0).optional(), confirmation: z.number().int().min(0).optional() })
  .strict();
const lists = z
  .object({ steering: z.array(text).optional(), validation: z.array(text).optional(), confirmation: z.array(text).optional() })
  .strict();

const startInput = z
  .object({
    project: projectInput,
    suite: text.describe("The eval suite to climb, by name or ID. It needs environments attached."),
    server: text.describe("The saved server to improve, by name or ID. Every selected environment must include it."),
    roundLimit: z.number().int().min(1).max(100).describe("The most rounds the climb may start. Required: a climb has no default."),
    creditLimit: z.number().positive().describe("The most credits the climb may commit, checked on estimates. Required: a climb has no default."),
    environments: z
      .array(text)
      .min(1)
      .max(10)
      .optional()
      .describe("The suite's environments to climb in, by name or ID. Omit for every environment the suite has, up to 10."),
    picker: z
      .enum(["person", "agent", "mcpjam"])
      .optional()
      .describe("Who picks each change. Defaults to `agent`: your own agent submits rounds with `submit_climb_round`. `mcpjam`: MCPJam picks each change with the model in `pickerModel`, one step at a time, and pauses when a step cannot finish (`continue_climb` resumes it)."),
    pickerModel: text.max(200).optional().describe("The model MCPJam picks with, as a model id. Required with `picker: mcpjam`, refused with any other picker."),
    measure: measureInput.optional().describe("What the climb tries to improve: pass_rate (default), tokens, cost or tool_calls. Fixed once round 1 settles."),
    minImprovementPercent: z.number().min(0.01).max(100).optional().describe("The smallest move of tokens, cost or tool calls that counts, in percent. Default 1."),
    targetPercent: z.number().gt(0).lt(100).optional().describe("For tokens, cost or tool calls: stop when the best so far uses this percent less than the baseline, in every environment that recorded the measure. 5 is 5% fewer."),
    groupSizes: sizes.optional().describe("How many cases go in each group. Give this or `groups`."),
    groups: lists.optional().describe("The case keys in each group (a case without a key is its ID). Give this or `groupSizes`. A case not listed joins steering."),
    seed: z
      .union([text.max(100), z.number().int().safe().transform(String)])
      .optional()
      .describe("Seeds the random split of the cases, so the same split can be made again."),
  })
  .refine((input) => !(input.groupSizes && input.groups), {
    message: "Give groupSizes or groups, not both.",
  })
  .refine((input) => (input.picker === "mcpjam") === (input.pickerModel !== undefined), {
    message: "Give pickerModel with picker mcpjam, and only then.",
    path: ["pickerModel"],
  });

export type StartClimbInput = z.infer<typeof startInput>;
export type StartClimbResult = WithProject<PlatformClimbStarted>;

/** Every climb result names its suite: that is the page a climb is seen from until it has its own. */
export const suitePermalink = derivePermalinks((result: { suiteId: string; project?: { id: string } }) => [
  { type: "eval_suite" as const, id: result.suiteId, projectId: result.project?.id },
]);

export const startClimbOperation: PlatformOperation<StartClimbInput, StartClimbResult> = {
  name: "start_climb",
  title: "Start a climb",
  description:
    "Improve a saved MCP server against one of its eval suites: try each change on a mock (a description, a title, a hidden tool or parameter, an answer) or on a saved server that runs your branch (a code change), and keep it only if it beats a baseline measured for noise. The climbed server keeps running its current code for the whole climb, because the baseline and the best so far are measured on it. A climb runs one round at a time; when it stops, `stop_climb` gives a prompt that applies the kept changes to the code (and keeps the code a kept code round ran), and `verify_climb` checks them on the real server. The suite's cases are split into steering cases (a climb learns from them), validation cases (every round runs them and a change that breaks them is reverted; you get totals, never their transcripts) and confirmation cases (no round runs them; `confirm_climb` runs them once at the end). The baseline runs twice, through a mock with no changes, in every selected environment; this call launches it and returns at once with the estimate. Read `get_climb` until its state is `ready`: it then holds the noise per environment, the suite check and the things you can climb for, each with the failed runs behind it. `roundLimit` and `creditLimit` are required and bound everything that follows. THIS LAUNCHES PAID RUNS.",
  readOnly: false,
  risk: "spend",
  permalink: suitePermalink,
  inputSchema: startInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project, info } = await resolveClimbProject(context, input.project);
    const suiteId = await resolveSuiteId(client, project, input.suite, signal);
    const serverId = await resolveServerId(client, project, input.server, signal);
    const environmentIds = input.environments
      ? await resolveEnvironmentIds(client, project, input.environments, signal)
      : undefined;
    const started = await client.startClimb(
      {
        projectId: project.id,
        suiteId,
        serverId,
        roundLimit: input.roundLimit,
        creditLimit: input.creditLimit,
        ...(environmentIds ? { environmentIds } : {}),
        ...(input.picker ? { picker: input.picker } : {}),
        ...(input.pickerModel ? { pickerModel: input.pickerModel } : {}),
        ...(input.measure ? { measure: input.measure } : {}),
        ...(input.minImprovementPercent !== undefined
          ? { minImprovementBps: percentToBps(input.minImprovementPercent) }
          : {}),
        ...(input.targetPercent !== undefined ? { targetBps: percentToBps(input.targetPercent) } : {}),
        ...(input.groupSizes ? { groupSizes: input.groupSizes } : {}),
        ...(input.groups ? { groupLists: input.groups } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      },
      { signal }
    );
    return { ...started, project: info };
  },
};

const updateInput = z.object({
  project: projectInput,
  climb: climbInput,
  measure: measureInput.optional().describe("Change what the climb is for. Only until round 1 settles, and only to a measure every environment recorded."),
  minImprovementPercent: z.number().min(0.01).max(100).optional().describe("The smallest move of tokens, cost or tool calls that counts, in percent."),
  targetPercent: z.number().gt(0).lt(100).nullable().optional().describe("The target for tokens, cost or tool calls, in percent fewer. null clears it."),
  moveToConfirmation: z.array(text).min(1).optional().describe("Case keys to set aside as confirmation cases. Only a case no round has run."),
});

export type UpdateClimbInput = z.infer<typeof updateInput>;
export type UpdateClimbResult = WithProject<PlatformClimb>;

export const updateClimbOperation: PlatformOperation<UpdateClimbInput, UpdateClimbResult> = {
  name: "update_climb",
  title: "Update a climb",
  description:
    "Change what a climb is for (`measure`), the smallest improvement that counts or its target, until round 1 settles, or set cases aside as confirmation cases while no round has run them. Refused while a round runs, on a stopped climb, and for a measure no environment recorded (the refusal says which). A case added to the suite later joins steering unless you move it here.",
  readOnly: false,
  risk: "none",
  permalink: suitePermalink,
  inputSchema: updateInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const { measure, minImprovementPercent, targetPercent, moveToConfirmation } = input;
    if (
      measure === undefined &&
      minImprovementPercent === undefined &&
      targetPercent === undefined &&
      moveToConfirmation === undefined
    ) {
      throw operationInputError(
        "Nothing to change. Give measure, minImprovementPercent, targetPercent or moveToConfirmation."
      );
    }
    const updated = await context.client.updateClimb(
      {
        projectId: project.id,
        climbId: input.climb,
        ...(measure ? { measure } : {}),
        ...(minImprovementPercent !== undefined ? { minImprovementBps: percentToBps(minImprovementPercent) } : {}),
        ...(targetPercent !== undefined ? { targetBps: targetPercent === null ? null : percentToBps(targetPercent) } : {}),
        ...(moveToConfirmation ? { moveToConfirmation } : {}),
      },
      { signal: context.signal }
    );
    return { ...updated, project: info };
  },
};

const getInput = z.object({ project: projectInput, climb: climbInput });

export type GetClimbInput = z.infer<typeof getInput>;
export type GetClimbResult = WithProject<PlatformClimb>;

export const getClimbOperation: PlatformOperation<GetClimbInput, GetClimbResult> = {
  name: "get_climb",
  title: "Get a climb",
  description:
    "Read a climb: its state, limits and credits left, the cases in each group (steering cases by key, validation as counts), the baseline's noise per environment, every round with who submitted it, and the best server so far. Once the baseline has settled it also returns `suiteCheck` (whether the suite can show a change: noise, the smallest change per measure, cases that flipped between the two runs, environments with no room to improve, tools no validation case covers), `climbFor` (the things to climb for, each with its measure, a number counted on steering cases and up to three failed runs with a reason and a link) and `whatCanChange` (everything a mock can change on this server, ranked, with the current value, which clients read it, the failed runs that point at it and what was tried). Validation results are totals and never carry a case. Poll this after `start_climb` until the state is `ready`.",
  readOnly: true,
  permalink: suitePermalink,
  inputSchema: getInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const climb = await context.client.getClimb(
      { projectId: project.id, climbId: input.climb },
      { signal: context.signal }
    );
    return { ...climb, project: info };
  },
};

const listInput = z.object({
  project: projectInput,
  suite: text.optional().describe("Only the climbs of this suite, by name or ID."),
  limit: z.number().int().min(1).max(100).optional(),
});

export type ListClimbsInput = z.infer<typeof listInput>;
export type ListClimbsResult = WithProject<PlatformPage<PlatformClimbListItem>>;

export const listClimbsOperation: PlatformOperation<ListClimbsInput, ListClimbsResult> = {
  name: "list_climbs",
  title: "List climbs",
  description: "List a project's climbs, newest first: the suite, the server, the state and the rounds used.",
  readOnly: true,
  permalink: derivePermalinks((result: ListClimbsResult) =>
    result.items.slice(0, 1).map((item) => ({
      type: "eval_suite" as const,
      id: item.suiteId,
      projectId: result.project?.id,
    }))
  ),
  inputSchema: listInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project, info } = await resolveClimbProject(context, input.project);
    const suiteId = input.suite ? await resolveSuiteId(client, project, input.suite, signal) : undefined;
    const page = await client.listClimbs({ projectId: project.id, suiteId, limit: input.limit }, { signal });
    return { ...page, project: info };
  },
};
