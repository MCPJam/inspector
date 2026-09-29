/**
 * Sponsored swarm conversations: the names and small pure helpers shared by
 * the runner (server) and the launch wizard (client).
 *
 * A sponsored conversation is paid from MCPJam's platform budget, counted
 * against a per-user allowance, instead of the organization's credits. The
 * backend decides which conversations are sponsored, at run creation, and
 * persists that decision per attempt. This process can only ASK (by
 * advertising the capability) and then HONOUR the answer (by sending the
 * claim on the sponsored conversation's host steps); it can never make a call
 * sponsored by itself.
 */

/** Sent in `runnerCapabilities`; only when INSPECTOR_SERVICE_TOKEN is set. */
export const SWARM_SPONSORSHIP_CAPABILITY = "swarm-sponsorship-v1";

/** The platform-paid feature name carried by the claim. */
export const SWARM_SPONSORED_FEATURE = "swarm_starter";

/** HTTP 409 code when `expectedSponsored` no longer matches the allocation. */
export const SWARM_FUNDING_CHANGED_CODE = "swarm_funding_changed";

/** Stable backend code for a sponsorship verification failure. */
export const SWARM_SPONSORSHIP_REJECTED_CODE = "swarm_sponsorship_rejected";

export type SwarmAttemptFunding = "starter" | "credits";

export interface SwarmFundingSummary {
  sponsored: number;
  credits: number;
  total: number;
}

export interface SwarmSessionFunding {
  targetId: string;
  sessionIdx: number;
  funding: SwarmAttemptFunding;
}

export interface SwarmFundingChangedDetails {
  expectedSponsored: number;
  actualSponsored: number;
  totalConversations: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** `funding` off a create response, or undefined when absent or malformed. */
export function parseFundingSummary(
  value: unknown,
): SwarmFundingSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const sponsored = count(record.sponsored);
  const credits = count(record.credits);
  const total = count(record.total);
  if (sponsored === undefined || credits === undefined || total === undefined)
    return undefined;
  return { sponsored, credits, total };
}

/** `sessions` off a create response; malformed entries are dropped. */
export function parseSessionFunding(value: unknown): SwarmSessionFunding[] {
  if (!Array.isArray(value)) return [];
  const sessions: SwarmSessionFunding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const sessionIdx = count(record.sessionIdx);
    if (
      typeof record.targetId !== "string" ||
      sessionIdx === undefined ||
      (record.funding !== "starter" && record.funding !== "credits")
    )
      continue;
    sessions.push({
      targetId: record.targetId,
      sessionIdx,
      funding: record.funding,
    });
  }
  return sessions;
}

export function parseFundingChangedDetails(
  value: unknown,
): SwarmFundingChangedDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const expectedSponsored = count(record.expectedSponsored);
  const actualSponsored = count(record.actualSponsored);
  const totalConversations = count(record.totalConversations);
  if (
    expectedSponsored === undefined ||
    actualSponsored === undefined ||
    totalConversations === undefined
  )
    return undefined;
  return { expectedSponsored, actualSponsored, totalConversations };
}

/**
 * Codes that mean MCPJam's platform could not (or would not) pay for a
 * sponsored step. `agent_billing_rejected` is what the stream handler raises
 * when a claimed step comes back without the platform-paid confirmation.
 */
const SPONSORED_PLATFORM_FAILURE =
  /\b(swarm_sponsorship_rejected|sponsorship_rejected|platform_capacity|platform_generation_unavailable|platform_free_budget_exhausted|agent_billing_rejected)\b/i;

export type SponsoredPlatformFailureCode =
  "platform_capacity" | "swarm_sponsorship_rejected";

export interface SponsoredPlatformFailure {
  /** Stored as the attempt's errorCode. */
  code: SponsoredPlatformFailureCode;
  /** Stored and shown; never mentions credits, upgrading or top-ups. */
  message: string;
}

export const SPONSORED_CAPACITY_MESSAGE =
  "MCPJam's sponsored capacity was unavailable, so this conversation stopped before it finished. Evidence gathered so far is kept. You can run it again later.";

export const SPONSORSHIP_REJECTED_MESSAGE =
  "MCPJam could not confirm this conversation as sponsored, so it stopped before it finished. Evidence gathered so far is kept. It was not charged to your organization's credits.";

/**
 * Whether a failure on a SPONSORED conversation is the platform's, and if so
 * the code and sentence to record. Reads the structured code first and the raw
 * message second (the runner appends "(code, HTTP n)" to engine errors, and a
 * control-plane call carries the backend's JSON body).
 *
 * Only meaningful for a sponsored conversation: on a credit-funded one the
 * same codes keep their existing whole-run meaning.
 */
export function sponsoredPlatformFailure(input: {
  code?: string | null;
  message?: string | null;
}): SponsoredPlatformFailure | undefined {
  const match =
    (input.code ? SPONSORED_PLATFORM_FAILURE.exec(input.code) : null) ??
    (input.message ? SPONSORED_PLATFORM_FAILURE.exec(input.message) : null);
  if (!match) return undefined;
  const found = match[1]!.toLowerCase();
  return /sponsorship_rejected|agent_billing_rejected/.test(found)
    ? {
        code: "swarm_sponsorship_rejected",
        message: SPONSORSHIP_REJECTED_MESSAGE,
      }
    : { code: "platform_capacity", message: SPONSORED_CAPACITY_MESSAGE };
}

/**
 * Whether a FAILED attempt's stored code is one of the two a sponsored
 * conversation ends with when the platform could not pay for it. Screens use it
 * to keep these out of the organization-usage-limit callout: no organization
 * limit was hit, and nothing about them is lifted with credits.
 */
export function isSponsoredStopCode(code: string | null | undefined): boolean {
  return (
    code === "platform_capacity" || code === SWARM_SPONSORSHIP_REJECTED_CODE
  );
}
