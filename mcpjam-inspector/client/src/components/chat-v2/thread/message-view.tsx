import { memo, useLayoutEffect, useRef, useState } from "react";
import { UIMessage } from "@ai-sdk/react";
import { MessageCircle } from "lucide-react";
import type { ContentBlock } from "@modelcontextprotocol/client";

import { Button } from "@mcpjam/design-system/button";
import { CopyMessageAction } from "@/components/chat-v2/shared/copy-message-action";
import { EditMessageAction } from "@/components/chat-v2/shared/edit-message-action";
import { MessageTimestamp, getMessageTimestampMs } from "@mcpjam/chat-ui";
import { UserMessageBubble } from "./user-message-bubble";
import { PartSwitch } from "./part-switch";
import type { RecorderProps } from "./recorder-types";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useScenarioHostStyle,
  useScenarioHostTheme,
} from "@/contexts/scenario-client-style-context";
import {
  groupAssistantPartsIntoSteps,
  isHiddenInternalMessage,
} from "./thread-helpers";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { type ReasoningDisplayMode } from "./parts/reasoning-part";
import { ClaudeLoadingIndicator } from "@/lib/client-styles/indicators/claude-mark";
import { MCPJamMarkIndicator } from "@/lib/client-styles/indicators/mcpjam-mark";
import { MistralStaticAvatar } from "@/lib/client-styles/mistral-avatar";
import type { McpToolResultImageRenderingPolicy } from "@/lib/client-config-v2";
import { getAssistantAvatarDescriptor } from "@/components/chat-v2/shared/assistant-avatar";
import { SenderAvatar } from "@/components/chat-v2/shared/sender-avatar";
import type { ProjectThreadOwnerAvatar } from "@/components/chat-v2/history/project-thread-owner-avatar";
import { CopilotMessageHeader } from "./copilot-message-header";
import type { AppToolInvocationUpdate } from "./app-tool-invocations";

type ClaudeFooterMode = "none" | "animated" | "static";
type MessagePart = UIMessage["parts"][number];

interface MessageViewProps {
  chatSessionId?: string;
  message: UIMessage;
  model: ModelDefinition;
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  onAppToolInvocationChange?: (invocation: AppToolInvocationUpdate) => void;
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  onRequestTeardown?: (toolCallId: string, displayWidgetId?: string) => void;
  tornDownWidgetIds?: ReadonlySet<string>;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showInlineEdit?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  claudeFooterMode?: ClaudeFooterMode;
  /** MCPJam host: pulsing dots beneath the streaming assistant bubble. */
  mcpjamFooterActive?: boolean;
  /**
   * Optional slot rendered below each user message's bubble. The host
   * (ChatTabV2) wires this when it has a persisted chat session, so a
   * per-message "Save as test case" affordance can render with access to
   * sessionId + per-message id.
   */
  renderUserMessageActions?: (message: UIMessage) => React.ReactNode;
  /**
   * Optional slot rendered below each ASSISTANT message — the per-turn rating
   * widget. Sibling of the hover-only copy actions below, deliberately OUTSIDE
   * that block: a rating prompt nobody can see until they hover is a rating
   * nobody leaves.
   */
  renderAssistantTurnFooter?: (message: UIMessage) => React.ReactNode;
  /**
   * When provided, user messages gain a pencil action that swaps the bubble
   * for an inline editor. Saving rewinds the thread to this message and
   * re-runs the turn from the edited text. Omit it (compare mode, read-only
   * transcripts, surfaces with no history to rewind back to) and no edit
   * affordance renders.
   *
   * `text` is ALL of the message's text parts joined with a blank line (see
   * `extractEditableUserMessageText`), not just the first. The resulting send
   * is a single `text` part, so a multi-part user message does not survive an
   * edit as multiple parts — it round-trips as one. That is intentional: the
   * text is what the user actually edited, and the join is reversible enough
   * for the model.
   *
   * Resolve `false` when the edit was NOT dispatched — every gate the host
   * runs after its first await (discard-draft declined, server unreachable,
   * thread switched, rewind refused). The editor stays open and keeps the
   * user's text instead of discarding it. Resolving anything else, including
   * nothing, closes the editor.
   */
  onEditUserMessage?: (
    message: UIMessage,
    text: string,
  ) => void | boolean | Promise<void | boolean>;
  /** Blocks the edit affordance while a response is streaming. */
  editDisabled?: boolean;
  /** Tier 3 recorder bundle, forwarded to the assistant tool PartSwitch. */
  recorder?: RecorderProps;
  /**
   * Resolved sender for this message (shared sessions only). When absent, the
   * transcript renders today's identical-bubble behavior.
   */
  senderAvatar?: ProjectThreadOwnerAvatar;
  /**
   * Render the avatar above the bubble. Used by `TranscriptThread` to
   * coalesce consecutive prompts from the same sender (Slack/Linear style).
   */
  showSenderAvatar?: boolean;
}

