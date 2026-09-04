/**
 * Whether the judge may DECIDE a run, and the evidence that says it may.
 *
 * THE PROBLEM THIS SOLVES. A judge that can fail a build is a judge somebody
 * has to trust, and until now the page offered no way to earn that trust or to
 * see whether it had been earned. The backend has the whole answer — how many
 * blind reviewer labels agree with the judge on its CURRENT rubric and template
 * version, whether that clears the bar, and whether an organization owner has
 * acknowledged the gap — and this renders it.
 *
 * NOTHING IS COMPUTED HERE. `agreement.rate` is `null` at zero reviews, which
 * is "no evidence" and not "0% agreement"; deriving a rate in the browser is
 * how 0/0 becomes a number. The switch's eligibility is `agreement.eligible`
 * as the server decided it, beside the acknowledgement it decided too.
 *
 * THE SWITCH IS NEVER HIDDEN. A deployment that does not run the gate renders
 * it disabled, saying so — hiding it makes "this deployment cannot gate" and
 * "this suite is not calibrated" the same empty space, which is the failure S3
 * exists to stop.
 */

import { useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { DEPLOYMENT_REASON_COPY } from "./capability-reasons";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "./types";

/** The longest reason the backend will store, mirrored so the UI refuses first. */
export const MAX_GATE_ACKNOWLEDGEMENT_REASON = 500;

/**
 * The agreement line, rendered from SERVER FIELDS ONLY.
 *
 * `rate === null` is the case worth naming: at zero reviews there is no
 * agreement rate, and "0%" would report a judge that disagrees with every
 * reviewer rather than one nobody has reviewed.
 */
export function describeAgreement(
  agreement: SuiteCapabilities["judge"]["agreement"] | undefined,
): string {
  if (!agreement || agreement.rate === null) return "No reviewer labels yet";
  const base = `Agrees with reviewers ${agreement.agreements}/${agreement.reviews} · ${Math.round(
    agreement.rate * 100,
  )}%`;
  return agreement.lowerBound === null
    ? base
    : `${base} (at least ${Math.round(agreement.lowerBound * 100)}% likely)`;
}

/**
 * Why the gate switch cannot be used, or `undefined` when it can.
 *
 * Two refusals, and they are not interchangeable. The DEPLOYMENT one is about
 * the environment and no amount of reviewing changes it; the CALIBRATION one is
 * about this suite and names exactly what would clear it.
 */
export function gateSwitchDisabledReason(
  judge: SuiteCapabilities["judge"] | undefined,
): string | undefined {
  if (!judge) return "Checking whether this deployment allows judge gating…";
  if (!judge.gating.enabled) return DEPLOYMENT_REASON_COPY;
  if (judge.agreement.eligible || judge.acknowledgement?.current) {
    return undefined;
  }
  return `Needs ${judge.agreement.minReviews} blind reviewer labels agreeing at ${Math.round(
    judge.agreement.threshold * 100,
  )}% or better`;
}

export function JudgeGatePanel({
  suiteId,
  judge,
  judgeConfig,
  onJudgeConfigChange,
  onAcknowledged,
}: {
  suiteId: string;
  /** From `useSuiteCapabilities`; absent while it loads or is unavailable. */
  judge: SuiteCapabilities["judge"] | undefined;
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  /** Re-read capabilities after an acknowledgement lands. */
  onAcknowledged?: () => void;
}) {
  const [ackOpen, setAckOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isAcknowledging, setIsAcknowledging] = useState(false);

  const acknowledgeJudgeGate = useMutation(
    "evalJudgeReviews:acknowledgeJudgeGate" as never,
  ) as unknown as (args: {
    suiteId: string;
    reason: string;
  }) => Promise<unknown>;

  const disabledReason = gateSwitchDisabledReason(judge);
  // From the DRAFT, so the switch reflects what a save would write rather than
  // what the server currently holds — the same rule every other control here
  // follows.
  const isGating = judgeConfig?.goalCompletion?.role === "gating";
  // The acknowledgement escape hatch is offered whenever calibration is the
  // blocker. There is no permission bit for it: the backend refuses a caller
  // who is not an organization owner, and rendering that refusal is more
  // honest than guessing at rank in the client.
  const canOfferAcknowledgement =
    judge?.gating.enabled === true &&
    !judge.agreement.eligible &&
    !judge.acknowledgement?.current;

  const submitAcknowledgement = async () => {
    setIsAcknowledging(true);
    try {
      await acknowledgeJudgeGate({ suiteId, reason: reason.trim() });
      setAckOpen(false);
      setReason("");
      toast.success("Gate acknowledged for this rubric");
      onAcknowledged?.();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not acknowledge the judge gate",
      );
    } finally {
      setIsAcknowledging(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="judge-gate-panel">
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="judge-agreement"
      >
        {describeAgreement(judge?.agreement)}
      </p>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-foreground">
            {isGating ? "Gate" : "Advisory"}
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            {isGating
              ? "The judge's verdict can fail a run. It only ever makes a run stricter."
              : "The judge scores alongside the verdict and never changes it."}
          </p>
          {disabledReason ? (
            <p
              className="mt-0.5 text-[11px] text-muted-foreground"
              data-testid="judge-gate-disabled-reason"
            >
              {disabledReason}
            </p>
          ) : null}
          {judge?.acknowledgement?.current ? (
            <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
              Gating on an owner&apos;s acknowledgement rather than on
              calibration.
            </p>
          ) : null}
        </div>
        <Switch
          checked={isGating}
          disabled={disabledReason !== undefined}
          aria-label="Let the judge decide pass or fail"
          onCheckedChange={(checked) =>
            onJudgeConfigChange({
              ...judgeConfig,
              goalCompletion: {
                ...(judgeConfig?.goalCompletion ?? {}),
                role: checked ? "gating" : "advisory",
              },
            })
          }
        />
      </div>
      {canOfferAcknowledgement ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setAckOpen(true)}
        >
          Acknowledge and gate anyway…
        </Button>
      ) : null}

      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Gate without calibration</DialogTitle>
            <DialogDescription>
              This lets an uncalibrated judge fail runs of this suite. It
              applies to the rubric as it is now — editing the criteria retires
              it.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Reason (required)</span>
            <textarea
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
              rows={3}
              value={reason}
              maxLength={MAX_GATE_ACKNOWLEDGEMENT_REASON}
              aria-label="Why gate without calibration"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            Stored with your name, not redacted.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAckOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={reason.trim().length === 0 || isAcknowledging}
              onClick={() => void submitAcknowledgement()}
            >
              Acknowledge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
