import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import { Button } from "@mcpjam/design-system/button";
import { useAvailableModels } from "@/hooks/use-available-models";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import {
  findModelForStoredChoice,
  modelSelectionFromDefinition,
} from "@/components/chat-v2/shared/model-selection";
import { toast } from "@/lib/toast";

type ModelStatus = {
  modelId: string;
  selection?: ModelSelection;
  readiness: { ready: boolean; code?: string };
  canEdit: boolean;
};
const statusQuery = makeFunctionReference<
  "query",
  { scenarioId: string },
  ModelStatus | null
>("scenarioModels:status");
const repairMutation = makeFunctionReference<
  "mutation",
  { scenarioId: string; selection: ModelSelection },
  { saved: boolean }
>("scenarioModels:repair");

export function ScenarioModelEditor({
  scenarioId,
  projectId,
}: {
  scenarioId: string;
  projectId: string;
}) {
  const status = useQuery(statusQuery, { scenarioId });
  const repair = useMutation(repairMutation);
  const [picked, setPicked] = useState<ModelDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const { availableModels, pending, onManageOrgProviders, onAddProvider } =
    useAvailableModels({ projectId });
  const orgModels = availableModels.filter((model) => model.orgProvider);
  if (!status) return null;
  const current =
    picked ??
    findModelForStoredChoice(
      { modelId: status.modelId, selection: status.selection },
      orgModels,
      undefined,
      { exactSelection: true },
    );
  async function save() {
    if (!picked || saving) return;
    const selection = modelSelectionFromDefinition(picked, undefined, "chat");
    if (!selection || selection.source !== "org") return;
    setSaving(true);
    try {
      await repair({ scenarioId, selection });
      setPicked(null);
      toast.success("Study model saved.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save this study's model. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-xl border border-border p-4"
      aria-label="Study model"
    >
      <h2 className="text-sm font-medium">Study model</h2>
      <p className="text-xs text-muted-foreground">
        {status.readiness.ready
          ? "This model is saved for everyone who opens this study."
          : "This study's model cannot run with its current connection. An owner or editor must choose an approved organization model."}
      </p>
      <p className="text-xs text-muted-foreground">
        Current model: {status.modelId}
      </p>
      {status.canEdit ? (
        <div className="flex items-center gap-2">
          <ModelSelector
            currentModel={
              current ?? {
                id: status.modelId,
                name: status.modelId,
                provider: "unknown",
              }
            }
            availableModels={orgModels}
            requireOrgKeys
            onManageOrgProviders={onManageOrgProviders}
            onAddProvider={onAddProvider}
            onModelChange={setPicked}
            disabled={pending || saving}
          />
          <Button
            size="sm"
            disabled={!picked || pending || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save model"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
