/**
 * The REWRITE-arm disclosure: this run deliberately rewrote a tool
 * description. Mirrors the skills-excluded pill on
 * `run-plugin-snapshot.tsx`.
 */
import { runDetailMetaLabelClass } from "../evals/run-detail-typography";

export function RunDescriptionOverrideDisclosure({
  toolName,
}: {
  toolName: string;
}) {
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2"
      data-testid="description-override-disclosure"
    >
      <span className={runDetailMetaLabelClass}>Description</span>
      <span
        className="inline-flex items-center rounded-md border border-border/60 px-2 py-0.5 text-[12px] text-muted-foreground"
        title="This run is the rewrite arm of a description experiment. The catalog snapshot is the original; the model saw a rewritten description."
      >
        this run deliberately rewrote the description of{" "}
        <span className="ml-1 font-mono text-foreground">`{toolName}`</span>
      </span>
    </div>
  );
}
