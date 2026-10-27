import { Button } from "@mcpjam/design-system/button";
import { SwarmInfoNotice } from "@/components/swarms/swarm-production-notice";
import { formatCredits } from "@/hooks/use-run-cost-estimate";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

/**
 * Shown only while the credit cap limits the swarm. The heading repeats the
 * balance the sidebar shows; the body names the max, which also counts free
 * conversations, so the user can tell how many fit.
 */
export function SwarmCreditCapNotice({
  credits,
  max,
  count = 0,
  locked = false,
  iterationsAtMinimum = false,
  conversationCredits,
  organizationId,
  "data-testid": testId,
}: {
  credits: number;
  max: number;
  /** Conversations the swarm has now; above `max` the notice says what to cut. */
  count?: number;
  /** Goals are already created, so only iterations can change. */
  locked?: boolean;
  /** Every persona is already at one iteration. */
  iterationsAtMinimum?: boolean;
  /** What one conversation costs, for the credits dialog at `max` 0. */
  conversationCredits?: number | null;
  organizationId?: string | null;
  "data-testid": string;
}) {
  const notifyLimitHit = useMCPJamLimitDialogStore((s) => s.notifyLimitHit);
  const heading = `You have ${formatCredits(credits)} credits left`;

  if (max === 0) {
    return (
      <SwarmInfoNotice
        heading={heading}
        body="That isn't enough for one conversation. Add credits to generate personas for this swarm."
        action={
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() =>
              // Asked for, and with a shortfall: some credits may be left,
              // so the dialog must not lock MCPJam models everywhere else.
              notifyLimitHit({
                surface: "swarm",
                userInitiated: true,
                shortfall: {
                  creditsRemaining: credits,
                  creditsRequired: Math.max(
                    credits + 1,
                    conversationCredits ?? 0,
                  ),
                },
                ...(organizationId ? { organizationId } : {}),
              })
            }
          >
            Get more credits
          </Button>
        }
        data-testid={testId}
      />
    );
  }

  const over = count - max;
  const body =
    over <= 0
      ? `That covers up to ${max} conversations, the most you can run in this swarm.`
      : `That covers up to ${max} conversations, and this swarm has ${count}. ${
          !locked
            ? `Remove ${over} ${over === 1 ? "conversation" : "conversations"} to continue.`
            : iterationsAtMinimum
              ? "Go back and start a new swarm with fewer goals."
              : "Lower iterations to continue."
        }`;
  return <SwarmInfoNotice heading={heading} body={body} data-testid={testId} />;
}
