import { useState } from "react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  orgAiModelSelectionKey,
  orgAiModelsOf,
  useOrgAiConfig,
  type OrgAiModelKind,
  type OrgAiModelTestResult,
} from "@/hooks/useOrgAiConfig";
import type { DefaultModelRowActions } from "./OrganizationDefaultModelRow";

/** An embedding model change waiting for the admin to confirm it. */
export type PendingEmbeddingChange = {
  selection: ModelSelection | null;
  onSaved?: () => void;
};

function sameSelection(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return orgAiModelSelectionKey(a) === orgAiModelSelectionKey(b);
}

/**
 * The card's saving and testing: which row is being edited, which is being
 * tested, and an embedding model change waiting to be confirmed.
 */
export function useDefaultModelActions(organizationId: string) {
  const {
    config,
    unsupported,
    error,
    isSaving,
    testError,
    isTesting,
    setAiModel,
    testAiModel,
  } = useOrgAiConfig(organizationId);

  const [editingKind, setEditingKind] = useState<OrgAiModelKind | null>(null);
  const [testingKind, setTestingKind] = useState<OrgAiModelKind | null>(null);
  const [pendingEmbeddingChange, setPendingEmbeddingChange] =
    useState<PendingEmbeddingChange | null>(null);

  const aiModels = unsupported ? null : orgAiModelsOf(config);

  const commit = async (
    kind: OrgAiModelKind,
    selection: ModelSelection | null,
    onSaved?: () => void,
  ) => {
    try {
      await setAiModel(kind, selection);
      onSaved?.();
    } catch {
      // The hook keeps the backend's message for the card's alert.
      console.debug(
        "[organization-ai-models] Save failed; the settings alert contains the error.",
      );
    }
  };

  /**
   * Save, unless the embedding model changes: vectors from two embedding
   * models are never compared, so that change is confirmed first.
   */
  const requestSave = (
    kind: OrgAiModelKind,
    selection: ModelSelection | null,
    onSaved?: () => void,
  ) => {
    if (
      kind === "embedding" &&
      !sameSelection(selection, aiModels?.models.embedding?.selection)
    ) {
      setPendingEmbeddingChange({ selection, onSaved });
      return;
    }
    void commit(kind, selection, onSaved);
  };

  const runTest = async (
    kind: OrgAiModelKind,
    candidate?: ModelSelection,
  ): Promise<OrgAiModelTestResult | undefined> => {
    setTestingKind(kind);
    try {
      return await testAiModel(kind, candidate);
    } catch {
      // The hook keeps the message for the card's alert.
      console.debug(
        "[organization-ai-models] Test failed; the settings alert contains the error.",
      );
      return undefined;
    } finally {
      setTestingKind(null);
    }
  };

  const actionsFor = (kind: OrgAiModelKind): DefaultModelRowActions => ({
    onEdit: () => setEditingKind(kind),
    onCancelEdit: () => setEditingKind(null),
    onTestSaved: () => void runTest(kind),
    onTestCandidate: (candidate) => runTest(kind, candidate),
    onSave: (next) => requestSave(kind, next, () => setEditingKind(null)),
    onUseSuggestion: (next) => requestSave(kind, next),
    onClear: () => requestSave(kind, null),
  });

  return {
    config,
    aiModels,
    error,
    isSaving,
    testError,
    isTesting,
    editingKind,
    testingKind,
    pendingEmbeddingChange,
    actionsFor,
    dismissEmbeddingChange: () => setPendingEmbeddingChange(null),
    confirmEmbeddingChange: (pending: PendingEmbeddingChange) =>
      void commit("embedding", pending.selection, pending.onSaved).finally(() =>
        setPendingEmbeddingChange(null),
      ),
  };
}
