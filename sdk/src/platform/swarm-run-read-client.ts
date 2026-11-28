/**
 * The swarm run reads of `PlatformApiClient`, kept out of `client.ts` like the
 * mock server methods: the client extends this class and implements `request`.
 */
import { MockServerClient } from "./mock-client.js";
import type {
  PlatformSwarmRun,
  PlatformSwarmRunSession,
} from "./swarm-run-read-types.js";
import type { PlatformPage } from "./types.js";

type Options = { signal?: AbortSignal };
type SwarmRunScope = { projectId: string; swarmRunId: string };

/** `/projects/{p}/swarm-runs/{swarmRunId}`, or a path under it. */
const swarmRunPath = (projectId: string, swarmRunId: string, tail = "") =>
  `/projects/${encodeURIComponent(projectId)}/swarm-runs/${encodeURIComponent(
    swarmRunId
  )}${tail}`;

export abstract class SwarmRunReadClient extends MockServerClient {
  /**
   * One swarm run: its state, counts, goal runs and launch. With
   * `includeLaunchFailures`, also why sessions never ran, which the server
   * reads from every attempt, so leave it off when polling.
   */
  getSwarmRun(
    params: SwarmRunScope & { includeLaunchFailures?: boolean },
    options?: Options
  ): Promise<PlatformSwarmRun> {
    const { projectId, swarmRunId, includeLaunchFailures } = params;
    const include = includeLaunchFailures ? "launchFailures" : undefined;
    const path = swarmRunPath(projectId, swarmRunId);
    return this.request("GET", path, { query: { include } }, options);
  }

  /** One page of the swarm run's sessions, goal run by goal run, oldest first. */
  listSwarmRunSessions(
    params: SwarmRunScope & { cursor?: string; limit?: number },
    options?: Options
  ): Promise<PlatformPage<PlatformSwarmRunSession>> {
    const { projectId, swarmRunId, cursor, limit } = params;
    const path = swarmRunPath(projectId, swarmRunId, "/sessions");
    return this.request("GET", path, { query: { cursor, limit } }, options);
  }
}
