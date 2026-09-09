import type { MetadataSnapshot } from "./eval-tool-metadata";
import { useDescribeSurface } from "./describe-surface";
import {
  useLayoutEffect,
  useRef,
  useState,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { generateId } from "ai";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import {
  notifyEvalContextChanged,
  registerEvalDraft,
  type EvalDraft,
} from "./eval-workspace";
import { openEvalChat, useEvalAgentScopes } from "./eval-scope";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

export function useEvalAgentDraft<T extends EvalDraft>({
  projectId,
  suiteId,
  suiteName,
  caseId,
  draft,
  setDraft,
  tools,
  metadata,
  retryTools,
  autoOpen,
}: {
  projectId: string | null;
  suiteId: string;
  suiteName: string;
  caseId: string;
  draft: T | null;
  setDraft: Dispatch<SetStateAction<T | null>>;
  tools: unknown[];
  metadata?: MetadataSnapshot;
  retryTools?: (serverId?: string) => Promise<void>;
  autoOpen: boolean;
}) {
  const current = useRef({
    draft,
    tools,
    metadata,
    retryTools,
    revision: generateId(),
  });
  const undo = useRef<{ draft: T; expected: string } | null>(null);
  const [change, setChange] = useState<{
    fields: string[];
    revision: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (current.current.draft !== draft)
      current.current.revision = generateId();
    current.current.draft = draft;
    current.current.tools = tools;
    current.current.metadata = metadata;
    current.current.retryTools = retryTools;
    notifyEvalContextChanged();
  }, [draft, tools, metadata, retryTools]);
  const canRetryTools = retryTools != null;
  const hasCaseContent = Boolean(
    draft?.steps.some((step) => step.kind !== "prompt" || step.prompt.trim()),
  );
  const scope: EvalAgentScope = {
    kind: "evals",
    version: 1,
    id: "workspace",
    projectId: projectId ?? "",
    suiteId,
    suiteName,
    caseId,
    caseTitle: draft?.title,
    hasCaseContent,
  };
  useLayoutEffect(() => {
    if (!autoOpen || !projectId) return;
    useDescribeSurface.setState({ scope });
    return () => {
      useDescribeSurface.setState({ scope: null });
      useAgentPanelStore.getState().setOpen(false);
    };
  }, [autoOpen, projectId, suiteId, caseId]);
  const enteredDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !autoOpen) return;
    const panel = useAgentPanelStore.getState();
    const currentScope = panel.activeSessionId
      ? useEvalAgentScopes.getState().scopes[panel.activeSessionId]
      : undefined;
    if (
      autoOpen ||
      currentScope ||
      panel.activeSessionId?.startsWith("eval-")
    ) {
      const wasOpen = panel.isOpen;
      const identity = JSON.stringify([projectId, suiteId, caseId]);
      const fresh =
        caseId.startsWith("draft:") && enteredDraft.current !== identity;
      enteredDraft.current = identity;
      openEvalChat(
        {
          projectId,
          suiteId,
          suiteName,
          caseId,
          caseTitle: draft?.title,
          hasCaseContent,
        },
        { fresh },
      );
      if (!autoOpen) panel.setOpen(wasOpen);
    }
    // Open once per explicit case entry; typing/closing must not reopen the panel.
  }, [autoOpen, projectId, suiteId, caseId]);
  useEffect(() => {
    const sessionId = useAgentPanelStore.getState().activeSessionId;
    const selected = sessionId
      ? useEvalAgentScopes.getState().scopes[sessionId]
      : undefined;
    if (
      sessionId &&
      selected?.projectId === projectId &&
      selected.suiteId === suiteId &&
      selected.caseId === caseId &&
      (selected.caseTitle !== draft?.title ||
        selected.suiteName !== suiteName ||
        selected.hasCaseContent !== hasCaseContent)
    ) {
      useEvalAgentScopes.getState().set(sessionId, {
        ...selected,
        caseTitle: draft?.title,
        suiteName,
        hasCaseContent,
      });
    }
  }, [draft?.title, suiteName, projectId, suiteId, caseId, hasCaseContent]);
  useLayoutEffect(() => {
    if (!projectId) return;
    undo.current = null;
    setChange(null);
    const apply = (revision: string, patch?: Partial<EvalDraft>) => {
      const state = current.current;
      if (!state.draft || state.revision !== revision)
        throw new Error(
          "Draft changed since it was read. Read context again; no edits were applied.",
        );
      if (!patch && (!undo.current || undo.current.expected !== revision))
        throw new Error(
          "Cannot undo after another edit. Your current draft was preserved.",
        );
      const previous = state.draft;
      const next = patch ? { ...previous, ...patch } : undo.current!.draft;
      const nextRevision = generateId();
      undo.current = patch ? { draft: previous, expected: nextRevision } : null;
      // Update before React commits so consecutive tools cannot see stale data.
      state.draft = next;
      state.revision = nextRevision;
      flushSync(() => {
        setDraft(next);
        setChange(
          patch ? { fields: Object.keys(patch), revision: nextRevision } : null,
        );
      });
      return {
        status: patch ? "updated" : "undone",
        caseId,
        revision: nextRevision,
        changedFields: patch ? Object.keys(patch) : ["undo"],
        saved: false,
      };
    };
    return registerEvalDraft(scope, {
      read: () => {
        const state = current.current;
        if (!state.draft) throw new Error("Case draft is loading.");
        return {
          draft: {
            title: state.draft.title,
            steps: state.draft.steps,
            expectedOutput: state.draft.expectedOutput,
          },
          revision: state.revision,
          tools: state.tools,
          metadata: state.metadata,
        };
      },
      // Advertise retry only when the surface can actually do it; a no-op
      // button would promise recovery it cannot deliver.
      ...(canRetryTools
        ? {
            retryTools: (serverId?: string) =>
              current.current.retryTools?.(serverId) ??
              Promise.reject(new Error("Retrying tools is unavailable.")),
          }
        : {}),
      edit: (revision, patch) => apply(revision, patch),
      undo: (revision) => apply(revision),
    });
  }, [projectId, suiteId, caseId, setDraft, canRetryTools]);
  return {
    scope,
    change,
    canUndo: Boolean(
      change &&
      current.current.draft === draft &&
      change.revision === current.current.revision,
    ),
    open: () => {
      if (!projectId || !autoOpen) return;
      const identity = JSON.stringify([projectId, suiteId, caseId]);
      const fresh =
        caseId.startsWith("draft:") && enteredDraft.current !== identity;
      enteredDraft.current = identity;
      openEvalChat(
        {
          projectId,
          suiteId,
          suiteName,
          caseId,
          caseTitle: draft?.title,
          hasCaseContent,
        },
        { fresh },
      );
    },
  };
}
