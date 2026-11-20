import { Hand, MousePointer2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { webClientSite } from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/** What the page asked a person for. */
export type PersonAsk = "human_check" | "sign_in";

/**
 * A run waiting for a person, in the chat: what the page asked, who can
 * finish it, and how to go on. MCPJam never answers a human check itself, so
 * the run holds here instead of failing.
 */
export function RunPausedForPerson({
  vendor,
  ask,
  canFinish,
  onTakeOver,
  onCopyLink,
  onStop,
}: {
  vendor: WebClientVendor;
  ask: PersonAsk;
  /** Anyone in the project can finish a check; only an admin can sign in. */
  canFinish: boolean;
  onTakeOver: () => void;
  onCopyLink: () => void;
  onStop: () => void;
}) {
  const site = webClientSite(vendor);
  const check = ask === "human_check";
  const rows: Array<[string, string]> = [
    [
      "What the page asked",
      check
        ? `${site} is showing a “Verify you are human” check, which MCPJam leaves to a person.`
        : `${site} signed the account out and asked to sign in again.`,
    ],
    [
      "Who can finish it",
      check
        ? "Anyone in this project with the chat's link."
        : "A project admin, by signing in again in the browser.",
    ],
    [
      "How to go on",
      canFinish
        ? `Take over the browser, ${check ? "complete the check" : "sign in"}, then hand it back. The run continues where it paused.`
        : "Copy the link for a project admin. The run continues once they sign in.",
    ],
  ];
  return (
    <section
      aria-label="Paused for a person"
      data-testid="run-paused-for-person"
      className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-foreground"
    >
      <p className="flex items-center gap-2 font-medium">
        <Hand className="size-4 shrink-0" aria-hidden />
        Paused for a person
      </p>
      <dl className="space-y-2.5">
        {rows.map(([term, detail]) => (
          <div key={term} className="space-y-0.5">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {canFinish ? (
          <Button type="button" size="sm" onClick={onTakeOver}>
            <MousePointer2 aria-hidden />
            Take over
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onCopyLink}>
          {check ? "Copy link for a teammate" : "Copy link for an admin"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onStop}>
          Stop run
        </Button>
      </div>
    </section>
  );
}
