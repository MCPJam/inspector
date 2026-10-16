/** Server-resolved study ownership, independent of the execution profile. */
export interface LocalStudyGrantBinding {
  scenarioId: string;
  accessVersion: number;
  chatSessionId: string;
}

export function isLocalStudyGrantBinding(
  value: unknown,
): value is LocalStudyGrantBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<LocalStudyGrantBinding>;
  return (
    typeof binding.scenarioId === "string" &&
    binding.scenarioId.trim().length > 0 &&
    typeof binding.chatSessionId === "string" &&
    binding.chatSessionId.trim().length > 0 &&
    typeof binding.accessVersion === "number" &&
    Number.isSafeInteger(binding.accessVersion) &&
    binding.accessVersion >= 0
  );
}
