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

export const SUBMIT_CLIMB_ROUND_PROPOSAL: GatedProposalMeta = {
  describe: (input) =>
    `Submit ${text(input, "server") ?? "(unnamed server)"} as the next round of climb ${text(input, "climb") ?? "(unnamed)"}: ` +
    "the steering and validation cases run in every environment of the climb",
  buttonLabel: "Run the round",
  kind: "start",
  confirmSeverity: "spend",
};

export const CONTINUE_CLIMB_PROPOSAL: GatedProposalMeta = {
  describe: (input) =>
    `Continue climb ${text(input, "climb") ?? "(unnamed)"}: MCPJam picks the next change and runs it in every environment, within the climb's round and credit limits`,
  buttonLabel: "Continue the climb",
  kind: "start",
  confirmSeverity: "spend",
};

export const CONFIRM_CLIMB_PROPOSAL: GatedProposalMeta = {
  describe: (input) =>
    `Confirm climb ${text(input, "climb") ?? "(unnamed)"} once: two run groups on the cases no round ran, in every environment of the climb`,
  buttonLabel: "Run the confirmation",
  kind: "start",
  confirmSeverity: "spend",
};

export const VERIFY_CLIMB_PROPOSAL: GatedProposalMeta = {
  describe: (input) =>
    `Verify climb ${text(input, "climb") ?? "(unnamed)"} on the real server: two run groups, the server as it is and the server with a mock that puts the old values back${text(input, "commit") ? `, recording commit ${text(input, "commit")}` : ""}`,
  buttonLabel: "Run the verification",
  kind: "start",
  confirmSeverity: "spend",
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
