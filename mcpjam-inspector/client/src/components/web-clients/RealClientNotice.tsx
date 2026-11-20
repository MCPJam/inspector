import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { webClientName, webClientSite } from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/** Why a run on a web client stopped, as the runtime reports it. */
export type RealClientStop =
  | { kind: "needs_sign_in"; account: string }
  | { kind: "plan_limit"; siteMessage?: string }
  | { kind: "page_module"; step: string; build?: string };

const NOT_GRADED = "The run stopped, and your server wasn't graded.";

/**
 * A stopped run, under its turn: what happened, that the server wasn't
 * graded, and the one fix that applies. These stops are the vendor's or
 * MCPJam's, never the server's, so they read as a warning, not an error.
 * Each action shows only when its handler is passed.
 */
export function RealClientNotice({
  vendor,
  stop,
  isAdmin = false,
  onSignInAgain,
  onSendAgain,
  onCopyAdminLink,
  onRetry,
  onOpenTrace,
}: {
  vendor: WebClientVendor;
  stop: RealClientStop;
  isAdmin?: boolean;
  onSignInAgain?: () => void;
  onSendAgain?: () => void;
  onCopyAdminLink?: () => void;
  onRetry?: () => void;
  onOpenTrace?: () => void;
}) {
  const site = webClientSite(vendor);
  const action = (label: string, onClick?: () => void, primary = false) =>
    onClick ? (
      <Button
        key={label}
        type="button"
        size="sm"
        variant={primary ? "default" : "outline"}
        onClick={onClick}
      >
        {label}
      </Button>
    ) : null;
  let title: string;
  let body: ReactNode;
  let actions: ReactNode[];
  switch (stop.kind) {
    case "needs_sign_in":
      title = `${site} signed out ${stop.account}`;
      body = `${NOT_GRADED} ${
        isAdmin
          ? "Sign in again in the browser, then send your message again."
          : "Copy the link for a project admin, who can sign in again."
      }`;
      actions = isAdmin
        ? [
            action("Sign in again", onSignInAgain, true),
            action("Send again", onSendAgain),
          ]
        : [action("Copy link for an admin", onCopyAdminLink)];
      break;
    case "plan_limit":
      title = `${site} reached this account's usage limit`;
      body = (
        <>
          {stop.siteMessage ? (
            <p>
              {site} said “{stop.siteMessage}”
            </p>
          ) : null}
          <p>{`${NOT_GRADED} Send your message again once the limit resets.`}</p>
        </>
      );
      actions = [action("Send again", onSendAgain)];
      break;
    case "page_module":
      title = `MCPJam's ${webClientName(vendor)} driver couldn't complete “${stop.step}”`;
      body = `${stop.build ? `This happened on ${site} build ${stop.build}. ` : ""}${NOT_GRADED} Retry, or open the trace to see the page at that step.`;
      actions = [
        action("Retry", onRetry, true),
        action("Open trace", onOpenTrace),
      ];
      break;
  }
  const shown = actions.filter(Boolean);
  return (
    <Alert variant="warning" data-testid="real-client-notice">
      <CircleAlert aria-hidden />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription>
        {typeof body === "string" ? <p>{body}</p> : body}
        {shown.length ? (
          <div className="flex flex-wrap gap-2 pt-2">{shown}</div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
