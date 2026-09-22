/**
 * One-way server → Inspector UI events carried on the local command-bus SSE
 * connection. Unlike Inspector commands, events require no response and are
 * not accepted by the command HTTP endpoint.
 */
export interface InspectorScopeStepUpEvent {
  kind: "scope_step_up";
  serverId: string;
  toolCallId?: string;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
}

export type InspectorEvent = InspectorScopeStepUpEvent;

export function isInspectorScopeStepUpEvent(
  value: unknown
): value is InspectorScopeStepUpEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (event.kind !== "scope_step_up") return false;
  if (typeof event.serverId !== "string" || !event.serverId.trim()) {
    return false;
  }
  return (
    (event.requiredScope === undefined ||
      typeof event.requiredScope === "string") &&
    (event.resourceMetadataUrl === undefined ||
      typeof event.resourceMetadataUrl === "string") &&
    (event.errorDescription === undefined ||
      typeof event.errorDescription === "string") &&
    (event.toolCallId === undefined || typeof event.toolCallId === "string")
  );
}
