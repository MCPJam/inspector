import { Hammer, History } from "lucide-react";
import { createElement } from "react";
import type { PaneDescriptor, PaneId } from "./types";
import { PlaygroundLeft } from "@/components/ui-playground/PlaygroundLeft";
import { useAppBuilderStateContext } from "@/components/ui-playground/hooks/use-app-builder-state";

/**
 * Playground pane registry.
 *
 * `PaneSlot` skips any pane id it can't resolve in the registry, so a payload
 * referencing an unregistered id (e.g. an old saved view referencing a pane
 * that no longer exists) renders cleanly rather than throwing.
 *
 * - `tools`: renders the legacy `PlaygroundLeft` (tool list + parameters form
 *   + saved requests + logger) using state from `useAppBuilderStateContext`.
 *   This makes the docked tools pane behaviorally identical to the App Builder
 *   left sidebar — the multi-server-aware `ToolsPane` (display-only today)
 *   takes over once `useAppBuilderState` is extended to multi-server.
 * - `chatHistory`: placeholder; ChatHistoryRail port is a follow-up.
 * - `header`: layout-only concept, not a movable pane; not registered.
 */
const REGISTRY = new Map<PaneId, PaneDescriptor>();

REGISTRY.set("tools", {
  id: "tools",
  title: "Tools",
  icon: Hammer,
  defaultSide: "left",
  renderBody: () => createElement(ToolsPaneFromContext),
});

REGISTRY.set("chatHistory", {
  id: "chatHistory",
  title: "Chat History",
  icon: History,
  defaultSide: "left",
  // ChatHistoryRail port pending; placeholder so saved views can reference
  // the id without crashing.
  renderBody: () =>
    createElement(
      "div",
      {
        className:
          "flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground",
      },
      "Chat history (coming soon)",
    ),
});

function ToolsPaneFromContext() {
  const state = useAppBuilderStateContext();
  return createElement(PlaygroundLeft, {
    tools: state.tools,
    selectedToolName: state.selectedTool,
    fetchingTools: state.fetchingTools,
    onRefresh: state.fetchTools,
    onSelectTool: state.setSelectedTool,
    formFields: state.formFields,
    onFieldChange: state.updateFormField,
    onToggleField: state.updateFormFieldIsSet,
    isExecuting: state.isExecuting,
    onExecute: state.executeTool,
    onSave: state.savedRequestsHook.openSaveDialog,
    savedRequests: state.savedRequestsHook.savedRequests,
    highlightedRequestId: state.savedRequestsHook.highlightedRequestId,
    onLoadRequest: state.savedRequestsHook.handleLoadRequest,
    onRenameRequest: state.savedRequestsHook.handleRenameRequest,
    onDuplicateRequest: state.savedRequestsHook.handleDuplicateRequest,
    onDeleteRequest: state.savedRequestsHook.handleDeleteRequest,
    // The pane wrapper (SortablePane) already exposes an X to remove the pane
    // from the layout; suppressing PlaygroundLeft's own close button keeps the
    // UX consistent.
    onClose: undefined,
  });
}

export function getPane(id: PaneId): PaneDescriptor | undefined {
  return REGISTRY.get(id);
}

export function listPanes(): PaneDescriptor[] {
  return Array.from(REGISTRY.values());
}
