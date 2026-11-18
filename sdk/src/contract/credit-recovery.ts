/**
 * The next step on an MCPJam credit refusal, read from the backend's
 * structured `recovery` field and rendered as the one sentence every surface
 * shows: the run notes, a skipped trial, a decision summary's next action,
 * the CLI, the error describer.
 *
 * The backend's `error` copy already leads with the step, but prose loses it:
 * the swarm scrubber strips URLs, and an agent relaying a refusal tended to
 * relay "wait N hours" instead of the upgrade link. Rendering from the field
 * keeps the link and the order the same everywhere.
 *
 * Twin of `mcpjam-backend/convex/lib/spendRecovery.ts` (`SpendRecovery`).
 * Browser-safe, no node-only deps.
 */
import { z } from "zod";
import { MCPJAM_CLOUD_BASE_URL } from "../deployment/address.js";

export const CREDIT_RECOVERY_ACTIONS = [
  "upgrade_plan",
  "buy_credits",
  "ask_admin",
  "raise_budget",
  "contact_support",
  "wait",
] as const;
export type CreditRecoveryAction = (typeof CREDIT_RECOVERY_ACTIONS)[number];

export const CREDIT_RECOVERY_ACTORS = [
  "caller",
  "owner_or_admin",
  "support",
] as const;
export type CreditRecoveryActor = (typeof CREDIT_RECOVERY_ACTORS)[number];

/** Not strict: a field a newer backend adds must not discard the step. */
export const creditRecoverySchema = z.object({
  version: z.literal(1),
  reason: z.string().min(1),
  action: z.enum(CREDIT_RECOVERY_ACTIONS),
  actor: z.enum(CREDIT_RECOVERY_ACTORS),
  url: z.string().optional(),
  plan: z.string().min(1).optional(),
  resetAt: z.number().finite().positive().optional(),
});

export type CreditRecovery = {
  version: 1;
  reason: string;
  action: CreditRecoveryAction;
  actor: CreditRecoveryActor;
  /**
   * Only ever a normalized https URL on an MCPJam app origin; see
   * {@link parseCreditRecovery}.
   */
  url?: string;
  /** The plan tier to upgrade to, e.g. `pro`. */
  plan?: string;
  /** Epoch ms when the allowance resets. */
  resetAt?: number;
};

/**
 * The app origins a recovery link may point at: MCPJam Cloud and staging. The
 * link is handed to a person as MCPJam's own instruction, so any other host,
 * subdomain included, is not shown.
 */
const MCPJAM_APP_HOSTS: ReadonlySet<string> = new Set([
  new URL(MCPJAM_CLOUD_BASE_URL).hostname,
  "staging.mcpjam.com",
]);

/** Whitespace or a control character anywhere in the raw string. */
const UNSAFE_URL_CHARACTERS = /[\s\u0000-\u001f\u007f]/;

/**
 * The URL in its normalized form when it is an https link on an MCPJam app
 * origin, otherwise `undefined`. The normalized `href` is what gets emitted,
 * and a raw string that does not already equal it is refused rather than
 * repaired: the difference is where a forged link hides.
 */
function mcpjamAppUrl(value: string): string | undefined {
  if (UNSAFE_URL_CHARACTERS.test(value)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !MCPJAM_APP_HOSTS.has(parsed.hostname) ||
    parsed.href !== value.trim()
  ) {
    return undefined;
  }
  return parsed.href;
}

/**
 * The recovery, or `undefined` for anything that is not a v1 recovery. Never
 * throws: an old backend sends none, and a malformed one must not cost the
 * caller the refusal it came with. A URL off an MCPJam app origin is dropped
 * and the step kept.
 */
