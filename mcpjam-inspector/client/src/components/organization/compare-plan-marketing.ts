/**
 * Marketing compare-plans table: product rows mirror `mcpjam_pricing_page.html`;
 * org/project counts are uncapped, while eval caps, credits, and enterprise
 * security features carry the remaining commercial distinctions.
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

/** Section order: organization & projects, evaluations, LLM usage, security, support, standard features. */
export const COMPARE_PLAN_MARKETING_SECTIONS: ComparePlanSection[] = [
  {
    title: "Organization & projects",
    rows: [
      {
        label: "Seat limit",
        free: t("Unlimited"),
        team: t("Unlimited", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Projects",
        free: t("Unlimited"),
        team: t("Unlimited", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Project access levels",
        free: x,
        team: c,
        enterprise: c,
      },
      {
        label: "Servers per project",
        free: t("Unlimited"),
        team: t("Unlimited", true),
        enterprise: t("Unlimited", true),
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
        team: c,
        enterprise: c,
      },
      {
        label: "Playground",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Triage Insights",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Insights Data Export",
        free: x,
        team: x,
        enterprise: c,
      },
      {
        label: "Eval iteration cap",
        free: t("500 iter. / mo"),
        team: t("10,000 iter. / mo", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Eval iteration overage",
        tooltipKey: "Eval iteration overage",
        free: x,
        team: t("$0.02 / iter.", true),
        enterprise: t("Custom", true),
      },
    ],
  },
  {
    title: "LLM Usage",
    rows: [
      {
        label: "Open models",
        free: t("Rate limited"),
        team: c,
        enterprise: c,
      },
      {
        label: "Frontier models",
        free: t("Rate limited"),
        team: c,
        enterprise: c,
      },
      {
        label: "Free daily credits / user",
        free: x,
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
        team: x,
        enterprise: c,
      },
      {
        label: "Role-based access control (RBAC)",
        free: x,
        team: t("Basic", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Audit log retention",
        free: x,
        team: x,
        enterprise: t("Custom", true),
      },
      {
        label: "Data processing agreement (DPA)",
        free: x,
        team: t("Click-through", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Uptime service level agreement (SLA)",
        free: x,
        team: x,
        enterprise: c,
      },
    ],
  },
  {
    title: "Support",
    rows: [
      {
        label: "Community support",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Priority support",
        free: x,
        team: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "Standard features",
    rows: [
      {
        label: "Playground",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Visual OAuth Debugger",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "JSON-RPC Logger & SDK",
        free: c,
        team: c,
        enterprise: c,
      },
      {
        label: "Open Source on GitHub",
        free: c,
        team: c,
        enterprise: c,
      },
    ],
  },
];
