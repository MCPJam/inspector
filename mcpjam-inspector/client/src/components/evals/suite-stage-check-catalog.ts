import type { UserValueStage } from "@mcpjam/sdk/contract";

/** Stable IDs keep suite selections independent of display copy. */
export const SUITE_STAGE_CHECKS: readonly {
  stage: UserValueStage;
  label: string;
  checks: readonly { id: string; label: string }[];
}[] = [
  {
    stage: "connection",
    label: "Connection",
    checks: [
      { id: "connection.success", label: "Successful connection" },
      { id: "connection.oauth", label: "OAuth connection" },
      { id: "connection.conformance", label: "Protocol conformance" },
    ],
  },
  {
    stage: "discovery",
    label: "Discovery",
    checks: [
      { id: "discovery.description", label: "Description quality" },
      { id: "discovery.annotations", label: "Tool annotations" },
      { id: "discovery.collisions", label: "Name collisions" },
      { id: "discovery.deprecated", label: "Deprecated tools exposed" },
    ],
  },
  {
    stage: "selection",
    label: "Selection",
    checks: [
      {
        id: "selection.relevance",
        label: "Relevance of the tools called to the goal",
      },
      { id: "selection.hops", label: "Tool hops before the right tool" },
    ],
  },
  {
    stage: "call",
    label: "Tool call",
    checks: [
      {
        id: "call.parameters",
        label: "Parameter validity and reasons for invalid inputs",
      },
      { id: "call.schema", label: "Input schema quality" },
      { id: "call.privacy", label: "Input privacy, including user_intent" },
    ],
  },
  {
    stage: "response",
    label: "Tool response",
    checks: [
      { id: "response.performance", label: "Tool latency and payload size" },
      { id: "response.errors", label: "Tool errors (isError)" },
      { id: "response.schema", label: "Output schema quality" },
      { id: "response.recovery", label: "Error messages that help recovery" },
      { id: "response.pagination", label: "Pagination and truncation clarity" },
    ],
  },
  {
    stage: "userValue",
    label: "User value",
    checks: [
      { id: "userValue.outcome", label: "Outcome achieved" },
      { id: "userValue.efficiency", label: "Efficiency and frustration" },
      { id: "userValue.routeDrift", label: "Route drift from the goal" },
      { id: "userValue.latency", label: "End-to-end latency" },
    ],
  },
];

export function normalizeDisabledStageChecks(
  ids: readonly string[] | undefined,
): string[] | undefined {
  return ids?.length ? [...new Set(ids)].sort() : undefined;
}

export function describeStageChecks(
  disabled: readonly string[] | undefined,
): string {
  if (!disabled?.length) return "All checks enabled";
  const labels = new Map(
    SUITE_STAGE_CHECKS.flatMap(({ checks }) =>
      checks.map(({ id, label }) => [id, label] as const),
    ),
  );
  return `Disabled: ${disabled.map((id) => labels.get(id) ?? id).join(", ")}`;
}
