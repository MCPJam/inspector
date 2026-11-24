/**
 * The words the climb screens use for things the product spec names, in one
 * place so a wording is chosen once.
 */
import type { ClimbPicker } from "./climb-types";

export const PICKER_LABELS: Record<ClimbPicker, string> = {
  person: "You",
  mcpjam: "MCPJam",
  agent: "Your own agent",
};

export const PICKER_HINTS: Record<ClimbPicker, string> = {
  person: "Nothing runs until you say so.",
  mcpjam: "MCPJam picks one change a round in the background. You can close this page.",
  agent: "Your coding agent runs the climb with MCPJam's tools.",
};

/** Cases are split by suite size: the spec's default, shown as the shares it uses. */
export const SPLIT_COPY = {
  large:
    "Cases are split for you: half steer each round, a quarter are validation cases and a quarter are set aside to confirm the result.",
  small:
    "Cases are split for you: 60% steer each round and 40% are validation cases. A suite this size has too few cases to set any aside for a confirmation.",
};

/** Decision 15: a suite of 40 or more cases sets a confirmation group aside. */
export const CONFIRMATION_MINIMUM_CASES = 40;

export const COPY = {
  modelLabel: "Model",
  modelHint: "MCPJam picks each change with this model.",
} as const;
