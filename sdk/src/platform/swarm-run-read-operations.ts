/**
 * The swarm run reads: one swarm run's state and counts, which the swarm run
 * page reads too, and its sessions across every goal run in it.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type {
  PlatformSwarmRun,
  PlatformSwarmRunSession,
} from "./swarm-run-read-types.js";

const swarmRunInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  swarmRun: z
    .string()
    .trim()
    .min(1)
    .describe("Swarm run id: the `swarmRunId` on a goal run."),
});

const getSwarmRunInput = swarmRunInput.extend({
  includeLaunchFailures: z
    .boolean()
    .optional()
    .describe(
      "Also return `launchFailures`: why sessions never ran. Off by default, because it reads every attempt of every goal run; leave it off when polling."
    ),
});

const swarmRunSessionsInput = swarmRunInput.extend({
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Pass the previous response's nextCursor to get the next page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Sessions per page, 1-200. Defaults to 50."),
});

export type GetSwarmRunInput = z.infer<typeof getSwarmRunInput>;
export type ListSwarmRunSessionsInput = z.infer<typeof swarmRunSessionsInput>;

export type GetSwarmRunResult = {
  project: SelectedProjectInfo;
  swarmRun: PlatformSwarmRun;
};

export type ListSwarmRunSessionsResult = {
  project: SelectedProjectInfo;
  items: PlatformSwarmRunSession[];
  nextCursor?: string;
};

export const getSwarmRunOperation: PlatformOperation<
  GetSwarmRunInput,
  GetSwarmRunResult
> = {
  name: "get_swarm_run",
  title: "Get one MCPJam swarm run",
  description:
    "One swarm run: the goal runs launched together under one swarmRunId, with its state, session and grading counts for each goal run and in total, and the launch that started it. Grading continues after the sessions end, so `state` can be final while counts still change: `settled` is true only once the launch has finished and no goal run is waiting for grading. `sessions.errored` counts sessions whose execution broke; graded failures are `grading.failedTrials`, a separate number. With `includeLaunchFailures`, `launchFailures` says why sessions never ran.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    // A swarm run is the run page on the Swarms surface: `/swarms/<swarmRunId>`.
    {
      type: "goal_run",
      id: result.swarmRun.swarmRunId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: getSwarmRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const swarmRun = await client.getSwarmRun(
      {
        projectId: project.id,
        swarmRunId: input.swarmRun,
        ...(input.includeLaunchFailures ? { includeLaunchFailures: true } : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), swarmRun };
  },
};

export const listSwarmRunSessionsOperation: PlatformOperation<
  ListSwarmRunSessionsInput,
  ListSwarmRunSessionsResult
> = {
  name: "list_swarm_run_sessions",
  title: "List the sessions of an MCPJam swarm run",
  description:
    "The chat sessions of one swarm run, goal run by goal run and oldest first, each naming its `goalId` and `runId`, with graded verdicts, check observations, readiness, goal scores and a first-message preview. `verdict` is the graded goal result; `outcome` is execution lifecycle. `nextCursor` is present while sessions remain. Sessions can be added until get_swarm_run reports `settled`; once it has, the pages return every session exactly once. get_chat_session reads a session's transcript by the row's `id`.",
  readOnly: true,
  permalink: derivePermalinks((result, input) => [
    { type: "goal_run", id: input.swarmRun, projectId: result.project?.id },
    ...result.items.map((session) => ({
      type: "chat_session" as const,
      id: session.chatSessionId,
      projectId: session.projectId,
    })),
  ]),
  inputSchema: swarmRunSessionsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listSwarmRunSessions(
      {
        projectId: project.id,
        swarmRunId: input.swarmRun,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  },
};
