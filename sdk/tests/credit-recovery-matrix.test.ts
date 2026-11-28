/**
 * The sentence for every action × actor, with and without a link. The backend
 * renders the same step (`recoverySentence` in its `convex/lib/spendRecovery.ts`)
 * and holds itself to this same table, so a wording change on one side fails
 * here until the other side matches. The one known difference is `wait`: the
 * backend renders no sentence for it (its refusal copy already names the
 * reset), and the SDK renders the retry line below.
 */
import { describe, expect, it } from "vitest";
import {
  CREDIT_RECOVERY_ACTIONS,
  CREDIT_RECOVERY_ACTORS,
  formatCreditRecovery,
  type CreditRecovery,
  type CreditRecoveryAction,
  type CreditRecoveryActor,
} from "../src/contract/index.js";

const URL = "https://app.mcpjam.com/organizations/org_1/settings?tab=plans";

type Row = [CreditRecoveryAction, CreditRecoveryActor, boolean, string];

const MATRIX: readonly Row[] = [
  ["upgrade_plan", "caller", true, `Upgrade to Pro to keep going: ${URL}`],
  ["upgrade_plan", "caller", false, "Upgrade to Pro to keep going."],
  [
    "upgrade_plan",
    "owner_or_admin",
    true,
    `Only an organization owner or admin can upgrade to Pro. Send them this link: ${URL}`,
  ],
  [
    "upgrade_plan",
    "owner_or_admin",
    false,
    "Only an organization owner or admin can upgrade to Pro. Ask one of them.",
  ],
  ["upgrade_plan", "support", true, `Upgrade to Pro to keep going: ${URL}`],
  ["upgrade_plan", "support", false, "Upgrade to Pro to keep going."],
  ["buy_credits", "caller", true, `Buy credits to keep going: ${URL}`],
  ["buy_credits", "caller", false, "Buy credits to keep going."],
  [
    "buy_credits",
    "owner_or_admin",
    true,
    `Only an organization owner or admin can buy credits. Send them this link: ${URL}`,
  ],
  [
    "buy_credits",
    "owner_or_admin",
    false,
    "Only an organization owner or admin can buy credits. Ask one of them.",
  ],
  ["buy_credits", "support", true, `Buy credits to keep going: ${URL}`],
  ["buy_credits", "support", false, "Buy credits to keep going."],
  [
    "raise_budget",
    "caller",
    true,
    `Raise the organization's spend budget: ${URL}`,
  ],
  ["raise_budget", "caller", false, "Raise the organization's spend budget."],
  [
    "raise_budget",
    "owner_or_admin",
    true,
    `Only an organization owner or admin can raise the spend budget. Send them this link: ${URL}`,
  ],
  [
    "raise_budget",
    "owner_or_admin",
    false,
    "Only an organization owner or admin can raise the spend budget. Ask one of them.",
  ],
  [
    "raise_budget",
    "support",
    true,
    `Raise the organization's spend budget: ${URL}`,
  ],
  ["raise_budget", "support", false, "Raise the organization's spend budget."],
  ...CREDIT_RECOVERY_ACTORS.flatMap((actor): Row[] =>
    [true, false].flatMap((withUrl): Row[] => [
      [
        "ask_admin",
        actor,
        withUrl,
        "Ask an organization owner or admin to arrange more MCPJam credits.",
      ],
      [
        "contact_support",
        actor,
        withUrl,
        "Contact MCPJam support to arrange more credits.",
      ],
      ["wait", actor, withUrl, "Retry once the MCPJam allowance resets."],
    ]),
  ),
];

describe("credit recovery sentence matrix", () => {
  it("covers every action × actor × link combination exactly once", () => {
    const keys = MATRIX.map(([action, actor, withUrl]) =>
      [action, actor, withUrl].join("|"),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(
      CREDIT_RECOVERY_ACTIONS.length * CREDIT_RECOVERY_ACTORS.length * 2,
    );
  });

  it.each(MATRIX)("%s / %s / link=%s", (action, actor, withUrl, expected) => {
    const recovery: CreditRecovery = {
      version: 1,
      reason: "allowance_exhausted",
      action,
      actor,
      plan: "pro",
      ...(withUrl ? { url: URL } : {}),
    };
    expect(formatCreditRecovery(recovery)).toBe(expected);
  });

  it.each([
    ["free", "Free"],
    ["pro", "Pro"],
    ["team", "Team"],
    ["enterprise", "Enterprise"],
    ["unknown_tier", "a paid plan"],
    [undefined, "a paid plan"],
  ])("names plan %s as %s", (plan, name) => {
    const recovery: CreditRecovery = {
      version: 1,
      reason: "allowance_exhausted",
      action: "upgrade_plan",
      actor: "caller",
      ...(plan ? { plan } : {}),
    };
    expect(formatCreditRecovery(recovery)).toBe(
      `Upgrade to ${name} to keep going.`,
    );
  });
});
