/**
 * The bottom of the Confirm step: the conversation total, the sponsored split,
 * the last launch error and the Back / Continue row. The step decides every
 * number and passes `launchDisabled`. A launch-blocked reason is also
 * Continue's tooltip, so it disables Continue here too.
 */
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { DisabledReasonTooltip } from "@mcpjam/design-system/tooltip";
import { SwarmFundingSummary } from "@/components/swarms/swarm-funding-summary";
import type { SwarmFundingPreviewState } from "@/hooks/use-swarm-funding-preview";

export function NewSwarmConfirmFooter({
  personaTotal,
  environmentCount,
  reusedCount,
  conversationCount,
  fundingState,
  requestedRuns,
  pendingGoals,
  fundingNotice,
  errorMessage,
  launching,
  launchBlockedReason,
  launchDisabled,
  onBack,
  onContinue,
}: {
  personaTotal: number;
  /** At least 1; the equation names environments only when there are several. */
  environmentCount: number;
  reusedCount: number;
  conversationCount: number;
  fundingState: SwarmFundingPreviewState;
  requestedRuns: number;
  pendingGoals: number;
  fundingNotice: string | null;
  errorMessage: string | null;
  launching: boolean;
  /** Shown as Continue's tooltip; any reason also disables it. */
  launchBlockedReason: string | null;
  launchDisabled: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <>
      <div
        className="flex items-baseline justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3"
        data-testid="new-swarm-conversation-total"
      >
        <div>
          <p
            className="text-sm text-muted-foreground"
            data-testid="new-swarm-conversation-equation"
          >
            Across{" "}
            <strong className="font-semibold tabular-nums text-foreground">
              {personaTotal}
            </strong>{" "}
            {personaTotal === 1 ? "persona" : "personas"}
            {environmentCount > 1 ? (
              <>
                {" "}
                and{" "}
                <strong className="font-semibold tabular-nums text-foreground">
                  {environmentCount}
                </strong>{" "}
                environments
              </>
            ) : null}
          </p>
          {reusedCount > 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Reused goals are counted at the iterations already saved on them.
            </p>
          ) : null}
        </div>
        <p className="shrink-0 font-mono text-xl font-semibold tabular-nums">
          {conversationCount.toLocaleString()}
          <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">
            conversations
          </span>
        </p>
      </div>

      <SwarmFundingSummary
        state={fundingState}
        requestedRuns={requestedRuns}
        pendingGoals={pendingGoals}
        notice={fundingNotice}
      />

      {errorMessage ? (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-5 pt-2">
        <Button
          type="button"
          variant="ghost"
          disabled={launching}
          onClick={onBack}
        >
          Back
        </Button>
        <DisabledReasonTooltip reason={launchBlockedReason} variant="muted">
          <Button
            type="button"
            disabled={launchDisabled || launchBlockedReason !== null}
            data-testid="new-swarm-launch"
            onClick={onContinue}
          >
            {launching ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Launching…
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </DisabledReasonTooltip>
      </div>
    </>
  );
}
