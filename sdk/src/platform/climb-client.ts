/**
 * The climb methods of `PlatformApiClient`, kept out of `client.ts` like the
 * mock methods they follow: `PlatformApiClient` extends this class and
 * implements `request`, so these use the client's own auth, headers, deadline
 * and error mapping.
 */
import { MockServerClient } from "./mock-client.js";
import type {
  PlatformClimb,
  PlatformClimbConfirmed,
  PlatformClimbListItem,
  PlatformClimbMeasure,
  PlatformClimbVerified,
  PlatformClimbDecision,
  PlatformClimbRoundRead,
  PlatformClimbRoundSubmitted,
  PlatformClimbStarted,
  PlatformClimbStopped,
  PlatformClimbVerdict,
} from "./climb-types.js";
import type { PlatformPage } from "./types.js";

type Options = { signal?: AbortSignal };
type Group = { steering?: number; validation?: number; confirmation?: number };
type Keys = { steering?: string[]; validation?: string[]; confirmation?: string[] };

const climbsPath = (projectId: string, tail = "") =>
  `/projects/${encodeURIComponent(projectId)}/climbs${tail}`;
const climbPath = (projectId: string, climbId: string, tail = "") =>
  climbsPath(projectId, `/${encodeURIComponent(climbId)}${tail}`);

export abstract class ClimbClient extends MockServerClient {
  /** Starts a climb and launches its baseline: two run groups through a mock with no changes. */
  startClimb(
    params: {
      projectId: string;
      suiteId: string;
      serverId: string;
      roundLimit: number;
      creditLimit: number;
      environmentIds?: string[];
      picker?: "person" | "agent";
      measure?: PlatformClimbMeasure;
      minImprovementBps?: number;
      targetBps?: number;
      groupSizes?: Group;
      groupLists?: Keys;
      seed?: number;
    },
    options?: Options
  ): Promise<PlatformClimbStarted> {
    const { projectId, ...body } = params;
    return this.request("POST", climbsPath(projectId), { body, declareLaunch: true }, options);
  }

  /** Changes "Climb for", the smallest improvement or the target (`null` clears it) until round 1 settles. */
  updateClimb(
    params: {
      projectId: string;
      climbId: string;
      measure?: PlatformClimbMeasure;
      minImprovementBps?: number;
      targetBps?: number | null;
      moveToConfirmation?: string[];
    },
    options?: Options
  ): Promise<PlatformClimb> {
    const { projectId, climbId, ...body } = params;
    return this.request("PATCH", climbPath(projectId, climbId), { body }, options);
  }

  getClimb(params: { projectId: string; climbId: string }, options?: Options): Promise<PlatformClimb> {
    return this.request("GET", climbPath(params.projectId, params.climbId), {}, options);
  }

  listClimbs(
    params: { projectId: string; suiteId?: string; limit?: number },
    options?: Options
  ): Promise<PlatformPage<PlatformClimbListItem>> {
    const query = { suiteId: params.suiteId, limit: params.limit };
    return this.request("GET", climbsPath(params.projectId), { query }, options);
  }

  /** Registers a round on a saved server and launches it. The idempotency key makes a retry safe. */
  submitClimbRound(
    params: {
      projectId: string;
      climbId: string;
      serverId: string;
      serverVersion?: string;
      idempotencyKey?: string;
    },
    options?: Options
  ): Promise<PlatformClimbRoundSubmitted> {
    const { projectId, climbId, ...body } = params;
    return this.request("POST", climbPath(projectId, climbId, "/rounds"), { body, declareLaunch: true }, options);
  }

  /** One round in full. With `waitSeconds` the call holds until the round settles or the bound passes. */
  getClimbRound(
    params: { projectId: string; climbId: string; roundNumber: number; waitSeconds?: number },
    options?: Options
  ): Promise<PlatformClimbRoundRead> {
    const path = climbPath(params.projectId, params.climbId, `/rounds/${params.roundNumber}`);
    return this.request("GET", path, { query: { wait: params.waitSeconds } }, options);
  }

  /** Overrules a settled round, recording who and why. */
  setClimbRoundDecision(
    params: { projectId: string; climbId: string; roundNumber: number; decision: Exclude<PlatformClimbVerdict, "not_decided">; reason: string },
    options?: Options
  ): Promise<PlatformClimbDecision> {
    const { projectId, climbId, roundNumber, ...body } = params;
    return this.request("POST", climbPath(projectId, climbId, `/rounds/${roundNumber}/decision`), { body }, options);
  }

  /** Stops the climb, cancelling a round in flight. */
  stopClimb(params: { projectId: string; climbId: string }, options?: Options): Promise<PlatformClimbStopped> {
    return this.request("POST", climbPath(params.projectId, params.climbId, "/stop"), {}, options);
  }

  /** Runs the one-time confirmation on the cases no round ran, or with `dryRun` only quotes it. */
  confirmClimb(
    params: { projectId: string; climbId: string; dryRun?: boolean; waitSeconds?: number },
    options?: Options
  ): Promise<PlatformClimbConfirmed> {
    const { projectId, climbId, ...body } = params;
    return this.request("POST", climbPath(projectId, climbId, "/confirmation"), { body, declareLaunch: true }, options);
  }

  /** Checks the server's listing against the kept changes and, if they are in, runs it beside a mock that puts the old values back. */
  verifyClimb(
    params: {
      projectId: string;
      climbId: string;
      dryRun?: boolean;
      runAnyway?: boolean;
      waitSeconds?: number;
      targetServerId?: string;
      serverVersion?: string;
      commit?: { sha?: string; branch?: string; repositoryUrl?: string; dirty?: boolean };
    },
    options?: Options
  ): Promise<PlatformClimbVerified> {
    const { projectId, climbId, ...body } = params;
    return this.request("POST", climbPath(projectId, climbId, "/verifications"), { body, declareLaunch: true }, options);
  }
}
