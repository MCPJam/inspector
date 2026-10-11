/**
 * Whether a feature or operation can run. `hosted` is the policy-off state:
 * MCPJam-provided models serve whatever the organization has not chosen.
 */
export type AiReadinessStatus =
  | "hosted"
  | "ready"
  | "unconfigured"
  | "unsupported"
  | "invalid_credentials"
  | "temporarily_unavailable";

export type AiOperationId =
  | "chat"
  | "eval_target"
  | "persona_driver"
  | "harness_runtime"
  | "judge"
  | "text_analysis"
  | "text_generation"
  | "typed_decision"
  | "embedding"
  | "speech_transcription"
  | "agent_chat";

export type AiFeatureGroupId =
  | "chat"
  | "evals"
  | "insights"
  | "generation"
  | "session_map"
  | "harness"
  | "transcription"
  | "ask_mcpjam";

export type AiFeatureGroupReadiness = {
  id: AiFeatureGroupId;
  label: string;
  status: AiReadinessStatus;
  /** Required operations that stop the feature from running. */
  blockedBy: AiOperationId[];
  /** Optional operations whose absence only narrows what the feature does. */
  degradedBy: AiOperationId[];
};

export type AiOperationReadiness = {
  operation: AiOperationId;
  status: AiReadinessStatus;
  code?: string;
  reason?: string;
  connectionId?: string;
  checkedAt?: number;
};

export type AiReadiness = {
  requireOrgKeys: boolean;
  features: AiFeatureGroupReadiness[];
  operations: AiOperationReadiness[];
  /** Organization provider rows that any request may use under the policy. */
  eligibleConnectionIds: string[];
};

export type OrgAiConfig = {
  organizationId: string;
  aiKeyPolicy: {
    requireOrgKeys: boolean;
    revision: number;
    updatedAt?: number;
  };
  readiness: AiReadiness;
  /**
   * Whether this organization may turn the policy on: the backend's
   * Enterprise check, never the client's idea of the plan. Every viewer gets
   * it, so a member also sees why the switch is unavailable.
   */
  canEnable: boolean;
  /** The viewer is an organization owner or admin. */
  canManage: boolean;
};
