export const HARNESS_STARTUP_PHASES = [
  "preparing", "computer", "authorization", "agent", "ready",
] as const;
export type HarnessStartupPhase = typeof HARNESS_STARTUP_PHASES[number];

export interface HarnessStartupDataPart {
  type: "data-harness-startup";
  data: { phase: HarnessStartupPhase; chatSessionId: string; requestId: string };
  transient: true;
}

export function harnessStartupPart(
  phase: HarnessStartupPhase,
  binding: { chatSessionId: string; requestId: string },
): HarnessStartupDataPart {
  return { type: "data-harness-startup", data: { phase, ...binding }, transient: true };
}

export function isHarnessStartupPart(value: unknown): value is HarnessStartupDataPart {
  if (!value || typeof value !== "object" || !("type" in value) ||
      value.type !== "data-harness-startup" || !("data" in value)) return false;
  const data = value.data;
  return !!data && typeof data === "object" && "phase" in data &&
    "chatSessionId" in data && typeof data.chatSessionId === "string" &&
    "requestId" in data && typeof data.requestId === "string" &&
    HARNESS_STARTUP_PHASES.some(phase => phase === data.phase);
}

export function isCurrentHarnessStartup(
  part: HarnessStartupDataPart,
  current: { chatSessionId: string | null; requestId: string | null },
): boolean {
  return part.data.chatSessionId === current.chatSessionId &&
    part.data.requestId === current.requestId;
}
