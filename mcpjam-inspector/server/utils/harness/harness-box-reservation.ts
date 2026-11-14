/**
 * The per-box claim that fences work in a box before a lease covers it: a
 * turn's preparation, the whole of an external-account turn (it has no
 * lease), and a new chat's box preparation (`prepare-conversation-box.ts`).
 */
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { inspectorAiRequestHeaders } from "../ai-request-headers.js";
import { logger } from "../logger.js";
import { bearerHeader, getConvexHttpUrl } from "./harness-broker-http.js";
import {
  boxRequestFields,
  harnessRuntimeVersionField,
  numberField,
  type HarnessBrokerBox,
} from "./harness-model-broker.js";
import { leaseSelectionField } from "./harness-org-lease.js";
import type { HarnessId } from "./registry.js";

export type HarnessBoxReservationResult =
  | {
      ok: true;
      expiresAt?: number;
      /** What is left of the claim, relative: count it from the request's send. */
      ttlMs?: number;
      /** An org selection's hashed credential revision; the start refuses a newer key. */
      credentialRevision?: string;
    }
  | { ok: false; status: number; error: string; code?: string; reservationExpiresAt?: number };

/**
 * How a box preparation ended, for its release: `clean` when every call it
 * made in the box returned, or none started; `uncertain` when one may still
 * reach the box.
 */
export type BoxReleaseOutcome = "clean" | "uncertain";

/**
 * Claim a box for a turn's PREPARATION (waking it, installing the runtime),
 * which runs before the lease and its per-box fence exist; the lease consumes
 * the claim (by `runId`). A missing endpoint fails hard: going on without a
 * claim would reopen the race it closes, so roll out the backend first.
 */
export async function reserveHarnessBox(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  /** See `startHarnessModelBroker`: an org selection is checked here first. */
  modelSelection?: ModelSelection | null;
  purpose?: "prepare";
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessBoxReservationResult> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve",
      getConvexHttpUrl()
    ).toString();
  } catch (err) {
    logger.error("[harness-model-broker] missing reserve endpoint config", err);
    return {
      ok: false,
      status: 500,
      error: "Harness model-broker endpoint is not configured",
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...inspectorAiRequestHeaders("harness"),
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({
        ...boxRequestFields(args.box),
        ...(args.purpose ? { purpose: args.purpose } : {}),
        // The harness + model the lease will name, authorized as a lease is:
        // for an ephemeral box, against what the run actually pinned.
        harnessId: args.harnessId,
        ...harnessRuntimeVersionField(args.harnessId),
        modelId: args.modelId,
        runId: args.runId,
        // An org selection is resolved HERE: a bad connection fails pre-install.
        ...leaseSelectionField(args.modelSelection),
      }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[harness-model-broker] reserve network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    };
  }

  const payload: any = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      // A 2xx whose body can't be read may still have made the claim.
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Couldn't reserve the computer (${response.status})`,
      ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
      ...numberField(payload, "reservationExpiresAt"),
    };
  }
  return {
    ok: true,
    ...numberField(payload, "expiresAt"),
    ...numberField(payload, "ttlMs"),
    ...(args.modelSelection?.source === "org" &&
    typeof payload.credentialRevision === "string"
      ? { credentialRevision: payload.credentialRevision }
      : {}),
  };
}

/** Renew the preparation claim before its crash-recovery TTL elapses. */
export async function renewHarnessBoxReservation(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; expiresAt?: number; ttlMs?: number }> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve/renew",
      getConvexHttpUrl()
    ).toString();
  } catch {
    return { ok: false };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...inspectorAiRequestHeaders("harness"),
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({
        ...boxRequestFields(args.box),
        harnessId: args.harnessId,
        modelId: args.modelId,
        runId: args.runId,
      }),
      signal: args.signal,
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      logger.error(
        `[harness-model-broker] reservation renewal returned ${response.status}`
      );
      return { ok: false };
    }
    return {
      ok: true,
      ...numberField(payload, "expiresAt"),
      ...numberField(payload, "ttlMs"),
    };
  } catch (err) {
    logger.error(
      "[harness-model-broker] reservation renewal network error",
      err
    );
    return { ok: false };
  }
}

/**
 * Hand a claimed box back. Best-effort: for a turn's claim the TTL is the real
 * guarantee, and a turn that dies without releasing must not wedge the box for
 * longer than that. A box preparation's claim also says how it ended: only
 * `clean` leaves the box for a Send. `uncertain`, no outcome, or a claim left
 * to lapse retires the box, and no turn runs on it again.
 */
export async function releaseHarnessBoxReservation(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  /** A box preparation's own; a turn's release sends none. */
  outcome?: BoxReleaseOutcome;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean }> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve/release",
      getConvexHttpUrl()
    ).toString();
  } catch {
    return { ok: false };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...inspectorAiRequestHeaders("harness"),
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({
        ...boxRequestFields(args.box),
        harnessId: args.harnessId,
        modelId: args.modelId,
        runId: args.runId,
        ...(args.outcome ? { outcome: args.outcome } : {}),
      }),
      signal: args.signal,
    });
    if (!response.ok) {
      logger.warn(
        `[harness-model-broker] reservation release returned ${response.status}`
      );
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    logger.error("[harness-model-broker] reservation release network error", err);
    return { ok: false };
  }
}
