import { useEffect, useRef, useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { copyToClipboard } from "@/lib/clipboard";
import type { UpgradeOrigin } from "@/hooks/use-upgrade-checkout";

export interface UpgradeRequestRecipient {
  email: string;
  name?: string | null;
}

export type UpgradeRequestAction = "upgrade" | "buyCredits";

interface UpgradeRequestParams {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
  requestAction?: UpgradeRequestAction;
}

/**
 * The owner-facing request as plain text. The email draft and the copied
 * request carry the same words, so an owner who gets it over Slack is told
 * exactly what an owner who gets the email is told.
 */
export function buildUpgradeRequestMessage(params: UpgradeRequestParams): {
  subject: string;
  body: string;
} {
  const {
    recipients,
    organizationName,
    teamName,
    origin,
    requestAction = "upgrade",
  } = params;
  const firstName = recipients[0]?.name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const isCreditPurchase = requestAction === "buyCredits";
  const blocked = isCreditPurchase
    ? "Our organization has run out of MCPJam credits."
    : origin === "credits"
      ? "Our organization has run out of MCPJam credits, so we can't continue testing until credits reset or we upgrade."
      : "I've hit the free plan's eval iteration limit on MCPJam and can't run evals until it resets.";

  const subject = isCreditPurchase
    ? `Credit purchase request for ${organizationName}`
    : `Upgrade request: MCPJam ${teamName} plan for ${organizationName}`;
  const request = isCreditPurchase
    ? `Could you buy more shared credits for ${organizationName} so we can continue testing before our included allowance renews?`
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
  return { subject, body };
}

/**
 * Builds the owner-facing email draft. Exported so a test can assert the body
 * without reading it off a URL-encoded href by eye.
 */
export function buildUpgradeRequestMail(
  params: UpgradeRequestParams,
): string | null {
  // Encoded per address, not over the joined list: a legal local part can
  // contain `#`, `?` or `%`, and raw those end the mailto path early — the
  // browser reads the rest as a fragment/query, so the recipient is truncated
  // and the subject and body are dropped. The `,` separators stay literal.
  //
  // `@` is restored: it separates local part from domain in the addr-spec, so
  // RFC 6068 keeps it literal and encodes only within the parts (its own
  // example is `mailto:gorby%25kremvax@example.com`). Browsers accept `%40`,
  // but a literal `@` is what the spec asks for.
  const to = params.recipients
    .map((r) => r.email)
    .filter(Boolean)
    .map((email) => encodeURIComponent(email).replace(/%40/g, "@"));
  if (to.length === 0) return null;

  const { subject, body } = buildUpgradeRequestMessage(params);
  return `mailto:${to.join(",")}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

/**
 * Who the request goes to and how to send it, in one sentence. It sits above
 * the buttons as ordinary text: the old gray caption under the email button
 * ("Opens a draft to …") read as a link, and people clicked it. The dialog's
 * description already says why an owner is needed, so this does not repeat it.
 */
export function describeRequestOwners(
  recipients: UpgradeRequestRecipient[],
): string {
  const first = recipients[0];
  const firstLabel = first?.name?.trim() || first?.email || "an owner";
  const extraCount = recipients.length - 1;
  const who =
    extraCount > 0
      ? `${firstLabel} and ${extraCount} other owner${extraCount === 1 ? "" : "s"}`
      : `${firstLabel} (owner)`;
  return `Send the request to ${who} by email, or copy it for Slack or anywhere else.`;
}

export interface CreditEngagementContext {
  surface: string | null;
  current_plan?: string;
  effective_plan?: string;
}

interface RequestUpgradeButtonProps {
  recipients: UpgradeRequestRecipient[];
  organizationName: string;
  teamName: string;
  origin: UpgradeOrigin;
  limitKind: string;
  requestAction?: UpgradeRequestAction;
  organizationId?: string | null;
  engagementContext?: CreditEngagementContext;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * The way out for someone who can't upgrade themselves: email the owners, or
 * copy the same request to send another way.
 *
 * The email is a `mailto:` anchor, so it only does something where a mail
 * client is set up. Someone on browser Gmail clicks it and nothing happens,
 * which is why Copy request sits beside it.
 *
 * Nothing here sends anything on the user's behalf. Sending server-side would
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
  engagementContext,
}: RequestUpgradeButtonProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const params = {
    recipients,
    organizationName,
    teamName,
    origin,
    requestAction,
  };
  const href = buildUpgradeRequestMail(params);
  if (!href) return null;

  const trackRequest = (
    outcome: "email_draft_requested" | "request_copied",
    extra: Record<string, unknown> = {},
  ) =>
    // Synchronous and failure-isolated, so the browser never waits for
    // analytics before opening the mail client.
    track("plan_limit_upgrade_requested", {
      ...engagementContext,
      outcome,
      location: "plan_limit_dialog",
      limit_kind: limitKind,
      origin,
      organization_id: organizationId,
      recipient_count: recipients.length,
      has_named_recipient: recipients.some((recipient) =>
        Boolean(recipient.name?.trim()),
      ),
      request_action: requestAction,
      ...extra,
    });

  const handleCopy = async () => {
    const { subject, body } = buildUpgradeRequestMessage(params);
    const ok = await copyToClipboard(`${subject}\n\n${body}`);
    trackRequest("request_copied", { copy_succeeded: ok });
    setCopyState(ok ? "copied" : "failed");
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <div className="space-y-3">
      <p
        className="text-sm text-foreground"
        data-testid="request-upgrade-owners"
      >
        {describeRequestOwners(recipients)}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button asChild>
          <a
            href={href}
            data-testid="request-upgrade-mail"
            onClick={() => trackRequest("email_draft_requested")}
          >
            <Mail aria-hidden="true" />
            {requestAction === "buyCredits"
              ? "Request credits"
              : "Request upgrade"}
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="request-upgrade-copy"
          onClick={() => void handleCopy()}
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Couldn't copy"
              : "Copy request"}
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copyState === "copied"
          ? "Request copied to clipboard"
          : copyState === "failed"
            ? "Couldn't copy the request"
            : ""}
      </span>
    </div>
  );
}
