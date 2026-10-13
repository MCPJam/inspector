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
  const projects = (plan: OrganizationPlan) => {
    const limit = catalog.plans[plan]?.limits.maxProjects;
    return text(limit == null ? "Unlimited" : limit.toLocaleString("en-US"));
  };
  const rollover = (plan: OrganizationPlan) => {
    const cap = catalog.plans[plan]?.rollover;
    if (cap) return text(`Up to ${cap.capCredits.toLocaleString("en-US")}`);
    return plan === "enterprise" ? text("Custom") : unavailable;
  };
  const topUp = (plan: OrganizationPlan) => {
    const entry = catalog.plans[plan]?.topUp;
    if (!entry?.eligible) return unavailable;
    if (plan === "enterprise") return text("Custom");
    const perThousand = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: catalog.currency,
      minimumFractionDigits: 0,
    }).format((entry.centsPerCredit * 1000) / 100);
    return text(`${perThousand} / 1,000 credits`);
  };
  const cicd = (plan: OrganizationPlan) =>
    catalog.plans[plan]?.features.cicd ? check : unavailable;
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
        row(
          "Projects",
          projects("free"),
          projects("pro"),
          projects("team"),
          projects("enterprise"),
        ),
        row(
          "Monthly credit roll-over",
          rollover("free"),
          rollover("pro"),
          rollover("team"),
          rollover("enterprise"),
        ),
        row(
          "Additional credits",
          topUp("free"),
          topUp("pro"),
          topUp("team"),
          topUp("enterprise"),
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
        row("Swarm", check),
        row(
          "CI/CD checks",
          cicd("free"),
          cicd("pro"),
          cicd("team"),
          cicd("enterprise"),
        ),
        row("Skills", check),
        row("WebMCP", check),
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
