export const TOOL_CHOICE_MODES = ["auto", "required", "none"] as const;

export type ToolChoiceMode = (typeof TOOL_CHOICE_MODES)[number];

export type SpecificToolChoice = {
  type: "tool";
  toolName: string;
};

export type EvalToolChoice = ToolChoiceMode | SpecificToolChoice;

export function normalizeToolChoice(
  value: unknown,
): EvalToolChoice | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if ((TOOL_CHOICE_MODES as readonly string[]).includes(trimmed)) {
      return trimmed as ToolChoiceMode;
    }

    return {
      type: "tool",
      toolName: trimmed,
    };
  }

  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool" &&
    typeof (value as { toolName?: unknown }).toolName === "string"
  ) {
    const toolName = (value as { toolName: string }).toolName.trim();
    if (!toolName) {
      return undefined;
    }

    return {
      type: "tool",
      toolName,
    };
  }

  return undefined;
}

export function getSpecificToolChoiceName(value: unknown): string | undefined {
  const normalized = normalizeToolChoice(value);
  return normalized && typeof normalized === "object"
    ? normalized.toolName
    : undefined;
}

export function getToolChoiceLabel(value: unknown): string {
  const normalized = normalizeToolChoice(value);

  if (!normalized || normalized === "auto") {
    return "Automatic";
  }

  if (normalized === "required") {
    return "Required";
  }

  if (normalized === "none") {
    return "No tools";
  }

  return normalized.toolName;
}
