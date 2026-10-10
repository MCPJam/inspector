/**
 * The organization-key half of the harness model-broker client: what a start
 * request carries for an org selection, what its response must confirm before
 * a turn runs on the org's own provider key, and the model proxy's own refusal
 * read back after a turn failed under such a lease.
 *
 * The key itself never reaches the inspector. Everything here is the
 * non-secret echo the backend's ledger recorded.
 */
import { logger } from "../logger.js";
import type { HarnessUpstreamProfile } from "@/shared/harness-model-support";
import type { ModelSelection } from "@mcpjam/sdk/browser";

/**
 * The non-secret facts a start response echoes for a lease on the
 * ORGANIZATION'S own provider key — read from what the backend's ledger
 * recorded, so they say what was actually minted rather than what was asked
 * for. `credentialRevision` is a short one-way hash: equal ⇒ the same key.
 */
export type HarnessOrgLeaseUpstream = {
  credentialSource: "org";
  profile: Exclude<HarnessUpstreamProfile, "gateway">;
  /** The exact native model id the lease admits (`claude-sonnet-4-5`). */
  nativeModelId: string;
  credentialRevision: string;
};

/**
 * The org selection a broker request carries, or nothing. Only a `source:
 * 'org'` selection travels: a hosted request's body stays byte-identical to
 * what an older backend expects.
 */
export function orgSelectionField(
  selection: ModelSelection | null | undefined,
): {
  modelSelection?: ModelSelection;
} {
  return selection?.source === "org" ? { modelSelection: selection } : {};
}

/** The org facts of a start response, or null when absent or incomplete. */
export function orgLeaseUpstreamFrom(
  payload: unknown,
): HarnessOrgLeaseUpstream | null {
  const p = payload as Record<string, unknown> | null;
  if (
    p?.credentialSource !== "org" ||
    (p.upstreamProfile !== "anthropic-native" &&
      p.upstreamProfile !== "openai-native") ||
    typeof p.credentialRevision !== "string" ||
    p.credentialRevision.length === 0 ||
    typeof p.upstreamModelId !== "string" ||
    p.upstreamModelId.length === 0 ||
    p.upstreamModelId.includes("/")
  ) {
    return null;
  }
  return {
    credentialSource: "org",
    profile: p.upstreamProfile,
    nativeModelId: p.upstreamModelId,
    credentialRevision: p.credentialRevision,
  };
}

/**
 * Error code for a start that was ASKED for an org-key lease and came back
 * without confirming one — an older backend that ignored the selection and
 * minted a lease on MCPJam's key. The lease is revoked and the turn fails
 * before the runtime starts: an org binding is never assumed.
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

function convexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new Error("CONVEX_HTTP_URL is required for harness model broker");
  }
  return url;
}

function bearerHeader(bearer: string): string {
  const trimmed = bearer.trim();
  return /^Bearer\s/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

type LeaseRefusalPayload = {
  ok?: unknown;
  refusal?: { reason?: unknown; at?: unknown } | null;
} | null;

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
      convexHttpUrl(),
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
    const payload = (await response.json()) as LeaseRefusalPayload;
    const refusal = payload?.refusal;
    if (
      payload?.ok !== true ||
      typeof refusal?.reason !== "string" ||
      typeof refusal?.at !== "number"
    ) {
      return undefined;
    }
    return { reason: refusal.reason, at: refusal.at };
  } catch (err) {
    logger.warn("[harness-model-broker] refusal lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
