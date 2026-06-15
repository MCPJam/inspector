// @mcpjam/chat-ui — Tier A: read-only transcript renderer.
//
// Public surface: a provider-free renderer for AI SDK `UIMessage`s plus the
// supporting types and pure helpers. No Convex/PostHog/inspector/widget-runtime
// imports (enforced by scripts/check-no-tier-b-imports.mjs).

// --- Primary components ---
export {
  ReadOnlyTranscript,
  Transcript,
  type ReadOnlyTranscriptProps,
  type TranscriptProps,
} from "./read-only-transcript";
export { MessageView, type MessageViewProps } from "./message-view";
export { PartSwitch, type PartSwitchProps } from "./part-switch";
export { ToolCallPart, type ToolCallPartProps } from "./tool-call-part";
export { WidgetPlaceholder } from "./widget-placeholder";

// --- Part renderers (handy for custom layouts) ---
export { TextPart } from "./parts/text-part";
export { ReasoningPart } from "./parts/reasoning-part";
export { FilePart } from "./parts/file-part";
export { SourceUrlPart } from "./parts/source-url-part";
export { SourceDocumentPart } from "./parts/source-document-part";
export { JsonPart } from "./parts/json-part";
export { JsonView } from "./parts/json-view";
export { Markdown } from "./internal/markdown";

// --- Public types ---
export {
  DEFAULT_CHAT_UI_MODEL,
  type ChatUiModel,
  type ToolServerMap,
  type ToolRenderOverride,
  type OpenAiAppsCapabilities,
  type WidgetCsp,
  type WidgetPermissions,
  type ThemeMode,
  type WidgetPolicy,
  type ReasoningDisplayMode,
  type ToolRenderContext,
  type WidgetRenderInput,
} from "./types";

// --- Pure helpers (single-sourced for hosts that build messages/overrides) ---
export * from "./internal/thread-helpers";
export * from "./internal/widget-detection";
export * from "./internal/tool-result-utils";
export * from "./internal/safe-external-url";
export * from "./internal/persisted-execution-replay";
