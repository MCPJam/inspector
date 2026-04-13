import type { Edge, Node } from "@xyflow/react";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import type { SandboxMode, SandboxSettings } from "@/hooks/useSandboxes";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

export type SandboxBuilderNodeKind = "host" | "server";

export type SandboxBuilderNodeState = "ready" | "attention" | "draft" | "live";

export interface SandboxWelcomeDialogDraft {
  enabled: boolean;
  /** Host-authored first-open content (stored when backend supports it). */
  body: string;
}

export interface SandboxFeedbackDialogDraft {
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

export interface SandboxDraftConfig {
  name: string;
  description: string;
  hostStyle: SandboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: SandboxMode;
  selectedServerIds: string[];
  /** Subset of selectedServerIds that are optional (off by default for testers). */
  optionalServerIds: string[];
  welcomeDialog: SandboxWelcomeDialogDraft;
  feedbackDialog: SandboxFeedbackDialogDraft;
}

export interface SandboxBuilderContext {
  sandbox: SandboxSettings | null;
  draft: SandboxDraftConfig | null;
  workspaceServers: RemoteServer[];
}

export interface SandboxBuilderChip {
  label: string;
  tone?: "neutral" | "success" | "warning" | "info";
}

export interface SandboxBuilderNodeData extends Record<string, unknown> {
  kind: SandboxBuilderNodeKind;
  title: string;
  subtitle?: string;
  /** Small label above the title (e.g. Isolated Environment on the host chat card). */
  eyebrow?: string;
  /** Extra line under subtitle (e.g. model name on the host card). */
  detailLine?: string;
  chips: SandboxBuilderChip[];
  state: SandboxBuilderNodeState;
  serverId?: string;
  /** Host preview only: drives Claude vs ChatGPT-style logo on the canvas. */
  hostStyle?: SandboxHostStyle;
}

export interface SandboxSectionLabelData extends Record<string, unknown> {
  label: string;
  /** Use MCP logo for MCP-related sections (e.g. "MCP servers") */
  icon?: "mcp";
}

export type SandboxFlowNode =
  | Node<SandboxBuilderNodeData, "sandboxNode">
  | Node<SandboxSectionLabelData, "sectionLabel">;

export interface SandboxBuilderViewModel {
  title: string;
  description: string;
  nodeMap: Record<string, SandboxBuilderNodeData>;
  nodes: SandboxFlowNode[];
  edges: Edge[];
}

export interface SandboxStarterDefinition {
  id: "internal-qa" | "icp-demo" | "blank";
  title: string;
  description: string;
  promptHint: string;
  /** Short hover text on the template info icon (first-run tiles). */
  templateTooltip?: string;
  createDraft: (defaultModelId: string) => SandboxDraftConfig;
}
