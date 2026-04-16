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
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return getAllowedDomains().includes(domain);
}
