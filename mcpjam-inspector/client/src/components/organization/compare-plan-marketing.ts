/**
 * Marketing compare-plans table mirroring the Free / Pro / Enterprise tiers in
 * the pricing proposal. Tier caps and org/project limits follow the internal
 * tier-limits spec (members, projects, eval runs, retention, RBAC).
 */

export type ComparePlanCell =
  | { kind: "check" }
  | { kind: "x" }
  | { kind: "text"; text: string; emphasize?: boolean };

export type ComparePlanRow = {
  label: string;
  /** When set, used for tooltip lookup while `label` is shown in the table. */
  tooltipKey?: string;
  free: ComparePlanCell;
  pro: ComparePlanCell;
  enterprise: ComparePlanCell;
};

export type ComparePlanSection = {
  title: string;
  rows: ComparePlanRow[];
};

const c: ComparePlanCell = { kind: "check" };
const x: ComparePlanCell = { kind: "x" };
function t(text: string, emphasize?: boolean): ComparePlanCell {
  return { kind: "text", text, emphasize };
}

/** Section order: organization & projects, standard features, evaluations, chatboxes, LLM usage, security, platform, support. */
export const COMPARE_PLAN_MARKETING_SECTIONS: ComparePlanSection[] = [
  {
    title: "Organization & projects",
    rows: [
      {
        label: "Seat limit",
        free: t("5"),
        pro: t("Unlimited", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Projects",
        free: t("Unlimited"),
        pro: t("Unlimited", true),
        enterprise: t("Unlimited", true),
      },
      {
        label: "Project access levels",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Servers per project",
        free: t("Unlimited"),
        pro: t("Unlimited", true),
        enterprise: t("Unlimited", true),
      },
    ],
  },
  {
    title: "Standard features",
    rows: [
      {
        label: "Inspector",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Visual OAuth Debugger",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "JSON-RPC Logger & SDK",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "MCPJam Public Server Registry",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Private server registry",
        free: x,
        pro: c,
        enterprise: t("Unlimited", true),
      },
      {
        label: "Learning Platform",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "MCP Newsletter",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Open Source on GitHub",
        free: c,
        pro: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "Evaluations",
    rows: [
      {
        label: "Traces",
        tooltipKey: "Evaluation traces",
        free: t("7-day retention"),
        pro: t("90-day retention", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Playground",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Triage Insights",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Insights Data Export",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Evals CI/CD runs",
        free: t("5 / seat / mo (max 25 / org)"),
        pro: t("1,000 / seat / mo", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Run history retention",
        free: t("30 days"),
        pro: t("1 year", true),
        enterprise: t("Custom", true),
      },
    ],
  },
  {
    title: "Chatboxes",
    rows: [
      {
        label: "Traces",
        tooltipKey: "Chatbox traces",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Deployments",
        free: t("Unlimited"),
        pro: t("Unlimited", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Uptime",
        free: x,
        pro: t("60 hrs / seat / mo", true),
        enterprise: t("Custom", true),
      },
      {
        label: "User Feedback Insights",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Insights Data Export",
        tooltipKey: "Chatbox Insights Data Export",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Branding",
        free: x,
        pro: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "LLM Usage",
    rows: [
      {
        label: "Open models",
        free: t("Rate limited"),
        pro: c,
        enterprise: c,
      },
      {
        label: "Frontier models",
        free: t("Rate limited"),
        pro: c,
        enterprise: c,
      },
      {
        label: "Daily rate limit / user",
        free: t("$1"),
        pro: t("$5", true),
        enterprise: t("Custom", true),
      },
      {
        label: "BYOK",
        free: c,
        pro: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "Security & Compliance",
    rows: [
      {
        label: "SSO / SAML",
        free: x,
        pro: x,
        enterprise: c,
      },
      {
        label: "Role-based access control (RBAC)",
        free: x,
        pro: t("Basic", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Audit log retention",
        free: x,
        pro: x,
        enterprise: c,
      },
      {
        label: "Data processing agreement (DPA)",
        free: x,
        pro: t("Click-through", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Uptime service level agreement (SLA)",
        free: x,
        pro: x,
        enterprise: c,
      },
      {
        label: "Domain auto-join",
        free: c,
        pro: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "Platform & Infrastructure",
    rows: [
      {
        label: "Hosting option",
        free: t("Cloud"),
        pro: t("Cloud", true),
        enterprise: t("Cloud, Hybrid, Self-Hosted", true),
      },
      {
        label: "Infra",
        free: t("Managed by MCPJam"),
        pro: t("Managed by MCPJam", true),
        enterprise: t("Cloud, Hybrid, Self-Hosted", true),
      },
      {
        label: "Data location",
        free: t("MCPJam's Cloud (US or EU)"),
        pro: t("MCPJam's Cloud (US or EU)", true),
        enterprise: t("Cloud, Hybrid, Self-Hosted", true),
      },
    ],
  },
  {
    title: "Support",
    rows: [
      {
        label: "Community support",
        free: c,
        pro: c,
        enterprise: c,
      },
      {
        label: "Priority support",
        free: x,
        pro: c,
        enterprise: c,
      },
      {
        label: "Dedicated Slack channel",
        free: x,
        pro: x,
        enterprise: c,
      },
      {
        label: "Solution engineer",
        free: x,
        pro: x,
        enterprise: c,
      },
    ],
  },
];
