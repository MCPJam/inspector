export const HARNESS_STARTUP_LABELS = {
  "connecting-tools": "Connecting tools…",
  "starting-local": "Starting the local runtime…",
  "starting-hosted": "Starting the cloud computer…",
  "connecting-runtime": "Connecting to the runtime…",
} as const;
export type HarnessStartupPhase = keyof typeof HARNESS_STARTUP_LABELS;
export interface HarnessStartupDataPart {
  type: "data-harness-startup";
  data: { phase: HarnessStartupPhase | null; chatSessionId?: string };
}
export function isHarnessStartupDataPart(
  value: unknown,
): value is HarnessStartupDataPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (
    part.type !== "data-harness-startup" ||
    !part.data ||
    typeof part.data !== "object"
  )
    return false;
  const data = part.data as Record<string, unknown>;
  return (
    (data.phase === null ||
      (typeof data.phase === "string" &&
        Object.hasOwn(HARNESS_STARTUP_LABELS, data.phase))) &&
    (data.chatSessionId === undefined || typeof data.chatSessionId === "string")
  );
}
