import type { Edge, Node } from "@xyflow/react";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import type { ChatboxMode, ChatboxSettings } from "@/hooks/useChatboxes";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

export type ChatboxBuilderNodeKind = "host" | "server";

export type ChatboxBuilderNodeState = "ready" | "attention" | "draft" | "live";

export interface ChatboxWelcomeDialogDraft {
  enabled: boolean;
  /** Host-authored first-open content (stored when backend supports it). */
  body: string;
}

export interface ChatboxFeedbackDialogDraft {
  enabled: boolean;
  /**
   * Hosted runs advance a counter on completed tool calls; when it reaches N,
   * testers may see the feedback prompt. This is not “every N user messages.”
   * Product intent for tight QA vs lighter external demos is still expressed
   * via starter defaults (e.g. 1 vs 3) even though the underlying signal is
   * tool-call-based until a prompt-based trigger exists.
   */
  everyNToolCalls: number;
  /** Optional prompt copy for testers. */
  promptHint: string;
}

export interface ChatboxDraftConfig {
  name: string;
  description: string;
  hostStyle: ChatboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: ChatboxMode;
  selectedServerIds: string[];
  /** Subset of selectedServerIds that are optional (off by default for testers). */
  optionalServerIds: string[];
  welcomeDialog: ChatboxWelcomeDialogDraft;
  feedbackDialog: ChatboxFeedbackDialogDraft;
}

export interface ChatboxBuilderContext {
  chatbox: ChatboxSettings | null;
  draft: ChatboxDraftConfig | null;
  workspaceServers: RemoteServer[];
}

export interface ChatboxBuilderChip {
  label: string;
  tone?: "neutral" | "success" | "warning" | "info";
}

export interface ChatboxBuilderNodeData extends Record<string, unknown> {
  kind: ChatboxBuilderNodeKind;
  title: string;
  subtitle?: string;
  /** Small label above the title (e.g. Isolated Environment on the host chat card). */
  eyebrow?: string;
  /** Extra line under subtitle (e.g. model name on the host card). */
  detailLine?: string;
  chips: ChatboxBuilderChip[];
  state: ChatboxBuilderNodeState;
  serverId?: string;
  /** Host preview only: drives Claude vs ChatGPT-style logo on the canvas. */
  hostStyle?: ChatboxHostStyle;
}

export interface ChatboxSectionLabelData extends Record<string, unknown> {
  label: string;
  /** Use MCP logo for MCP-related sections (e.g. "MCP servers") */
  icon?: "mcp";
}

export type ChatboxFlowNode =
  | Node<ChatboxBuilderNodeData, "chatboxNode">
  | Node<ChatboxSectionLabelData, "sectionLabel">;

export interface ChatboxBuilderViewModel {
  title: string;
  description: string;
  nodeMap: Record<string, ChatboxBuilderNodeData>;
  nodes: ChatboxFlowNode[];
  edges: Edge[];
}

export interface ChatboxStarterDefinition {
  id: "internal-qa" | "icp-demo" | "blank";
  title: string;
  description: string;
  promptHint: string;
  /** Short hover text on the template info icon (first-run tiles). */
  templateTooltip?: string;
  createDraft: (defaultModelId: string) => ChatboxDraftConfig;
}
