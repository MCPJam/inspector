import type {
  OrganizationBillingStatus,
  OrganizationPlan,
} from "@/hooks/useOrganizationBilling";

type StaffPlanBillingStatus = Pick<
  OrganizationBillingStatus,
  "plan" | "effectivePlan" | "staffPlan" | "source"
>;

const STAFF_PLAN_END_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Whether MCPJam staff set this org's plan outside Stripe. A missing
 * `staffPlan` (an older backend) is treated as none. A staff simulation
 * takes over `effectivePlan` while it runs, so the page shows the simulation
 * rather than the staff plan, in the panel and the grid alike.
 */
export function isStaffSetPlan(
  billingStatus:
    | Pick<OrganizationBillingStatus, "staffPlan" | "source">
    | null
    | undefined,
): boolean {
  return (
    billingStatus?.staffPlan != null &&
    billingStatus.source !== "simulation" &&
    billingStatus.source !== "trial"
  );
}

/**
 * The plan the Plans page calls current. Under a staff plan `plan` is still
 * the stored commercial plan (usually Free), so the staff tier comes from
 * `effectivePlan`.
 */
export function getDisplayedCurrentPlan(
  billingStatus: StaffPlanBillingStatus | null | undefined,
): OrganizationPlan {
  if (isStaffSetPlan(billingStatus)) {
    return billingStatus?.effectivePlan ?? billingStatus?.plan ?? "free";
  }
  return billingStatus?.plan ?? "free";
}

/**
 * "Through Dec 31, 2026" for a staff plan that ends, or null when it has no
 * end date. `expiresAt` is an exclusive end at midnight UTC, so the last day
 * is the millisecond before it, read in UTC so every viewer sees the same day.
 */
export function formatStaffPlanEndLine(
  expiresAt: number | null,
): string | null {
  if (expiresAt == null) {
    return null;
  }
  return `Through ${STAFF_PLAN_END_FORMAT.format(new Date(expiresAt - 1))}`;
}
