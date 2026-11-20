/**
 * What a web client turn takes from the eval run it belongs to.
 *
 * The backend's service acts as a named person, and a scheduled or API run
 * has nobody signed in, so the run's turns act as its owner. A run freezes
 * its web accounts when it starts; its turns rotate across them so no one
 * account carries the whole run, and a frozen account that was removed is
 * skipped, never replaced by one nobody chose.
 */
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import {
  webClientVendorForRuntime,
  type WebClientVendor,
} from "@/shared/web-clients";
import { convexErrorData } from "../../routes/v1/convex-errors.js";
import { logger } from "../../utils/logger.js";

export type WebClientRunContext = {
  /** The run's owner (`testSuiteRun.createdBy`), as the service names them. */
  actor?: { actorUserId: string } | { actorExternalId: string };
  /** The eval or swarm run, not the iteration: its turns rotate across one list. */
  runId: string;
  /** The accounts the run froze at start for its vendor, in order. */
  webAccountIds?: readonly string[];
  /** Tells the run's account pool this account can't serve the run any more. */
  onAccountLost?: (reason: string) => void;
};

/** The run's accounts can't serve this turn: removed, or none left signed in. */
export class WebAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAccountUnavailableError";
  }
}

const evalRunRow = z.object({
  createdBy: z.string().min(1).optional(),
  webAccountsAtRun: z
    .array(z.object({ webAccountId: z.string().min(1), vendor: z.string() }))
    .optional(),
});

/** The context an eval run's row gives a web client's turns. */
export function webClientRunOfEvalRun(args: {
  harness: string | undefined;
  runId: string | null;
  run: unknown;
}): WebClientRunContext | undefined {
  const vendor = webClientVendorForRuntime(args.harness);
  if (!vendor || !args.runId) return undefined;
  const row = evalRunRow.safeParse(args.run);
  if (!row.success) return { runId: args.runId };
  const { createdBy, webAccountsAtRun } = row.data;
  return {
    runId: args.runId,
    ...(createdBy ? { actor: { actorUserId: createdBy } } : {}),
    ...(webAccountsAtRun
      ? {
          webAccountIds: webAccountsAtRun
            .filter((account) => account.vendor === vendor)
            .map((account) => account.webAccountId),
        }
      : {}),
  };
}

/** Each run's next place in its rotation, and the place each iteration took. */
const rotations = new Map<string, { next: number; byIteration: Map<string, number> }>();
const TRACKED_RUNS = 500;

/**
 * The run's accounts in the order this turn tries them. Each iteration
 * starts one account on from the last, and every turn of an iteration keeps
 * the iteration's place, so a conversation stays on one account.
 */
export function rotateRunAccounts(args: {
  runId: string;
  iterationId?: string;
  webAccountIds: readonly string[];
}): string[] {
  const ids = args.webAccountIds;
  if (ids.length < 2) return [...ids];
  const rotation = rotations.get(args.runId) ?? { next: 0, byIteration: new Map<string, number>() };
  rotations.delete(args.runId);
  rotations.set(args.runId, rotation);
  if (rotations.size > TRACKED_RUNS) {
    const oldest = rotations.keys().next();
    if (!oldest.done) rotations.delete(oldest.value);
  }
  let place = args.iterationId === undefined ? undefined : rotation.byIteration.get(args.iterationId);
  if (place === undefined) {
    place = rotation.next;
    rotation.next += 1;
    if (args.iterationId !== undefined) rotation.byIteration.set(args.iterationId, place);
  }
  const start = place % ids.length;
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * Freezes the accounts a web client's eval run uses, before any turn. The
 * backend's refusal (web clients off for the project, no access) is the
 * run's reason to stop, in the backend's words.
 */
export async function recordEvalRunWebAccounts(args: {
  convexClient: Pick<ConvexHttpClient, "mutation">;
  runId: string;
  vendor: WebClientVendor;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await args.convexClient.mutation(
      "webClientSuites:recordWebAccountsAtRun" as never,
      { runId: args.runId, vendor: args.vendor } as never,
    );
    return { ok: true };
  } catch (error) {
    const message = convexErrorData(error)?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, reason: message };
    }
    logger.warn("[web-clients] recording the run's web accounts failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: "This run's web accounts couldn't be recorded, so it stopped before any turn. Run it again.",
    };
  }
}
