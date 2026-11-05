import type { ElicitRequest, Tool } from "@modelcontextprotocol/client";

/** A tool call paused on an elicitation, waiting for the user's answer. */
export type ActiveElicitation = {
  executionId: string;
  requestId: string;
  request: ElicitRequest["params"];
  timestamp: string;
  /**
   * The auth/org scope captured when the ORIGINATING execution started.
   * Carried on this per-execution record — never a shared mutable ref — so a
   * second execution started while this elicitation is pending cannot
   * overwrite the scope the eventual resume files its task under.
   */
  scope?: string;
  /** The asking tool: a refresh can drop it while the prompt is open. */
  toolName: string;
  outputSchema?: Tool["outputSchema"];
};