export function parseCreditRecovery(
  value: unknown
): CreditRecovery | undefined {
  const parsed = creditRecoverySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { version, reason, action, actor, url, plan, resetAt } = parsed.data;
  const appUrl = url === undefined ? undefined : mcpjamAppUrl(url);
  return {
    version,
    reason,
    action,
    actor,
    ...(appUrl !== undefined ? { url: appUrl } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * A refusal envelope: the object itself, or a string that is wholly one JSON
 * object (a raw response body). Text that merely contains JSON is not one.
 */
function envelopeOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) return undefined;
    try {
      return envelopeOf(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `recovery` on MCPJam's refusal envelope, read from its top level only:
 * the envelope itself, or the envelope one `details` or `message` down when
 * that field is wholly one (an error carrying the response body, or
 * `{ message, details }` holding the raw body). Never searched for in nested
 * values or in free-form error text, where a third party's body could plant
 * one. Callers pass only a refusal already known to be MCPJam's own.
 */
export function creditRecoveryOfRefusal(
  refusal: unknown
): CreditRecovery | undefined {
  const envelope = envelopeOf(refusal);
  if (!envelope) return undefined;
  return (
    parseCreditRecovery(envelope.recovery) ??
    parseCreditRecovery(envelopeOf(envelope.details)?.recovery) ??
    parseCreditRecovery(envelopeOf(envelope.message)?.recovery)
  );
}

/**
 * A run's recovery: the first trial whose infrastructure failure carries one.
 * A credit stop records it on the trial that hit the refusal; every later
 * trial was skipped and carries none.
 */
export function creditRecoveryOfIterations(
  iterations: readonly { infraError?: { recovery?: unknown } | null }[]
): CreditRecovery | undefined {
  for (const iteration of iterations) {
    const recovery = parseCreditRecovery(iteration.infraError?.recovery);
    if (recovery) return recovery;
  }
  return undefined;
}

const PLAN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
});

/**
 * Model-spend refusals only. BYOK does not lift a platform fee (charged per
 * eval step whatever the model runs on) or a frozen wallet.
 */
const BYOK_REASONS = new Set([
  "allowance_exhausted",
  "insufficient_for_request",
  "budget_reached",
  "auto_topup_declined",
]);

function stepSentence(recovery: CreditRecovery): string {
  const link = recovery.url ? `: ${recovery.url}` : "";
  const forwarded = recovery.actor === "owner_or_admin";
  switch (recovery.action) {
    case "upgrade_plan": {
      const plan =
        recovery.plan && Object.hasOwn(PLAN_NAMES, recovery.plan)
          ? PLAN_NAMES[recovery.plan]
          : "a paid plan";
      return forwarded
        ? `Ask an organization owner or admin to upgrade to ${plan}${link}.`
        : `Upgrade to ${plan} to keep going${link}.`;
    }
    case "buy_credits":
      return forwarded
        ? `Ask an organization owner or admin to buy credits${link}.`
        : `Buy credits to keep going${link}.`;
    case "raise_budget":
      return forwarded
        ? `Ask an organization owner or admin to raise the organization's spend budget${link}.`
        : `Raise the organization's spend budget${link}.`;
    case "ask_admin":
      return "Ask an organization owner or admin to arrange more MCPJam credits.";
    case "contact_support":
      return "Contact MCPJam support to arrange more credits.";
    case "wait":
      return "Retry once the MCPJam allowance resets.";
  }
}

function validResetAt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * An absolute time, not "in 17 hours": this text is stored on the run and
 * read long after it was written.
 */
function formatResetAt(resetAt: number): string {
  return `${new Date(resetAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The recovery as the text every surface shows: the step first (with its
 * link), then the BYOK note when BYOK would avoid the charge, then the reset
 * time last and only when the refusal named one. `options.resetAt` stands in
 * for a recovery that carries none.
 */
export function formatCreditRecovery(
  recovery: CreditRecovery,
  options: { resetAt?: number } = {}
): string {
  const resetAt = validResetAt(recovery.resetAt ?? options.resetAt);
  if (recovery.action === "wait") {
    return resetAt === undefined
      ? stepSentence(recovery)
      : `Retry after the MCPJam allowance resets at ${formatResetAt(resetAt)}.`;
  }
  const parts = [stepSentence(recovery)];
  if (BYOK_REASONS.has(recovery.reason)) {
    parts.push("BYOK avoids MCPJam model charges.");
  }
  if (resetAt !== undefined) {
    parts.push(`The allowance resets at ${formatResetAt(resetAt)}.`);
  }
  return parts.join(" ");
}
