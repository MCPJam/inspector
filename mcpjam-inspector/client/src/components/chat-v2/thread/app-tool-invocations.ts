/**
 * app-tool-invocations.ts — back-compat re-export shim.
 *
 * The app-tool invocation lifecycle types now live in
 * `@mcpjam/sdk/widget-runtime` (Tier B Phase 2) so the host bridge that emits
 * them and the inspector renderer UI that displays them share one definition.
 * This file preserves the existing
 * `@/components/chat-v2/thread/app-tool-invocations` import path used across the
 * thread renderer (transcript, replay, parts, message-view, part-switch).
 */

export type {
  AppToolInvocation,
  AppToolInvocationStatus,
  AppToolInvocationUpdate,
} from "@mcpjam/sdk/widget-runtime";
