/**
 * UI Playground Hooks
 *
 * Custom hooks for the UI Playground tab, extracted from
 * the main component to reduce complexity and improve testability.
 */

export { useServerKey, computeServerKey } from "./useServerKey";
export type {
  UseSavedRequestsOptions,
  UseSavedRequestsReturn,
  SaveDialogState,
} from "./useSavedRequests";
export { useSavedRequests } from "./useSavedRequests";
export type {
  UseToolExecutionOptions,
  UseToolExecutionReturn,
  PendingExecution,
} from "./useToolExecution";
export { useToolExecution } from "./useToolExecution";
export type {
  AppBuilderLoadingState,
  UseAppBuilderStateOptions,
  UseAppBuilderStateReturn,
} from "./use-app-builder-state";
export {
  APP_BUILDER_FIRST_RUN_PROMPT,
  AppBuilderStateProvider,
  useAppBuilderState,
  useAppBuilderStateContext,
  useOptionalAppBuilderStateContext,
} from "./use-app-builder-state";
