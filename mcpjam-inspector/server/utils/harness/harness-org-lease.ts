/**
 * The organization-key half of the harness model-broker client: what a start
 * request carries for an org selection, what its response must confirm before
 * a turn runs on the org's own provider key, and the model proxy's own refusal
 * read back after a turn failed under such a lease.
 *
 * The key itself never reaches the inspector. Everything here is the
 * non-secret echo the backend's ledger recorded.
 */
import { z } from "zod";
import { logger } from "../logger.js";
import type { HarnessOrgUpstream } from "@/shared/harness-model-support";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  HARNESS_PROXY_REFUSAL_REASONS,
  HARNESS_PROXY_REFUSAL_STATUS,
  isHarnessProxyRefusalReason,
  type HarnessProxyRefusalReason,
} from "@/shared/harness-proxy-refusal-reasons";
import type { InfraFailureEvidence } from "../infra-failure-evidence.js";
import { bearerHeader, getConvexHttpUrl } from "./harness-broker-http.js";

/**
 * The non-secret facts a start response echoes for a lease on the
 * ORGANIZATION'S own provider key — read from what the backend's ledger
 * recorded, so they say what was actually minted rather than what was asked
 * for. `credentialRevision` is a short one-way hash: equal ⇒ the same key.
 */
export type HarnessOrgLeaseUpstream = {
  credentialSource: "org";
  profile: HarnessOrgUpstream["profile"];
  /** The exact native model id the lease admits (`claude-sonnet-4-5`). */
  nativeModelId: string;
  credentialRevision: string;
};

/**
 * The org selection a broker request carries, or nothing. Only a `source:
 * 'org'` selection travels: a hosted request's body carries no selection.
 */
export function orgSelectionField(
  selection: ModelSelection | null | undefined,
): {
  modelSelection?: ModelSelection;
} {
  return selection?.source === "org" ? { modelSelection: selection } : {};
}

/** What a start response echoes for an org lease, checked at the boundary. */
const orgLeaseEchoSchema = z.object({
  credentialSource: z.literal("org"),
  upstreamProfile: z.enum(["anthropic-native", "openai-native"]),
  credentialRevision: z.string().min(1),
  // A native id never carries the canonical `creator/` prefix.
  upstreamModelId: z
    .string()
    .min(1)
    .refine((id) => !id.includes("/")),
});

/** The org facts of a start response, or null when absent or incomplete. */
export function orgLeaseUpstreamFrom(
  payload: unknown,
): HarnessOrgLeaseUpstream | null {
  const parsed = orgLeaseEchoSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    credentialSource: "org",
    profile: parsed.data.upstreamProfile,
    nativeModelId: parsed.data.upstreamModelId,
    credentialRevision: parsed.data.credentialRevision,
  };
}

/**
 * Error code for a start that was ASKED for an org-key lease and came back
 * without confirming one: a backend that ignored the selection minted a lease
 * on MCPJam's key. The lease is revoked and the turn fails before the runtime
 * starts: an org binding is never assumed.
 */
export const ORG_BINDING_UNCONFIRMED = "org_binding_unconfirmed";

/** The failed start both broker paths answer after revoking such a lease. */
export function orgBindingUnconfirmed(): {
  ok: false;
  status: number;
  error: string;
  code: string;
} {
  return {
    ok: false,
    status: 502,
    error:
      "The model broker did not confirm a lease on the organization's key; the turn was not started.",
    code: ORG_BINDING_UNCONFIRMED,
  };
}

/** The refusal read-back's answer, checked at the boundary. */
const leaseRefusalSchema = z.object({
  ok: z.literal(true),
  refusal: z.object({ reason: z.string(), at: z.number() }),
});

/**
 * The model proxy's own most recent refusal on the caller's leases for
 * `runId` — its `x-mcpjam-proxy-refusal` reason, which the backend records on
 * the lease — or undefined. The runtime in the sandbox surfaces only the
 * refusal's status, so a failed turn reads the reason back here to classify
 * what failed. Never throws: an unreachable endpoint leaves the failure
 * unclassified, the safe direction.
 */
export async function readHarnessLeaseRefusal(args: {
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ reason: string; at: number } | undefined> {
  try {
    const url = new URL(
      "/web/harness/model-broker/refusal",
      getConvexHttpUrl(),
    ).toString();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({ runId: args.runId }),
      signal: args.signal
        ? AbortSignal.any([args.signal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const parsed = leaseRefusalSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.refusal : undefined;
  } catch (err) {
    logger.warn("[harness-model-broker] refusal lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * The model proxy's own refusal reason for a failed turn, or undefined.
 *
 * Asked only when the failure could BE one: a model call was made under a
 * lease, and the runtime's evidence is absent or carries the proxy's refusal
 * status (or no status). A definite provider status (a 529, a 401) is the
 * provider's own answer and stands. The reason must be from this turn and from
 * the shared vocabulary; anything else leaves the evidence as it was.
 *
 * A retryable reason is adopted only when the runtime's evidence carries the
 * refusal status, i.e. the turn ended ON it. The lease keeps its latest
 * refusal even after the CLI retries past it, so without that status it may
 * describe a call the runtime recovered from, not the failure at hand.
 */
async function proxyRefusalForFailedTurn(args: {
  evidence: InfraFailureEvidence | undefined;
  modelInvoked: boolean;
  leaseRunId: string | undefined;
  bearer: string | undefined;
  turnStartedAt: number;
}): Promise<HarnessProxyRefusalReason | undefined> {
  const { evidence } = args;
  if (!args.modelInvoked || !args.leaseRunId || !args.bearer) return undefined;
  if (
    evidence &&
    (evidence.source !== "harness_runtime" ||
      (evidence.httpStatus !== undefined &&
        evidence.httpStatus !== HARNESS_PROXY_REFUSAL_STATUS))
  ) {
    return undefined;
  }
  const refusal = await readHarnessLeaseRefusal({
    runId: args.leaseRunId,
    bearer: args.bearer,
  });
  if (
    !refusal ||
    refusal.at < args.turnStartedAt ||
    !isHarnessProxyRefusalReason(refusal.reason)
  ) {
    return undefined;
  }
  if (
    HARNESS_PROXY_REFUSAL_REASONS[refusal.reason].retry &&
    evidence?.httpStatus !== HARNESS_PROXY_REFUSAL_STATUS
  ) {
    return undefined;
  }
  return refusal.reason;
}

/**
 * The evidence a failed turn reports: the model proxy's own refusal when it
 * was one (`proxyRefusalForFailedTurn`), so it is classified as what it was;
 * otherwise the runtime's.
 */
export async function failedTurnEvidence(
  args: Parameters<typeof proxyRefusalForFailedTurn>[0],
): Promise<InfraFailureEvidence | undefined> {
  const reason = await proxyRefusalForFailedTurn(args);
  return reason
    ? {
        source: "harness_runtime",
        code: reason,
        httpStatus: HARNESS_PROXY_REFUSAL_STATUS,
      }
    : args.evidence;
}
