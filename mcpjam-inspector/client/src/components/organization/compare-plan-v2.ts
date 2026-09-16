import type {
  OrganizationPlan,
  PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import { formatIncludedCredits } from "@/lib/pricing-catalog";
import type {
  ComparePlanCell,
  ComparePlanRow,
  ComparePlanSection,
} from "./compare-plan-marketing";

// Figma Pricing Page, node 136:447. Kept separate from the legacy Team table.
const check: ComparePlanCell = { kind: "check" };
const unavailable: ComparePlanCell = { kind: "x" };
const text = (value: string): ComparePlanCell => ({
  kind: "text",
  text: value,
});
function row(
  label: string,
  free: ComparePlanCell,
  pro = free,
  team = pro,
  enterprise = team,
): ComparePlanRow {
  return { label, free, pro, team, enterprise };
}

export function buildV2ComparePlanSections(
  catalog: PlanCatalog,
): ComparePlanSection[] {
  const credits = (plan: OrganizationPlan) =>
    text(formatIncludedCredits(catalog.plans[plan]?.includedCredits));
  const seats = (plan: OrganizationPlan) => {
    const limit = catalog.plans[plan]?.limits.maxMembers;
    return text(limit == null ? "Unlimited" : limit.toLocaleString("en-US"));
  };
  const sso = (plan: OrganizationPlan) =>
    catalog.plans[plan]?.features.sso ? check : unavailable;
  return [
    {
      title: "Usage",
      rows: [
        {
          ...row(
            "Included credits",
            credits("free"),
            credits("pro"),
            credits("team"),
            credits("enterprise"),
          ),
          tooltipKey: "V2 included credits",
        },
        row(
          "Seats",
          seats("free"),
          seats("pro"),
          seats("team"),
          seats("enterprise"),
        ),
        row("BYOK", check),
      ],
    },
    {
      title: "Features",
      rows: [
        row("Playground", check),
        row("OAuth / XAA Debugger", check),
        row("User Acceptance Testing", check),
        row("Evaluations", check),
        row("Eval history", text("30 days"), text("Unlimited")),
        row("Triage Insights", check),
        row("Traces history", text("30 days"), text("Unlimited")),
      ],
    },
    {
      title: "Security & Compliance",
      rows: [
        {
          ...row(
            "SSO / SAML",
            sso("free"),
            sso("pro"),
            sso("team"),
            sso("enterprise"),
          ),
          tooltipKey: "V2 SSO / SAML",
        },
        row(
          "Role-based access control",
          unavailable,
          unavailable,
          text("Basic"),
          text("Custom roles, SCIM"),
        ),
        row(
          "Data processing agreement",
          unavailable,
          unavailable,
          unavailable,
          check,
        ),
        row("Uptime SLA", unavailable, unavailable, unavailable, check),
        row(
          "Audit log retention",
          unavailable,
          unavailable,
          unavailable,
          check,
        ),
        row(
          "Auth forensics, SIEM reports",
          unavailable,
          unavailable,
          unavailable,
          check,
        ),
      ],
    },
    {
      title: "Support",
      rows: [
        row(
          "Support tier",
          text("Community"),
          text("Basic"),
          text("Priority"),
          text("Dedicated"),
        ),
      ],
    },
  ];
}
