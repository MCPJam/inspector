/**
 * Marketing compare-plans table: product rows mirror `mcpjam_pricing_page.html`;
 * eval caps and enterprise security features carry the commercial
 * distinctions.
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
  /** When true, rows render without the uppercase section header row. */
  hideTitle?: boolean;
  rows: ComparePlanRow[];
};

const c: ComparePlanCell = { kind: "check" };
const x: ComparePlanCell = { kind: "x" };
function t(text: string, emphasize?: boolean): ComparePlanCell {
  return { kind: "text", text, emphasize };
}

/** Section order: credits & seats, evaluations, security, support, standard features. */
export const COMPARE_PLAN_MARKETING_SECTIONS: ComparePlanSection[] = [
  {
    title: "Credits & seats",
    hideTitle: true,
    rows: [
      {
        label: "Included credits",
        free: t("200 / day"),
        team: t("10,000 / seat / mo", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Seat limit",
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
        label: "Eval iterations",
        free: t("25 / day"),
        team: t("5,000 / mo", true),
        enterprise: t("Custom", true),
      },
      {
        label: "Traces",
        tooltipKey: "Evaluation traces",
        free: c,
        team: c,
        enterprise: c,
      },
    ],
  },
  {
    title: "Security & Compliance",
    rows: [
      {
        label: "Role-based access control (RBAC)",
        free: t("Basic"),
        team: t("Basic", true),
        enterprise: t("Custom", true),
      },
      {
        label: "SSO / SAML",
        free: x,
        team: x,
        enterprise: c,
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
        team: x,
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
