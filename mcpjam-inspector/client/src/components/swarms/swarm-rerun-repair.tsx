import { useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import {
  EnvironmentComposer,
  SWARM_COMPOSER_SLOTS,
} from "@/components/environment-composer/environment-composer";
import {
  emptyComposerState,
  stackFromEnvironment,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useAvailableModels } from "@/hooks/use-available-models";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { storedModelChoice } from "@/components/chat-v2/shared/model-selection";
import { NewSwarmJudgeRow } from "./new-swarm-judge-row";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";

export type RerunGoal = {
  runId: string;
  journeyRefId: string;
  name: string;
  updatedAt: number;
  hostIds: string[];
  serverAttachmentId?: string;
  environmentIds?: string[];
  config: { personaModel?: string };
  judgeConfig?: GoalJudgeConfig;
  problems: Array<{ dependency: string; label: string; reason: string }>;
};
const planRef = makeFunctionReference<
  "query",
  { projectId: string; runIds: string[] },
  RerunGoal[]
>("swarmReruns:plan");
const saveRef = makeFunctionReference<
  "mutation",
  {
    runId: string;
    journeyRefId: string;
    updatedAt: number;
    environmentIds?: string[];
    personaSelection?: ModelSelection;
    judgeConfig?: GoalJudgeConfig;
  },
  string
>("swarmReruns:save");

export function useSwarmRerunRepair(projectId: string | null) {
  const convex = useConvex();
  const [pending, setPending] = useState<{
    goal: RerunGoal;
    finish: (saved: boolean) => void;
  } | null>(null);
  const prepare = async (runIds: string[]): Promise<string[] | null> => {
    if (!projectId) throw new Error("Choose a project before running again.");
    let goals = await convex.query(planRef, { projectId, runIds });
    let blocked = goals.find((goal) => goal.problems.length > 0);
    while (blocked) {
      const goal = blocked;
      const saved = await new Promise<boolean>((finish) =>
        setPending({ goal, finish }),
      );
      setPending(null);
      if (!saved) return null;
      goals = await convex.query(planRef, { projectId, runIds });
      blocked = goals.find((next) => next.problems.length > 0);
    }
    return goals.map((goal) => goal.journeyRefId);
  };
  return {
    prepare,
    dialog:
      pending && projectId ? (
        <SwarmRerunRepairDialog
          key={pending.goal.journeyRefId}
          projectId={projectId}
          goal={pending.goal}
          onDone={pending.finish}
        />
      ) : null,
  };
}

export function SwarmRerunRepairDialog({
  projectId,
  goal,
  onDone,
}: {
  projectId: string;
  goal: RerunGoal;
  onDone: (saved: boolean) => void;
}) {
  const convex = useConvex();
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const resolve = useComposerResolver(projectId, {
    requireServerAttachment: true,
    allowEmptyServerSelection: false,
  });
  const models = useAvailableModels({ projectId });
  const [target, setTarget] = useState<EnvironmentComposerState | null>(null);
  const [personaSelection, setPersonaSelection] = useState<ModelSelection>();
  const [judgeConfig, setJudgeConfig] = useState(goal.judgeConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetBlocked = goal.problems.some(
    (p) => p.dependency === "target" || p.dependency === "runtime",
  );
  const personaBlocked = goal.problems.some((p) => p.dependency === "persona");
  const judgeBlocked = goal.problems.some((p) => p.dependency === "judge");
  const selectedEnvironment = environments?.find(
    (env) => env.environmentId === goal.environmentIds?.[0],
  );
  const initialTarget: EnvironmentComposerState = {
    ...emptyComposerState(),
    environmentIds: goal.environmentIds ?? [],
    stack: selectedEnvironment
      ? stackFromEnvironment(selectedEnvironment)
      : {
          ...emptyComposerState().stack,
          hostIds: goal.hostIds,
          serverAttachmentId: goal.serverAttachmentId ?? null,
        },
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const resolved =
        targetBlocked && target
          ? await resolve({
              state: target,
              liveEnvironments: environments ?? [],
              max: 10,
            })
          : undefined;
      if (resolved?.skipped.length)
        throw new Error(
          "Some targets cannot use that model. Choose a model supported by every selected client.",
        );
      const environmentIds = resolved?.environmentIds;
      await convex.mutation(saveRef, {
        runId: goal.runId,
        journeyRefId: goal.journeyRefId,
        updatedAt: goal.updatedAt,
        ...(environmentIds ? { environmentIds } : {}),
        ...(personaSelection ? { personaSelection } : {}),
        ...(judgeBlocked && judgeConfig ? { judgeConfig } : {}),
      });
      onDone(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save replacements. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onDone(false);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose approved models to run again</DialogTitle>
          <DialogDescription>
            Save replacements for this swarm. Past results and other swarms keep
            their models.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{goal.name}</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {goal.problems.map((problem, index) => (
            <li key={index}>
              <strong>{problem.label}</strong>: {problem.reason}
            </li>
          ))}
        </ul>
        {targetBlocked ? (
          <EnvironmentComposer
            projectId={projectId}
            environments={environments ?? []}
            value={target ?? initialTarget}
            onChange={setTarget}
            slots={SWARM_COMPOSER_SLOTS}
            maxTargets={10}
            disabled={busy || environments === undefined}
            inModal
          />
        ) : null}
        {personaBlocked && models.availableModels.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm">
              Simulated user model
              {goal.config.personaModel ? ` · ${goal.config.personaModel}` : ""}
            </p>
            <ModelSelector
              inModal
              onAddProvider={models.onAddProvider}
              availableModels={models.availableModels}
              currentModel={
                models.availableModels.find(
                  (model) => model.id === personaSelection?.modelId,
                ) ?? models.availableModels[0]
              }
              onModelChange={(model) =>
                setPersonaSelection(
                  storedModelChoice(model, undefined, "persona").selection,
                )
              }
              disabled={busy}
            />
          </div>
        ) : null}
        {personaBlocked && models.availableModels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No organization models are available. Ask an organization admin to
            add a provider.
          </p>
        ) : null}
        {judgeBlocked ? (
          <NewSwarmJudgeRow
            inModal
            projectId={projectId}
            value={judgeConfig}
            onChange={setJudgeConfig}
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onDone(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              (targetBlocked && !target) ||
              (personaBlocked && !personaSelection)
            }
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save replacements"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
