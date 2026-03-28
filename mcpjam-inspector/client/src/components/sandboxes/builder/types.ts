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
  /** Fire feedback prompt every N tool calls when enabled. */
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
  /** Small label above the title (e.g. Preview on the host chat card). */
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
  createDraft: (defaultModelId: string) => SandboxDraftConfig;
}
