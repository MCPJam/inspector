/**
 * Shared chrome for the two suite judge slots.
 *
 * Goal completion authors model, threshold, rubric, agreement and the gate.
 * Groundedness displays stored run evidence — or an honest not-yet-run state —
 * and mounts no configuration controls. The selected judge's own template and
 * calibration come from C1 capabilities; an older backend leaves those null
 * rather than copying goal completion's identity onto groundedness.
 */

import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { JudgesSection } from "./judges-section";
import type { JudgeSlot } from "./suite-scorer-table-model";
import type { EvalJudgeConfig, EvalSuiteRun } from "./types";
import type { ModelDefinition } from "@/shared/types";

export const GROUNDEDNESS_UNAVAILABLE_COPY =
  "Groundedness runs on demand. Configuration controls are not available yet.";

export type GroundednessRunEvidence = {
  result: EvalSuiteRun["groundedness"] | null;
  pending: boolean;
};

export function SuiteJudgeCard({
  slot,
  judgeConfig,
  onJudgeConfigChange,
  availableModels,
  judgesCapabilities,
  judgeAccessory,
  rubricEditor,
  groundednessEvidence,
}: {
  slot: JudgeSlot;
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
  judgesCapabilities?: SuiteCapabilities["judges"];
  judgeAccessory?: React.ReactNode;
  rubricEditor?: React.ReactNode;
  groundednessEvidence?: GroundednessRunEvidence;
}) {
  if (slot === "groundedness") {
    return (
      <GroundednessJudgeCard
        judgesCapabilities={judgesCapabilities}
        evidence={groundednessEvidence}
      />
    );
  }
  return (
    <GoalCompletionJudgeCard
      judgeConfig={judgeConfig}
      onJudgeConfigChange={onJudgeConfigChange}
      availableModels={availableModels}
      judgesCapabilities={judgesCapabilities}
      judgeAccessory={judgeAccessory}
      rubricEditor={rubricEditor}
    />
  );
}

function GoalCompletionJudgeCard({
  judgeConfig,
  onJudgeConfigChange,
  availableModels,
  judgesCapabilities,
  judgeAccessory,
  rubricEditor,
}: {
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
  judgesCapabilities?: SuiteCapabilities["judges"];
  judgeAccessory?: React.ReactNode;
  rubricEditor?: React.ReactNode;
}) {
  const template = judgesCapabilities?.goalCompletion.template;
  return (
    <section
      className="space-y-4"
      data-testid="suite-judge-card-goalCompletion"
      data-judge-slot="goalCompletion"
    >
      <TemplateLine
        slot="goalCompletion"
        template={template ?? null}
        capabilityPresent={judgesCapabilities?.goalCompletion != null}
      />
      <JudgesSection
        chrome="bare"
        value={judgeConfig}
        availableModels={availableModels}
        onChange={onJudgeConfigChange}
      />
      {judgeAccessory}
      {rubricEditor ? (
        <div className="space-y-2" data-setting-key="judgeRubric">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              Judge criteria
            </h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Applied to every case, alongside each case&apos;s own expected
              output. The judge cites criterion ids in its reasons.
            </p>
          </div>
          {rubricEditor}
        </div>
      ) : null}
    </section>
  );
}

function GroundednessJudgeCard({
  judgesCapabilities,
  evidence,
}: {
  judgesCapabilities?: SuiteCapabilities["judges"];
  evidence?: GroundednessRunEvidence;
}) {
  const result = evidence?.result ?? null;
  const pending = evidence?.pending === true;
  const hasC1 = judgesCapabilities?.groundedness != null;
  const template = hasC1 ? judgesCapabilities.groundedness.template : null;

  return (
    <section
      className="space-y-3 rounded-md border border-border/50 bg-muted/10 px-3 py-3"
      data-testid="suite-judge-card-groundedness"
      data-judge-slot="groundedness"
      data-setting-key="judgeGroundedness"
    >
      <div>
        <h4 className="text-sm font-semibold text-foreground">Groundedness</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {GROUNDEDNESS_UNAVAILABLE_COPY}
        </p>
      </div>
      <TemplateLine
        slot="groundedness"
        template={template}
        capabilityPresent={hasC1}
      />
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="suite-judge-agreement-groundedness"
      >
        Calibration unavailable
      </p>
      {pending ? (
        <p className="text-xs text-muted-foreground">
          Checking claims against tool evidence…
        </p>
      ) : result ? (
        <dl className="space-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="sr-only">Model</dt>
            <dd data-testid="groundedness-run-model">{result.modelUsed}</dd>
          </div>
          <div>
            <dt className="sr-only">Threshold</dt>
            <dd data-testid="groundedness-run-threshold">{result.threshold}</dd>
          </div>
          {result.summary.trim() ? (
            <div>
              <dt className="sr-only">Summary</dt>
              <dd data-testid="groundedness-run-summary">{result.summary}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="groundedness-not-yet-run"
        >
          Not run yet
        </p>
      )}
    </section>
  );
}

function TemplateLine({
  slot,
  template,
  capabilityPresent,
}: {
  slot: JudgeSlot;
  template: { version: number; hash: string } | null;
  capabilityPresent: boolean;
}) {
  const label = !capabilityPresent
    ? "Template unavailable on this deployment"
    : template
      ? `Template v${template.version}`
      : "No template yet";
  return (
    <p
      className="text-[11px] text-muted-foreground"
      data-testid={`suite-judge-template-${slot}`}
    >
      {label}
    </p>
  );
}
