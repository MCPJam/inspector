/**
 * Which local harnesses one journey launch runs on this machine, and as whom.
 *
 * A launch inside its request resolves this with the request's bearer. A
 * swarm launch creates most of its runs after its reply, with a background
 * bearer, and resolving the actor verifies a session token, which that bearer
 * is not. So a swarm launch resolves the member's eligible harnesses and actor
 * once, while its request is live, and hands them to each launch.
 */
import {
  resolveLocalHarnessActor,
  type LocalHarnessActor,
} from "../../utils/harness/local/acting-user.js";
import { ensureLocalHarnessTarget } from "../../utils/harness/local/readiness.js";
import { eligibleUnattendedLocalHarnesses } from "../../utils/harness/local/run-resources.js";
import type { SupportedLocalHarnessId } from "../../utils/harness/local/targets.js";

/** The local harnesses a member may run unattended here, and as whom. */
export interface LaunchLocalHarness {
  /** Every eligible harness; each launch narrows it to its targets' harnesses. */
  eligibleHarnessIds: SupportedLocalHarnessId[];
  actor?: LocalHarnessActor;
}

function authorizationHeaderOf(bearer: string): string {
  return `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`;
}

/** Resolve {@link LaunchLocalHarness} with a request's own session bearer. */
export async function resolveLaunchLocalHarness(
  bearer: string,
  projectId: string,
): Promise<LaunchLocalHarness> {
  const eligibleHarnessIds = await eligibleUnattendedLocalHarnesses(
    bearer,
    projectId,
  );
  if (eligibleHarnessIds.length === 0) return { eligibleHarnessIds };
  const resolved = await resolveLocalHarnessActor({
    authorizationHeader: authorizationHeaderOf(bearer),
    contextCredential: null,
  });
  return resolved.ok
    ? { eligibleHarnessIds, actor: resolved.actor }
    : { eligibleHarnessIds };
}

/**
 * The harnesses one launch runs locally, readied, and the member they act as.
 * Per harness, unattended (a swarm runs with nobody to approve anything):
 * machine, sandbox evidence, rollout and authorization. The launch declares
 * exactly these to the backend, and its runner executes exactly these locally.
 */
export async function localHarnessForLaunch(args: {
  bearer: string;
  projectId: string;
  /** The harnesses the launch's targets use. */
  harnesses: Array<string | undefined>;
  preResolved?: LaunchLocalHarness;
}): Promise<{
  localHarnessIds: SupportedLocalHarnessId[];
  actor?: LocalHarnessActor;
}> {
  const { bearer, projectId, harnesses, preResolved } = args;
  const localHarnessIds = preResolved
    ? preResolved.eligibleHarnessIds.filter((id) => harnesses.includes(id))
    : await eligibleUnattendedLocalHarnesses(bearer, projectId, harnesses);
  for (const harnessId of localHarnessIds) {
    await ensureLocalHarnessTarget({
      bearer,
      projectId,
      scope: "attended",
      waitForInstall: false,
      harnessId,
      ...(preResolved?.actor ? { trustedActor: preResolved.actor } : {}),
    });
  }
  if (localHarnessIds.length === 0) return { localHarnessIds };
  if (preResolved) {
    return {
      localHarnessIds,
      ...(preResolved.actor ? { actor: preResolved.actor } : {}),
    };
  }
  const resolved = await resolveLocalHarnessActor({
    authorizationHeader: authorizationHeaderOf(bearer),
    contextCredential: null,
  });
  return { localHarnessIds, ...(resolved.ok ? { actor: resolved.actor } : {}) };
}
