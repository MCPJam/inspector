import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import type { UpgradeOrigin } from "@/hooks/use-upgrade-checkout";

export interface UpgradeRequestRecipient {
  email: string;
  name?: string | null;
}

/**
 * Builds the owner-facing upgrade request. Exported so a test can assert the
 * body without reading it off a URL-encoded href by eye.
 */
export function buildUpgradeRequestMail(params: {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
}): string | null {
  const { recipients, organizationName, teamName, origin } = params;
  const to = recipients.map((r) => r.email).filter(Boolean);
  if (to.length === 0) return null;

  const firstName = recipients[0]?.name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const blocked =
    origin === "credits"
      ? "I've run out of credits on MCPJam and can't keep using the models until they reset."
      : "I've hit the free plan's eval iteration limit on MCPJam and can't run evals until it resets.";

  const subject = `Upgrade request: MCPJam ${teamName} plan for ${organizationName}`;
  const body = [
    greeting,
    "",
    blocked,
    `Could you upgrade ${organizationName} to the ${teamName} plan?`,
    "",
    "Here's how:",
    "1. Open MCPJam, go to Organizations, then Billing.",
    `2. Under the ${teamName} plan, pick Annual or Monthly.`,
    "3. Click Upgrade and finish checkout with Stripe.",
    "",
    "Thanks",
  ].join("\n");

  return `mailto:${to.join(",")}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

interface RequestUpgradeButtonProps {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
  limitKind: string;
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
}: RequestUpgradeButtonProps) {
  const href = buildUpgradeRequestMail({
    recipients,
    organizationName,
    teamName,
    origin,
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
            track("plan_limit_upgrade_requested", {
              location: "plan_limit_dialog",
              limit_kind: limitKind,
              origin,
              recipient_count: recipients.length,
            });
          }}
        >
          Email your owner
        </a>
      </Button>
      <p className="text-xs text-muted-foreground">
        Opens a draft to {recipientLabel}
        {extraCount > 0
          ? ` and ${extraCount} other owner${extraCount === 1 ? "" : "s"}`
          : ""}
        , with the steps to upgrade.
      </p>
    </div>
  );
}
