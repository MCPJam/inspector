import { Button } from "@mcpjam/design-system/button";
import { countOf } from "@/components/swarms/swarm-credit-cap";
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
  goalCredits,
  organizationId,
  "data-testid": testId,
}: {
  credits: number;
  max: number;
  /**
   * Conversations the swarm has now. Confirm passes it, so the notice talks
   * about launching and says what to cut above `max`; Describe has none yet.
   */
  count?: number;
  /** Goals are already created, so only iterations can change. */
  locked?: boolean;
  /** Every persona is already at one iteration. */
  iterationsAtMinimum?: boolean;
  /** What one goal costs across every environment, for the credits dialog. */
  goalCredits?: number | null;
  organizationId?: string | null;
  "data-testid": string;
}) {
  const notifyLimitHit = useMCPJamLimitDialogStore((s) => s.notifyLimitHit);
  const shownCredits = formatCredits(credits);
  const heading = `You have ${shownCredits} ${
    shownCredits === "1" ? "credit" : "credits"
  } left`;

  if (max === 0) {
    return (
      <SwarmInfoNotice
        heading={heading}
        body={
          count > 0
            ? `That isn't enough for one conversation, and this swarm has ${countOf(count, "conversation")}. Add credits to launch it.`
            : "That isn't enough for one conversation. Add credits to generate personas for this swarm."
        }
        action={
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() =>
              notifyLimitHit({
                surface: "swarm",
                userInitiated: true,
                // With some credits left this is a shortfall, and the dialog
                // must not lock MCPJam models everywhere else. With none left
                // it is the real exhaustion, and the lock is right.
                ...(credits > 0
                  ? {
                      shortfall: {
                        creditsRemaining: credits,
                        creditsRequired: Math.max(
                          credits + 1,
                          goalCredits ?? 0,
                        ),
                      },
                    }
                  : {}),
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
  const covers = `That covers up to ${countOf(max, "conversation")}`;
  const body =
    over <= 0
      ? `${covers}, the most you can run in this swarm.`
      : `${covers}, and this swarm has ${count}. ${
          !locked
            ? `Remove ${countOf(over, "conversation")} to continue.`
            : iterationsAtMinimum
              ? "Go back and start a new swarm with fewer goals."
              : "Lower iterations to continue."
        }`;
  return <SwarmInfoNotice heading={heading} body={body} data-testid={testId} />;
}
