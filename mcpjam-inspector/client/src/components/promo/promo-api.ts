import { makeFunctionReference } from "convex/server";

export type Receipt = {
  canOpenOrganization: boolean;
  userId: string;
  grantId: string;
  organizationId: string;
  organizationName: string;
  campaignLabel: string;
  credits: number;
  redeemedAt: number;
};
export type Result =
  | { status: "redeemed" | "already_redeemed"; receipt: Receipt }
  | { status: "refused"; code: string; retryAfterMs?: number };
export type Ready = {
  status: "ready";
  credits: number;
  cutoff: number;
  label: string;
  account: { userId: string; name: string; email: string };
  organizations: { organizationId: string; name: string }[];
};
export const campaignId = "agntcon-2026";
export const contextQuery = makeFunctionReference<
  "query",
  { campaignId: string },
  (Ready | Exclude<Result, { status: "redeemed" }>) & {
    accountExternalId?: string;
  }
>("promoRedemption:getRedemptionContext");
export const redeemMutation = makeFunctionReference<
  "mutation",
  {
    campaignId: string;
    code: string;
    organizationId: string;
    name: string;
    company: string;
  },
  Result
>("promoRedemption:redeem");

export const refusalCopy: Record<string, string> = {
  campaign_closed: "AGNTCon credit redemption is closed.",
  invalid_code: "This code is not valid. Check your card and try again.",
  already_used:
    "This card has already been used. Check that you scanned your own card.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  invalid_input:
    "Enter your full name and company. Independent and Student are accepted.",
  account_email_missing:
    "Your account needs an email address. Update your profile and try again.",
  organization_ineligible:
    "You need to be an owner, admin or member of the receiving organization. Choose another organization.",
};
