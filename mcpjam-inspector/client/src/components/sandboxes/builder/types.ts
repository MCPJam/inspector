import type { Edge, Node } from "@xyflow/react";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import type {
  SandboxMode,
  SandboxSettings,
} from "@/hooks/useSandboxes";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

export type SandboxBuilderNodeKind =
  | "host"
  | "server";

export type SandboxBuilderNodeState = "ready" | "attention" | "draft" | "live";

export interface SandboxDraftConfig {
  name: string;
  description: string;
  hostStyle: SandboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  mode: SandboxMode;
  selectedServerIds: string[];
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
  chips: SandboxBuilderChip[];
  state: SandboxBuilderNodeState;
  serverId?: string;
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
