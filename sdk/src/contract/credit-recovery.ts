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
  /** Only ever an https URL on an MCPJam app origin; see {@link parseCreditRecovery}. */
  url?: string;
  /** The plan tier to upgrade to, e.g. `pro`. */
  plan?: string;
  /** Epoch ms when the allowance resets. */
  resetAt?: number;
};

/**
 * An https URL on mcpjam.com or one of its subdomains. The URL is rendered as
 * a link an agent hands to a person, so a refusal body that named any other
 * host (a proxy rewriting it, a forged envelope) must not get it shown.
 */
function isMcpjamAppUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    (host === "mcpjam.com" || host.endsWith(".mcpjam.com"))
  );
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
  return {
    version,
    reason,
    action,
    actor,
    ...(url !== undefined && isMcpjamAppUrl(url) ? { url } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * The first `recovery` found in a refusal: the envelope itself, its
 * `details`, a nested error, or a JSON envelope an error string wraps (error
 * strings often prefix the body with a URL and a status).
 */
export function findCreditRecovery(value: unknown): CreditRecovery | undefined {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): CreditRecovery | undefined => {
    if (depth > 6) return undefined;
    if (typeof item === "string") {
      const start = item.indexOf("{");
      if (start < 0) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.slice(start));
      } catch {
        return undefined;
      }
      return visit(parsed, depth + 1);
    }
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (item instanceof Error) {
      return (
        visit((item as Error & { details?: unknown }).details, depth + 1) ??
        visit(item.cause, depth + 1) ??
        visit(item.message, depth + 1)
      );
    }
    const record = item as Record<string, unknown>;
    const own = parseCreditRecovery(record.recovery);
    if (own) return own;
    for (const nested of Object.values(record)) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
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
