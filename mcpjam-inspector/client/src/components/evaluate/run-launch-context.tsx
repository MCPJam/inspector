/**
 * What this run launched against — client or environment, model, servers.
 *
 * The header used to show only a host chip ("Claude"). A host is not an
 * environment: the model lives on the run or its iterations, and the MCP
 * servers live on the frozen config snapshot. Each fact is labelled so none
 * of them can be mistaken for leftover chrome.
 */
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { compactModelIdTail } from "@/lib/environment-label";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { HostChip } from "@/components/hosts/host-chip";
import {
  runEnvironmentRef,
  runHostLabel,
  runRevisionLabel,
} from "../evals/helpers";
import { EnvironmentChip } from "../evals/run-context-chip";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-[12.5px] text-foreground">
        {children}
      </dd>
    </div>
  );
}

export function modelsFromRun(
  run: EvalSuiteRun,
  iterations: readonly EvalIteration[] = [],
): string[] {
  if (run.effectiveModelId) {
    return [compactModelIdTail(run.effectiveModelId)];
  }
  const models = new Set<string>();
  for (const iteration of iterations) {
    const raw = iteration.testCaseSnapshot?.model?.trim();
    if (!raw) continue;
    const labelled = compactModelLabel(raw);
    models.add(compactModelIdTail(labelled || raw));
  }
  return [...models];
}

export function RunLaunchContext({
  run,
  hostNamesById,
  iterations,
}: {
  run: EvalSuiteRun;
  hostNamesById: Map<string, string | null>;
  iterations?: readonly EvalIteration[];
}) {
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const environmentRef = projectEnvironmentsEnabled
    ? runEnvironmentRef(run)
    : null;
  const client = runHostLabel(run, hostNamesById);
  const models = modelsFromRun(run, iterations);
  const servers = run.configSnapshot?.environment?.servers ?? [];

  if (
    !environmentRef &&
    !client &&
    models.length === 0 &&
    servers.length === 0
  ) {
    return null;
  }

  return (
    <dl
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1"
      data-testid="evaluate-run-launch-context"
    >
      {environmentRef ? (
        <Fact label="Environment">
          <EnvironmentChip
            name={environmentRef.name}
            environmentId={environmentRef.environmentId}
            revisionLabel={runRevisionLabel(run)}
            className="border-0 bg-transparent px-0 py-0"
          />
        </Fact>
      ) : client ? (
        <Fact label="Client">
          <HostChip
            name={client}
            hostId={run.namedHostId}
            className="gap-1 px-0 py-0 text-[12.5px] shadow-none"
          />
        </Fact>
      ) : null}
      {models.length > 0 ? (
        <Fact label={models.length === 1 ? "Model" : "Models"}>
          {models.join(" · ")}
        </Fact>
      ) : null}
      {servers.length > 0 ? (
        <Fact label={servers.length === 1 ? "Server" : "Servers"}>
          <span data-testid="evaluate-run-servers">{servers.join(" · ")}</span>
        </Fact>
      ) : null}
    </dl>
  );
}
