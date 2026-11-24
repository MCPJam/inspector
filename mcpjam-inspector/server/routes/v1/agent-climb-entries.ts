/**
 * The approval cards of the climb operations that spend credits, as the
 * headless agent holds them. A climb is a loop of paid rounds that a coding
 * agent runs with MCPJam's own tools and the skill, so the Slack and Discord
 * agent runs none by itself: each of these is a proposal a person approves, and
 * the card says what it spends. The reads and the free change of "Climb for"
 * are direct entries in the registry itself.
 */
import type { ProposedActionTarget } from "@mcpjam/sdk/public-api";
import type { GatedProposalMeta } from "./agent-op-registry.js";

const text = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const suiteTarget = (input: Record<string, unknown>): ProposedActionTarget | undefined => {
  const selector = text(input, "suite");
  return selector ? { type: "eval_suite", selector } : undefined;
};

export const START_CLIMB_PROPOSAL: GatedProposalMeta = {
  describe: (input) =>
    `Start a climb of ${text(input, "server") ?? "(unnamed server)"} on suite ${text(input, "suite") ?? "(unnamed)"}: ` +
    `two baseline runs in each environment, then up to ${String(input.roundLimit ?? "?")} rounds and ${String(input.creditLimit ?? "?")} credits`,
  buttonLabel: "Start it",
  kind: "start",
  confirmSeverity: "spend",
  target: suiteTarget,
};