function shouldRerenderMessage(prevMessage: UIMessage, nextMessage: UIMessage) {
  return !(
    prevMessage === nextMessage ||
    (prevMessage.id === nextMessage.id &&
      prevMessage.role === nextMessage.role &&
      prevMessage.parts === nextMessage.parts &&
      getMessageTimestampMs(prevMessage) === getMessageTimestampMs(nextMessage))
  );
}

// A React key for an assistant "step" group that is STABLE across re-derivations
// of the same logical message. The trace adapter can split one assistant turn
// into a different number of steps between the streaming envelope and the
// persisted blob; keying the step <div> by array index then shifts the widget's
// step key on completion, remounting the step (and its mounted MCP App widget
// iframe, wiping live widget state). Derive the key from the first part that
// carries a stable id (toolCallId / part.id) — for a widget-bearing step that's
// the tool's `tool-<toolCallId>`, identical in both representations. Steps with
// no stable part (plain text) fall back to the index; they hold no widget, so a
// remount there is a harmless text re-render.
function getStepKey(stepParts: MessagePart[], stepIndex: number) {
  for (let i = 0; i < stepParts.length; i++) {
    const key = getPartKey(stepParts[i], stepIndex, i);
    if (!key.startsWith(`${stepIndex}-`)) return `step-${key}`;
  }
  return `step-idx-${stepIndex}`;
}

function getPartKey(part: MessagePart, stepIndex: number, partIndex: number) {
  const candidate = part as {
    type?: string;
    toolCallId?: unknown;
    id?: unknown;
  };
  if (
    typeof candidate.toolCallId === "string" &&
    candidate.toolCallId.length > 0
  ) {
    return `tool-${candidate.toolCallId}`;
  }
  if (typeof candidate.id === "string" && candidate.id.length > 0) {
    return `${candidate.type ?? "part"}-${candidate.id}`;
  }
  return `${stepIndex}-${partIndex}`;
}

function isSameSenderAvatar(
  prev: ProjectThreadOwnerAvatar | undefined,
  next: ProjectThreadOwnerAvatar | undefined,
) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.status !== next.status) return false;
  if (prev.status === "show" && next.status === "show") {
    return (
      prev.displayName === next.displayName && prev.imageUrl === next.imageUrl
    );
  }
  return true;
}

function areMessageViewPropsEqual(
  prev: Readonly<MessageViewProps>,
  next: Readonly<MessageViewProps>,
) {
  return (
    !shouldRerenderMessage(prev.message, next.message) &&
    prev.model === next.model &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.toolsMetadata === next.toolsMetadata &&
    prev.chatSessionId === next.chatSessionId &&
    prev.toolServerMap === next.toolServerMap &&
    prev.onWidgetStateChange === next.onWidgetStateChange &&
    prev.onModelContextUpdate === next.onModelContextUpdate &&
    prev.onAppToolInvocationChange === next.onAppToolInvocationChange &&
    prev.pipWidgetId === next.pipWidgetId &&
    prev.fullscreenWidgetId === next.fullscreenWidgetId &&
    prev.onRequestPip === next.onRequestPip &&
    prev.onExitPip === next.onExitPip &&
    prev.onRequestFullscreen === next.onRequestFullscreen &&
    prev.onExitFullscreen === next.onExitFullscreen &&
    prev.onRequestTeardown === next.onRequestTeardown &&
    prev.tornDownWidgetIds === next.tornDownWidgetIds &&
    prev.displayMode === next.displayMode &&
    prev.onDisplayModeChange === next.onDisplayModeChange &&
    prev.onToolApprovalResponse === next.onToolApprovalResponse &&
    prev.toolRenderOverrides === next.toolRenderOverrides &&
    prev.showInlineEdit === next.showInlineEdit &&
    prev.minimalMode === next.minimalMode &&
    prev.interactive === next.interactive &&
    prev.reasoningDisplayMode === next.reasoningDisplayMode &&
    prev.mcpToolResultImageRendering === next.mcpToolResultImageRendering &&
    prev.claudeFooterMode === next.claudeFooterMode &&
    prev.mcpjamFooterActive === next.mcpjamFooterActive &&
    prev.renderUserMessageActions === next.renderUserMessageActions &&
    // Without this the memo freezes the footer: the rating widget's status
    // lives in the host's callback identity, so a submit would never repaint.
    prev.renderAssistantTurnFooter === next.renderAssistantTurnFooter &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.editDisabled === next.editDisabled &&
    isSameSenderAvatar(prev.senderAvatar, next.senderAvatar) &&
    prev.showSenderAvatar === next.showSenderAvatar &&
    // Tier 3: arming/disarming recording flips the recorder bundle's identity;
    // without this the memo skips the re-render and recordMode never reaches
    // the widget (the recorder appears "unavailable").
    prev.recorder === next.recorder
  );
}

