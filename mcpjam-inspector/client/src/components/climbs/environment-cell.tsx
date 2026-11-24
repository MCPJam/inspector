import { Check, Minus, X } from "lucide-react";
import type { PlatformClimbMeasure } from "@mcpjam/sdk/platform";
import { Card } from "@mcpjam/design-system/card";
import { MEASURE_NAMES, measureTitle, percent, ratioChange } from "./climb-format";
import { COPY } from "./climb-copy";
import { environmentTone, type RoundEnvironment } from "./round-verdict";

const TONE_WORD = { better: COPY.better, worse: COPY.worse, same: COPY.noChange, none: "Not compared" } as const;

function Row({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{name}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

type Moved = { bestBps: number; candidateBps: number } | undefined;
const fromTo = (rate: Moved) => (rate ? `${percent(rate.bestBps)} → ${percent(rate.candidateBps)}` : "No numbers");

/**
 * One environment of a round: whether it got better or worse, then the
 * measure (when the climb is not for pass rate), pass rate and validation, each
 * as the best so far and then this change. Validation is a total, never a case.
 */
export function EnvironmentCell({
  name,
  env,
  measure,
}: {
  name: string;
  env: RoundEnvironment | undefined;
  measure: PlatformClimbMeasure;
}) {
  const tone = env ? environmentTone(env, measure) : "none";
  return (
    <Card className="gap-1.5 px-4 py-3 shadow-none" data-testid="environment-cell">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{name}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {tone === "better" ? (
            <Check className="size-3 text-success" aria-hidden />
          ) : tone === "worse" ? (
            <X className="size-3 text-destructive" aria-hidden />
          ) : tone === "same" ? (
            <Minus className="size-3" aria-hidden />
          ) : null}
          {TONE_WORD[tone]}
        </span>
      </div>
      {env?.steering ? (
        <div className="text-sm tabular-nums">
          {measure !== "pass_rate" && env.steering.measure ? (
            <Row name={measureTitle(measure)} value={ratioChange(env.steering.measure.ratioBps)} />
          ) : null}
          <Row name="Pass rate" value={fromTo(env.steering.passRate)} />
          <Row name="Validation" value={fromTo(env.validation?.passRate)} />
          {env.candidateLost > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {env.candidateLost} {env.candidateLost === 1 ? "iteration" : "iterations"} lost to the model provider.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          {measure === "pass_rate" ? "No numbers to compare" : `No ${MEASURE_NAMES[measure]} to compare`}
        </div>
      )}
    </Card>
  );
}
