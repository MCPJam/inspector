import type { ReactNode } from "react";
import type { UIMessage } from "@ai-sdk/react";

import { cn } from "./internal/cn";
import { MessageView } from "./message-view";
import { getRenderableConversationMessages } from "./internal/thread-helpers";
import {
  DEFAULT_CHAT_UI_MODEL,
  type ChatUiModel,
  type JsonRenderer,
  type ReasoningDisplayMode,
  type ThemeMode,
  type ToolRenderContext,
  type ToolRenderOverride,
  type ToolServerMap,
  type WidgetPolicy,
  type WidgetRenderInput,
} from "./types";

// Hoisted so the defaults keep a STABLE identity. As inline `= {}` defaults
// these were rebuilt on every render, which defeated `MessageView`'s shallow
// `memo` for every message in the transcript — the same failure the
// `renderTurnFooter` seam takes care to avoid by passing its index as a
// separate prop rather than closing over it.
const EMPTY_TOOLS_METADATA: Record<string, Record<string, unknown>> = {};
const EMPTY_TOOL_SERVER_MAP: ToolServerMap = {};

function themeClass(themeMode: ThemeMode): string | undefined {
  if (themeMode === "dark") return "dark";
  if (themeMode === "light") return "light";
  // "system" emits no class: the transcript inherits the host theme (whether a
  // `.dark` ancestor is present). Explicit "light"/"dark" override the host.
  return undefined;
}

export interface TranscriptProps {
  messages: UIMessage[];
  model?: ChatUiModel;
  toolsMetadata?: Record<string, Record<string, unknown>>;
  toolServerMap?: ToolServerMap;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  themeMode?: ThemeMode;
  reasoningDisplayMode?: ReasoningDisplayMode;
  widgetPolicy?: WidgetPolicy;
  className?: string;
  /**
   * See `MessageViewProps.showAssistantAvatar`. Defaults to whether
   * `renderAvatar` was supplied; deliberately NOT defaulted here, so the
   * resolution lives in one place.
   */
  showAssistantAvatar?: boolean;
  renderAvatar?: (model: ChatUiModel | undefined) => ReactNode;
  /** Host override for the tool block (inspector interactive `ToolPart`). */
  renderTool?: (ctx: ToolRenderContext) => ReactNode;
  /** Host override for widget rendering (inspector `WidgetReplay`). */
  renderWidget?: (input: WidgetRenderInput) => ReactNode;
  /**
   * Host override for how a tool's JSON payloads are DISPLAYED — the
   * inspector passes the collapsible tree its Playground uses.
   *
   * Unlike `renderTool` and `renderWidget` this survives into
   * `ReadOnlyTranscriptProps`, because it is a different kind of seam: it
   * swaps one presentation of a value for another and can do nothing else.
   * See {@link JsonRenderer}, and the read-only contract below.
   */
  renderJson?: JsonRenderer;
  /**
   * Host slot under each assistant message (per-turn ratings).
   *
   * `index` is the position in the VISIBLE array — what
   * `getRenderableConversationMessages` returns, not the raw `messages` prop.
   * Hosts join scores to turns by counting user messages in that same filtered
   * array, so handing them the raw index would offset every rating by however
   * many internal messages the thread happens to carry.
   */
  renderTurnFooter?: (message: UIMessage, index: number) => ReactNode;
}

/**
 * Lower-level transcript surface. Exposes the host-integration seams
 * (`renderTool`, `renderWidget`). Inspector interactive chat uses this and
 * injects its adapters; `ReadOnlyTranscript` wraps it with no seams.
 */
export function Transcript({
  messages,
  model = DEFAULT_CHAT_UI_MODEL,
  toolsMetadata = EMPTY_TOOLS_METADATA,
  toolServerMap = EMPTY_TOOL_SERVER_MAP,
  toolRenderOverrides,
  themeMode = "system",
  reasoningDisplayMode = "inline",
  widgetPolicy = "placeholder",
  className,
  showAssistantAvatar,
  renderAvatar,
  renderTool,
  renderWidget,
  renderJson,
  renderTurnFooter,
}: TranscriptProps) {
  const visible = getRenderableConversationMessages(messages);
  return (
    <div className={cn("mcpjam-chat-ui", themeClass(themeMode), className)}>
      <div className="mcpjam-chat-transcript flex w-full min-w-0 flex-col gap-6">
        {visible.map((message, index) => (
          <MessageView
            key={message.id ?? index}
            message={message}
            model={model}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
            toolRenderOverrides={toolRenderOverrides}
            reasoningDisplayMode={reasoningDisplayMode}
            widgetPolicy={widgetPolicy}
            showAssistantAvatar={showAssistantAvatar}
            renderAvatar={renderAvatar}
            renderTool={renderTool}
            renderWidget={renderWidget}
            renderJson={renderJson}
            renderTurnFooter={renderTurnFooter}
            turnIndex={index}
          />
        ))}
      </div>
    </div>
  );
}

export type ReadOnlyTranscriptProps = Omit<
  TranscriptProps,
  "renderTool" | "renderWidget"
>;

/**
 * Public read-only transcript. Renders text, reasoning, files, sources,
 * JSON/data parts, approvals-as-state, and tool call/result blocks.
 * Widget-bearing tools render a placeholder (see `widgetPolicy`).
 *
 * READ-ONLY means no side effects: this never touches Convex, analytics,
 * stores, contexts, or any widget runtime, and nothing it renders can edit the
 * thread or call a tool. The two seams that could break that — `renderTool`
 * and `renderWidget`, which hand a host the whole tool block or mount a real
 * widget — are omitted from its props.
 *
 * `renderJson` is not omitted, and the difference is what it is able to do: it
 * is handed a value and the text the default renderer would have shown, and
 * returns a node. It cannot reach the part, the message, or anything that
 * calls a tool. It is the seam the inspector uses to display payloads in the
 * same collapsible tree its Playground uses, rather than this package growing
 * a second copy of a component that already exists one layer up.
 *
 * It is NOT inert. Parts own local disclosure state — reasoning collapses
 * (`ReasoningPart`) and the tool card collapses (`ToolCallPart`) — so the
 * subtree contains focusable controls whose only effect is on what this
 * component shows. A transcript that inlined every hundred-line payload was
 * the "bunch of JSON" BB-198 was filed about.
 */
export function ReadOnlyTranscript(props: ReadOnlyTranscriptProps) {
  return <Transcript {...props} />;
}