/**
 * Every text part of a user message, joined for the inline editor.
 *
 * Deliberately NOT `extractUserMessageText` (chat-helpers.ts): that helper
 * returns only the *first* text part, which is fine for its callers (prompt
 * previews) but would silently drop every part after the first here — the
 * read-only bubble renders all of them, so the editor must round-trip all of
 * them too, or saving an edit would discard part of the user's own message.
 * Parts are joined with a blank line because the bubble renders each text
 * part as its own block (`UserMessageBubble`'s `space-y-3`); a blank line
 * preserves that separation instead of running unrelated parts together.
 *
 * Also used by the copy action on both roles — copying wants the same
 * "everything the user can read" semantics as editing.
 */
function extractEditableUserMessageText(message: UIMessage): string {
  const parts = (message.parts ?? []) as Array<{
    type?: string;
    text?: unknown;
  }>;
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n\n");
}

/**
 * The user-side transcript row. Owns the inline-edit state locally so the host
 * only has to supply a submit handler — nothing about "which message is being
 * edited" has to cross a component boundary. File attachments stay rendered
 * above the editor, since editing revises the text and keeps the files.
 */
function UserMessageRow({
  message,
  files,
  bubble,
  actions,
  onEditUserMessage,
  editDisabled,
  senderAvatar,
  showSenderAvatar,
}: {
  message: UIMessage;
  files: React.ReactNode;
  bubble: React.ReactNode;
  actions: React.ReactNode;
  onEditUserMessage?: (
    message: UIMessage,
    text: string,
  ) => void | boolean | Promise<void | boolean>;
  editDisabled: boolean;
  senderAvatar?: ProjectThreadOwnerAvatar;
  showSenderAvatar: boolean;
}) {
  const originalText = extractEditableUserMessageText(message);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState(originalText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Size the textarea to its content and drop the caret at the end on open,
  // so a long prompt is fully visible and ready to append to.
  useLayoutEffect(() => {
    if (!editing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  const startEditing = () => {
    setDraft(originalText);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft(originalText);
  };

  const submitEdit = async () => {
    // Guard here rather than only on the Send button: Enter reaches this too,
    // and the parent returns early while `sendBlocked`. Closing the editor
    // first would drop the draft with nothing to recover it from — reopening
    // resets to `originalText`. Keep the editor open until sending is allowed.
    if (editDisabled || submitting) return;
    const next = draft.trim();
    if (!next || next === originalText.trim()) {
      cancelEditing();
      return;
    }
    setSubmitting(true);
    try {
      // `editDisabled` is only the FIRST of the host's gates. The rest run
      // after an await the editor cannot see — a declined discard-draft
      // dialog, a server that will not connect, a thread the user switched in
      // the gap, a refused rewind — and each one ends the edit without
      // sending. Closing the editor before hearing back drops `next` exactly
      // the way the comment above warns about, so wait for the host's verdict
      // and keep the editor (and the user's text) open when it refuses.
      // Hosts that return nothing are treated as accepting, so read-only and
      // test consumers keep today's behavior.
      const accepted = await onEditUserMessage?.(message, next);
      if (accepted === false) return;
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };

  // Copy needs no wiring from the host, so the action row always renders.
  const showActionRow = true;

  return (
    <div className="group/user-message flex w-full min-w-0 flex-col items-end gap-2">
      {showSenderAvatar && senderAvatar ? (
        <div className="flex max-w-[min(100%,48rem)] justify-end">
          <SenderAvatar avatar={senderAvatar} />
        </div>
      ) : null}
      {/* File attachments above the bubble */}
      {files}
      {editing ? (
        <div className="flex w-full max-w-[min(100%,48rem)] flex-col gap-2">
          <textarea
            ref={textareaRef}
            aria-label="Edit message"
            value={draft}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              const textarea = event.currentTarget;
              textarea.style.height = "auto";
              textarea.style.height = `${textarea.scrollHeight}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitEdit();
              }
            }}
            className="max-h-[50vh] w-full resize-none overflow-y-auto rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-foreground outline-none focus-visible:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelEditing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void submitEdit()}
              disabled={editDisabled || submitting}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Text and other parts inside the bubble */}
          {bubble}
          {showActionRow ? (
            <div className="flex max-w-[min(100%,48rem)] items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/user-message:opacity-100 focus-within:opacity-100">
              <MessageTimestamp message={message} />
              <CopyMessageAction getText={() => originalText} />
              {onEditUserMessage ? (
                <EditMessageAction
                  onClick={startEditing}
                  disabled={editDisabled}
                />
              ) : null}
              {actions}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function MessageViewImpl({
  chatSessionId,
  message,
  model,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  onAppToolInvocationChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestTeardown,
  tornDownWidgetIds,
  displayMode,
  onDisplayModeChange,
  onToolApprovalResponse,
  toolRenderOverrides,
  showInlineEdit = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  mcpToolResultImageRendering,
  claudeFooterMode = "none",
  mcpjamFooterActive = false,
  renderUserMessageActions,
  renderAssistantTurnFooter,
  onEditUserMessage,
  editDisabled = false,
  senderAvatar,
  showSenderAvatar = false,
  recorder,
}: MessageViewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const scenarioHostStyle = useScenarioHostStyle();
  const scenarioHostTheme = useScenarioHostTheme();
  const assistantAvatar = getAssistantAvatarDescriptor({
    model,
    themeMode: scenarioHostTheme ?? themeMode,
    scenarioHostStyle,
  });
  const shouldRenderMistralAssistantAvatar = scenarioHostStyle === "mistral";
  const shouldRenderAssistantAvatar =
    scenarioHostStyle === null || shouldRenderMistralAssistantAvatar;
  // Copilot mimics show their own "Copilot + mascot" row above the
  // message content (faithful to real M365 Copilot's avatar/name header).
  // Other host styles keep the inspector's existing layout.
  const shouldRenderCopilotHeader = scenarioHostStyle === "copilot";
  if (isHiddenInternalMessage(message)) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    // Separate file parts from other parts - files render above the bubble
    const fileParts =
      message.parts?.filter((part) => part.type === "file") ?? [];
    const otherParts =
      message.parts?.filter((part) => part.type !== "file") ?? [];

    const filesNode =
      fileParts.length > 0 ? (
        <div className="flex max-w-[min(100%,48rem)] flex-wrap justify-end gap-2">
          {fileParts.map((part, i) => (
            <PartSwitch
              key={`file-${i}`}
              part={part}
              role={role}
              chatSessionId={chatSessionId}
              onSendFollowUp={onSendFollowUp}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              onWidgetStateChange={onWidgetStateChange}
              onModelContextUpdate={onModelContextUpdate}
              onAppToolInvocationChange={onAppToolInvocationChange}
              pipWidgetId={pipWidgetId}
              fullscreenWidgetId={fullscreenWidgetId}
              onRequestPip={onRequestPip}
              onExitPip={onExitPip}
              onRequestFullscreen={onRequestFullscreen}
              onExitFullscreen={onExitFullscreen}
              onRequestTeardown={onRequestTeardown}
              tornDownWidgetIds={tornDownWidgetIds}
              displayMode={displayMode}
              onDisplayModeChange={onDisplayModeChange}
              toolRenderOverrides={toolRenderOverrides}
              showInlineEdit={showInlineEdit}
              minimalMode={minimalMode}
              interactive={interactive}
              reasoningDisplayMode={reasoningDisplayMode}
              mcpToolResultImageRendering={mcpToolResultImageRendering}
            />
          ))}
        </div>
      ) : null;

    const bubbleNode =
      otherParts.length > 0 || fileParts.length === 0 ? (
        <UserMessageBubble>
          {otherParts.map((part, i) => (
            <PartSwitch
              key={i}
              part={part}
              role={role}
              chatSessionId={chatSessionId}
              onSendFollowUp={onSendFollowUp}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              onWidgetStateChange={onWidgetStateChange}
              onModelContextUpdate={onModelContextUpdate}
              onAppToolInvocationChange={onAppToolInvocationChange}
              pipWidgetId={pipWidgetId}
              fullscreenWidgetId={fullscreenWidgetId}
              onRequestPip={onRequestPip}
              onExitPip={onExitPip}
              onRequestFullscreen={onRequestFullscreen}
              onExitFullscreen={onExitFullscreen}
              onRequestTeardown={onRequestTeardown}
              tornDownWidgetIds={tornDownWidgetIds}
              displayMode={displayMode}
              onDisplayModeChange={onDisplayModeChange}
              toolRenderOverrides={toolRenderOverrides}
              showInlineEdit={showInlineEdit}
              minimalMode={minimalMode}
              interactive={interactive}
              reasoningDisplayMode={reasoningDisplayMode}
              mcpToolResultImageRendering={mcpToolResultImageRendering}
            />
          ))}
        </UserMessageBubble>
      ) : null;

    return (
      <UserMessageRow
        message={message}
        files={filesNode}
        bubble={bubbleNode}
        actions={
          renderUserMessageActions ? renderUserMessageActions(message) : null
        }
        onEditUserMessage={onEditUserMessage}
        editDisabled={editDisabled}
        senderAvatar={senderAvatar}
        showSenderAvatar={showSenderAvatar}
      />
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);
  const showClaudeFooter = claudeFooterMode !== "none";
  // Only offer copy when there is text to copy — a tool-call-only turn would
  // put an empty string on the clipboard.
  const hasAssistantText = (message.parts ?? []).some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.length > 0,
  );
  const hasTimestamp = getMessageTimestampMs(message) !== undefined;
  return (
    <article
      className={
        shouldRenderAssistantAvatar
          ? "group/assistant-message flex w-full min-w-0 gap-4"
          : "group/assistant-message w-full min-w-0"
      }
    >
      {shouldRenderMistralAssistantAvatar ? (
        <MistralStaticAvatar
          ariaLabel="Mistral assistant"
          className="mt-1 size-7 shrink-0 self-start"
        />
      ) : shouldRenderAssistantAvatar ? (
        <div
          className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${assistantAvatar.avatarClasses}`}
          aria-label={assistantAvatar.ariaLabel}
        >
          {assistantAvatar.logoSrc ? (
            <img
              src={assistantAvatar.logoSrc}
              alt={assistantAvatar.logoAlt ?? ""}
              className="h-4 w-4 object-contain"
            />
          ) : (
            <MessageCircle
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
          )}
        </div>
      ) : null}

      <div className="flex-1 min-w-0">
        {shouldRenderCopilotHeader ? (
          <div className="mb-2">
            <CopilotMessageHeader />
          </div>
        ) : null}
        <div className="space-y-6 text-sm leading-6">
          {steps.map((stepParts, sIdx) => (
            <div key={getStepKey(stepParts, sIdx)} className="space-y-3">
              {stepParts.map((part, pIdx) => (
                <PartSwitch
                  key={getPartKey(part, sIdx, pIdx)}
                  part={part}
                  role={role}
                  chatSessionId={chatSessionId}
                  onSendFollowUp={onSendFollowUp}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  onWidgetStateChange={onWidgetStateChange}
                  onModelContextUpdate={onModelContextUpdate}
                  onAppToolInvocationChange={onAppToolInvocationChange}
                  pipWidgetId={pipWidgetId}
                  fullscreenWidgetId={fullscreenWidgetId}
                  onRequestPip={onRequestPip}
                  onExitPip={onExitPip}
                  onRequestFullscreen={onRequestFullscreen}
                  onExitFullscreen={onExitFullscreen}
                  onRequestTeardown={onRequestTeardown}
                  tornDownWidgetIds={tornDownWidgetIds}
                  displayMode={displayMode}
                  onDisplayModeChange={onDisplayModeChange}
                  onToolApprovalResponse={onToolApprovalResponse}
                  messageParts={message.parts}
                  toolRenderOverrides={toolRenderOverrides}
                  showInlineEdit={showInlineEdit}
                  minimalMode={minimalMode}
                  interactive={interactive}
                  reasoningDisplayMode={reasoningDisplayMode}
                  mcpToolResultImageRendering={mcpToolResultImageRendering}
                  {...recorder}
                />
              ))}
            </div>
          ))}
        </div>
        {mcpjamFooterActive ? (
          <div data-testid="mcpjam-message-footer" className="pt-4">
            <MCPJamMarkIndicator />
          </div>
        ) : null}
        {showClaudeFooter ? (
          <div
            data-testid={`claude-message-footer-${claudeFooterMode}`}
            className="pt-4"
          >
            <ClaudeLoadingIndicator mode={claudeFooterMode} />
          </div>
        ) : null}
        {hasAssistantText || hasTimestamp ? (
          <div className="flex items-center gap-1 pt-2 opacity-0 transition-opacity duration-150 group-hover/assistant-message:opacity-100 focus-within:opacity-100">
            {hasAssistantText ? (
              <CopyMessageAction
                getText={() => extractEditableUserMessageText(message)}
              />
            ) : null}
            <MessageTimestamp message={message} />
          </div>
        ) : null}
        {renderAssistantTurnFooter?.(message)}
      </div>
    </article>
  );
}

export const MessageView = memo(MessageViewImpl, areMessageViewPropsEqual);

MessageView.displayName = "MessageView";
