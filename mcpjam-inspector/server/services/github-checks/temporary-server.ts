/**
 * The check's temporary `gh-check-<triggerId>` server, made and removed by the
 * backend (`POST /internal/v1/github-checks/temporary-server` and `.../delete`)
 * so the worker needs no user token for it.
 *
 * Both calls prove the claim with its lease token. The backend takes every
 * setting of the row from the trigger record and accepts only what the worker
 * alone knows: the sandbox's address and whether that server asked for
 * authorization. Creating the server also records it on the trigger, so
 * recovery can remove it if this worker dies, and completion removes it too.
 */
import {
  GITHUB_CHECKS_SERVICE_BASE,
  postServiceRoute,
} from "./service-route.js";

/** What proves this worker holds the claim; `claimedBy` alone is guessable. */
export type CheckLease = {
  triggerId: string;
  claimedBy: string;
  leaseToken: string;
};

/** The backend refused the call; `reason` is its error code. */
export class TemporaryServerRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`temporary server refused (${status}): ${reason}`);
  }
}

function refusal(status: number, body: unknown): TemporaryServerRefusedError {
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  return new TemporaryServerRefusedError(
    status,
    typeof error === "string" ? error : "unknown",
  );
}

export async function createTemporaryServer(
  args: CheckLease & { url: string; authorizationRequired: boolean },
): Promise<{ serverId: string; serverName: string }> {
  const { status, body } = await postServiceRoute(
    `${GITHUB_CHECKS_SERVICE_BASE}/temporary-server`,
    args,
  );
  if (
    status !== 200 ||
    body?.ok !== true ||
    typeof body.serverId !== "string" ||
    typeof body.serverName !== "string"
  )
    throw refusal(status, body);
  return { serverId: body.serverId, serverName: body.serverName };
}

/**
 * Removes the server the backend recorded for this check. Called after the
 * check is complete, which the backend accepts from the lease holder; by then
 * completion has usually removed it, and this answers `deleted: false`.
 */
export async function deleteTemporaryServer(
  lease: CheckLease,
): Promise<{ deleted: boolean }> {
  const { status, body } = await postServiceRoute(
    `${GITHUB_CHECKS_SERVICE_BASE}/temporary-server/delete`,
    lease,
  );
  if (status !== 200 || body?.ok !== true) throw refusal(status, body);
  return { deleted: body.deleted === true };
}
