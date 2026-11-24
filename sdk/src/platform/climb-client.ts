/**
 * The climb methods of `PlatformApiClient`, kept out of `client.ts` like the
 * mock methods they follow: `PlatformApiClient` extends this class and
 * implements `request`, so these use the client's own auth, headers, deadline
 * and error mapping.
 */
import { MockServerClient } from "./mock-client.js";
import type {
  PlatformClimb,
  PlatformClimbListItem,
  PlatformClimbMeasure,
  PlatformClimbStarted,
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
}
