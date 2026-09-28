import { Badge } from "@mcpjam/design-system/badge";
import type { EvalSuiteRun } from "./types";

export function RunMetadataDisplay({ run }: { run: EvalSuiteRun }) {
  if (
    !run.name &&
    !run.tags?.length &&
    !run.runMetadata &&
    !run.runEvaluationsByCase?.length
  )
    return null;
  return (
    <section
      aria-label="Run metadata"
      className="mb-4 space-y-2 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-medium">
        {run.name || `Run #${run.runNumber}`}
      </h3>
      {!!run.tags?.length && (
        <div className="flex flex-wrap gap-1">
          {run.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      )}
      {run.runMetadata && (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          {Object.entries(run.runMetadata).map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-words">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {run.runEvaluationsByCase?.map((envelope) => (
        <div key={envelope.caseId} className="space-y-1 text-xs">
          <p className="font-medium">
            {envelope.caseId} — consistency observations (advisory)
          </p>
          {envelope.results.map((result) => {
            const observation = envelope.observations.find(
              (row) => row.definitionHash === result.definitionHash,
            );
            return (
              <p key={result.definitionHash}>
                {result.evaluatorId}:{" "}
                {result.status === "scored"
                  ? result.score?.toFixed(3)
                  : result.status}{" "}
                · {observation?.eligibleIterations ?? 0}/
                {envelope.evidence.totalIterations} eligible iterations
              </p>
            );
          })}
        </div>
      ))}
    </section>
  );
}
