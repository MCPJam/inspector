/**
 * Employee-only access gate for Soundcheck.
 *
 * Reads `MCPJAM_NONPROD_LOCKDOWN` and `MCPJAM_EMPLOYEE_EMAIL_DOMAINS` — the
 * same environment contract enforced in
 * `mcpjam-inspector/server/config.ts` and
 * `convex/lib/nonProdLockdown.ts`. The logic is re-implemented here (rather
 * than imported from the inspector package) so Soundcheck has no
 * cross-package coupling to the inspector server runtime.
 *
 * Behavior:
 *   - If lockdown is off, everyone signed in via WorkOS passes.
 *   - If lockdown is on, only signed-in users whose email domain appears in
 *     the comma-separated `MCPJAM_EMPLOYEE_EMAIL_DOMAINS` list pass.
 *   - If lockdown is on but the allowed-domains list is empty, fail loudly
 *     instead of silently locking everyone out.
 */

export function isLockdownEnabled(): boolean {
  return process.env.MCPJAM_NONPROD_LOCKDOWN === "true";
}

function getAllowedDomains(): string[] {
  const raw = process.env.MCPJAM_EMPLOYEE_EMAIL_DOMAINS ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmployeeEmail(
  email: string | undefined | null
): boolean {
  const allowedDomains = getAllowedDomains();

  if (isLockdownEnabled() && allowedDomains.length === 0) {
    throw new Error(
      "MCPJAM_EMPLOYEE_EMAIL_DOMAINS must be set when MCPJAM_NONPROD_LOCKDOWN=true"
    );
  }

  if (!email) return false;

  // Match the parsing in mcpjam-inspector/server/config.ts: normalize first,
  // then take the substring after the LAST `@`. Using `split("@")[1]` would
  // incorrectly accept addresses like `a@allowed.com@evil.com`.
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex === -1 || atIndex === normalized.length - 1) return false;
  const domain = normalized.slice(atIndex + 1);

  return allowedDomains.includes(domain);
}
