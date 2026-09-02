/**
 * The browser tool policy an UNATTENDED run must declare.
 *
 * An eval, swarm or journey has nobody to ask, so approval — the mechanism
 * every interactive surface relies on — simply does not exist there. The
 * policy is the substitute: a statement, made before the run starts, of what
 * this run's browser tools may do. No policy ⇒ `buildBrowserTools` advertises
 * nothing, which is the fail-closed default and NOT an error condition to
 * work around.
 *
 * Parsing is STRICT and never widens: an unrecognized mode, a malformed
 * allowlist, or a policy object of the wrong shape yields `undefined` (⇒ no
 * browser tools), never a permissive default. The one thing worse than a run
 * that cannot use the browser is a run that uses it with a policy nobody
 * actually wrote.
 */
import type { BrowserUnattendedPolicy } from "@/shared/client-fulfilled-tools";
import { logger } from "../../utils/logger.js";

const MODES = new Set(["allow_all", "read_only", "allowlist"]);

function parseStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries;
}

/**
 * Parse a declared policy, or `undefined` when there is none / it is
 * malformed. `context` only labels the warning so an operator can find which
 * run declared the bad policy.
 */
export function parseBrowserToolPolicy(
  input: unknown,
  context?: { source?: string },
): BrowserUnattendedPolicy | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    warn("browserToolPolicy must be an object", context);
    return undefined;
  }
  const candidate = input as {
    mode?: unknown;
    originAllowlist?: unknown;
    toolAllowlist?: unknown;
  };
  if (typeof candidate.mode !== "string" || !MODES.has(candidate.mode)) {
    warn(
      `browserToolPolicy.mode must be one of ${[...MODES].join(", ")}`,
      context,
    );
    return undefined;
  }
  const originAllowlist = parseStringList(candidate.originAllowlist);
  const toolAllowlist = parseStringList(candidate.toolAllowlist);
  if (originAllowlist === null || toolAllowlist === null) {
    warn("browserToolPolicy allowlists must be arrays of strings", context);
    return undefined;
  }
  // An `allowlist` mode whose lists are both empty would silently mean
  // "everything", which is the opposite of what an allowlist says.
  if (
    candidate.mode === "allowlist" &&
    !originAllowlist?.length &&
    !toolAllowlist?.length
  ) {
    warn(
      "browserToolPolicy mode 'allowlist' needs a non-empty originAllowlist or toolAllowlist",
      context,
    );
    return undefined;
  }
  return {
    mode: candidate.mode as BrowserUnattendedPolicy["mode"],
    ...(originAllowlist?.length ? { originAllowlist } : {}),
    ...(toolAllowlist?.length ? { toolAllowlist } : {}),
  };
}

function warn(message: string, context?: { source?: string }): void {
  logger.warn(`[browser-policy] ${message}; browser tools will not be offered`, {
    ...(context?.source ? { source: context.source } : {}),
  });
}

/**
 * The approval-delivery value an unattended surface passes to
 * `resolveHostTools`. `undefined` when no valid policy was declared — the
 * resolver then advertises no browser tools, and the run's notice explains
 * why.
 */
export function browserApprovalDeliveryFor(
  policy: unknown,
  context?: { source?: string },
):
  | { kind: "unattended"; policy: BrowserUnattendedPolicy }
  | undefined {
  const parsed = parseBrowserToolPolicy(policy, context);
  return parsed ? { kind: "unattended", policy: parsed } : undefined;
}
