/**
 * Marketing compare-plans table: product rows mirror `mcpjam_pricing_page.html`;
 * tier caps and org/workspace limits follow the internal tier-limits spec (workspaces,
 * members, servers, audit retention, workspace modes, SSO, custom roles).
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
  starter: ComparePlanCell;
  team: ComparePlanCell;
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

/** Section order: organization & workspaces, standard features, evaluations, chatboxes, LLM usage, security, platform, support. */
export const COMPARE_PLAN_MARKETING_SECTIONS: ComparePlanSection[] = [
  {
    title: "Organization & workspaces",
    rows: [
      {
        label: "Seat limit",
        free: t("1 (just you)"),
        starter: t("3"),
        team: t("100", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Workspaces",
        free: t("1"),
        starter: t("2"),
        team: t("10", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Workspace access levels",
        free: x,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Servers per workspace",
        free: t("3"),
        starter: t("5"),
        team: t("Unlimited", true),
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
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Visual OAuth Debugger",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "JSON-RPC Logger & SDK",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "MCPJam Public Server Registry",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Learning Platform",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "MCP Newsletter",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Open Source on GitHub",
        free: c,
        starter: c,
        team: c,
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
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Playground",
        free: c,
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Triage Insights",
        free: x,
        starter: t("Basic"),
        team: c,
        enterprise: c,
      },
      {
        label: "Insights Data Export",
        free: x,
        starter: x,
        team: c,
        enterprise: c,
      },
      {
        label: "Evals CI/CD runs",
        free: t("5 / mo"),
        starter: t("500 included"),
        team: t("5,000 included", true),
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
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Deployments",
        free: x,
        starter: t("1"),
        team: t("3", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Uptime",
        free: x,
        starter: t("20 hrs included"),
        team: t("60 hrs included", true),
        enterprise: t("Custom", true),
      },
      {
        label: "User Feedback Insights",
        free: x,
        starter: x,
        team: c,
        enterprise: c,
      },
      {
        label: "Insights Data Export",
        tooltipKey: "Chatbox Insights Data Export",
        free: x,
        starter: x,
        team: c,
        enterprise: c,
      },
      {
        label: "Branding",
        free: x,
        starter: x,
        team: c,
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
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Frontier models",
        free: t("Rate limited"),
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Daily rate limit / user",
        free: x,
        starter: t("$5"),
        team: t("$5", true),
        enterprise: t("Custom", true),
      },
    ],
  },
  {
    title: "Security & Compliance",
    rows: [
      {
        label: "SSO / SAML",
        free: x,
        starter: x,
        team: x,
        enterprise: c,
      },
      {
        label: "Role-based access control (RBAC)",
        free: x,
        starter: x,
        team: t("Basic", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Audit log retention",
        free: x,
        starter: x,
        team: x,
        enterprise: t("Custom", true),
      },
      {
        label: "Data processing agreement (DPA)",
        free: x,
        starter: x,
        team: t("Click-through", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Uptime service level agreement (SLA)",
        free: x,
        starter: x,
        team: x,
        enterprise: c,
      },
    ],
  },
  {
    title: "Platform & Infrastructure",
    rows: [
      {
        label: "Hosting option",
        free: x,
        starter: t("Cloud"),
        team: t("Cloud", true),
        enterprise: t("Cloud, Hybrid, Self-Hosted", true),
      },
      {
        label: "Infra",
        free: x,
        starter: t("Managed by MCPJam"),
        team: t("Managed by MCPJam", true),
        enterprise: t("Cloud, Hybrid, Self-Hosted", true),
      },
      {
        label: "Data location",
        free: x,
        starter: t("MCPJam's Cloud (US or EU)"),
        team: t("MCPJam's Cloud (US or EU)", true),
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
        starter: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Priority support",
        free: x,
        starter: x,
        team: c,
        enterprise: c,
      },
    ],
  },
];
