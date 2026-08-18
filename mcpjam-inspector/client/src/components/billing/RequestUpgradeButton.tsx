import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import type { UpgradeOrigin } from "@/hooks/use-upgrade-checkout";

export interface UpgradeRequestRecipient {
  email: string;
  name?: string | null;
}

export type UpgradeRequestAction = "upgrade" | "buyCredits";

/**
 * Builds the owner-facing request. Exported so a test can assert the body
 * without reading it off a URL-encoded href by eye.
 */
export function buildUpgradeRequestMail(params: {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
  requestAction?: UpgradeRequestAction;
}): string | null {
  const {
    recipients,
    organizationName,
    teamName,
    origin,
    requestAction = "upgrade",
  } = params;
  // Encoded per address, not over the joined list: a legal local part can
  // contain `#`, `?` or `%`, and raw those end the mailto path early — the
  // browser reads the rest as a fragment/query, so the recipient is truncated
  // and the subject and body are dropped. The `,` separators stay literal.
  //
  // `@` is restored: it separates local part from domain in the addr-spec, so
  // RFC 6068 keeps it literal and encodes only within the parts (its own
  // example is `mailto:gorby%25kremvax@example.com`). Browsers accept `%40`,
  // but a literal `@` is what the spec asks for.
  const to = recipients
    .map((r) => r.email)
    .filter(Boolean)
    .map((email) => encodeURIComponent(email).replace(/%40/g, "@"));
  if (to.length === 0) return null;

  const firstName = recipients[0]?.name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const isCreditPurchase = requestAction === "buyCredits";
  const blocked = isCreditPurchase
    ? "Our organization has run out of MCPJam credits."
    : origin === "credits"
    ? "I've run out of credits on MCPJam and can't keep using the models until they reset."
    : "I've hit the free plan's eval iteration limit on MCPJam and can't run evals until it resets.";

  const subject = isCreditPurchase
    ? `Credit purchase request for ${organizationName}`
    : `Upgrade request: MCPJam ${teamName} plan for ${organizationName}`;
  const request = isCreditPurchase
    ? `Could you buy more credits for ${organizationName}?`
    : `Could you upgrade ${organizationName} to the ${teamName} plan?`;
  const steps = isCreditPurchase
    ? [
        "1. Open MCPJam, go to Organizations, then Billing.",
        "2. Under Credits, click Buy credits.",
        "3. Choose an amount and finish checkout with Stripe.",
      ]
    : [
        "1. Open MCPJam, go to Organizations, then Billing.",
        `2. Under the ${teamName} plan, pick Annual or Monthly.`,
        "3. Click Upgrade and finish checkout with Stripe.",
      ];
  const body = [
    greeting,
    "",
    blocked,
    request,
    "",
    "Here's how:",
    ...steps,
    "",
    "Thanks",
  ].join("\n");

  return `mailto:${to.join(",")}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

interface RequestUpgradeButtonProps {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
  limitKind: string;
  requestAction?: UpgradeRequestAction;
  organizationId?: string | null;
}

/**
 * The escape hatch for someone who can't upgrade themselves. Renders a
 * `mailto:` anchor rather than a scripted navigation: it matches the existing
 * mail links in SupportTab and the chat error surface, the browser handles it,
 * and the href is directly assertable.
 *
 * The label says "Email" because that is what happens. Nothing here sends
 * anything on the user's behalf, and claiming otherwise would be a lie the
 * first time someone's mail client doesn't open. Sending server-side would
 * need a Convex action that doesn't exist yet.
 *
 * Renders nothing when no owner address resolves, so nobody gets a button that
 * opens an empty draft.
 */
export function RequestUpgradeButton({
  recipients,
  organizationName,
  teamName,
  origin,
  limitKind,
  requestAction = "upgrade",
  organizationId,
}: RequestUpgradeButtonProps) {
  const href = buildUpgradeRequestMail({
    recipients,
    organizationName,
    teamName,
    origin,
    requestAction,
  });
  if (!href) return null;

  const recipientLabel =
    recipients[0]?.name?.trim() || recipients[0]?.email || "your owner";
  const extraCount = recipients.length - 1;

  return (
    <div className="space-y-1.5">
      <Button asChild className="w-full">
        <a
          href={href}
          data-testid="request-upgrade-mail"
          onClick={() => {
            // This is synchronous and failure-isolated, so the browser never
            // waits for analytics before opening the mail client.
            track("plan_limit_upgrade_requested", {
              location: "plan_limit_dialog",
              limit_kind: limitKind,
              origin,
              organization_id: organizationId,
              recipient_count: recipients.length,
              has_named_recipient: recipients.some((recipient) =>
                Boolean(recipient.name?.trim())
              ),
              request_action: requestAction,
            });
          }}
        >
          Email your plan's owner
        </a>
      </Button>
      <p className="text-xs text-muted-foreground">
        Opens a draft to {recipientLabel}
        {extraCount > 0
          ? ` and ${extraCount} other owner${extraCount === 1 ? "" : "s"}`
          : ""}
        , with the steps to{" "}
        {requestAction === "buyCredits" ? "buy credits" : "upgrade"}.
      </p>
    </div>
  );
}
