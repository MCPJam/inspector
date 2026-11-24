import { useMemo, useState } from "react";
import { suiteReviewTargets, type SuiteRunReviewProps } from "../evaluate/suite-run-review";
import type { EvalSuite } from "../evals/types";
import { useAvailableModels } from "@/hooks/use-available-models";
import { ClimbList } from "./climb-list";
import { ClimbScreen } from "./climb-screen";
import { StartForm } from "./start-form";
import { useMockServers } from "./use-mock-servers";

type Selected = null | "new" | string;

/**
 * The suite's "Climb" tab: its climbs, the form that starts one, and a climb.
 * The environments' names are read once here, so every screen below says
 * "MCPJam · Sonnet 5.5" where a person set up an environment, never an id.
 */
export function SuiteClimbTab({
  projectId,
  suite,
  caseCount,
  environments,
  hostNamesById,
}: {
  projectId: string | null;
  suite: EvalSuite;
  caseCount: number;
  environments: SuiteRunReviewProps["environments"];
  hostNamesById: ReadonlyMap<string, string | null>;
}) {
  const [selected, setSelected] = useState<Selected>(null);
  const targets = useMemo(
    () =>
      suiteReviewTargets(suite, environments ?? [], hostNamesById).map((target) => ({
        id: target.id,
        label: `${target.client} · ${target.model}`,
      })),
    [suite, environments, hostNamesById],
  );
  const labels = useMemo(() => Object.fromEntries(targets.map((target) => [target.id, target.label])), [targets]);
  const { real } = useMockServers(projectId, true);
  const { availableModels } = useAvailableModels({ projectId });
  const models = useMemo(
    () => availableModels.map((model) => ({ id: String(model.id), name: model.name, disabled: model.disabled })),
    [availableModels],
  );

  if (!projectId) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Open this suite from a project to climb it.
      </p>
    );
  }
  if (selected === "new") {
    return (
      <div className="py-4">
        <StartForm
          projectId={projectId}
          suite={{ id: suite._id, name: suite.name }}
          caseCount={caseCount}
          servers={real}
          environments={targets.filter((target) => target.id !== "suite-default")}
          models={models}
          onStarted={(climb) => setSelected(climb.climbId)}
          onCancel={() => setSelected(null)}
        />
      </div>
    );
  }
  if (selected) {
    return (
      <ClimbScreen
        key={selected}
        projectId={projectId}
        climbId={selected}
        suiteName={suite.name}
        labels={labels}
        onBack={() => setSelected(null)}
      />
    );
  }
  return <ClimbList projectId={projectId} suiteId={suite._id} onOpen={setSelected} onStart={() => setSelected("new")} />;
}
