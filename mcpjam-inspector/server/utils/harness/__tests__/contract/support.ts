/**
 * Shared cases for the adapter contract suite.
 *
 * Every row runs once per registered adapter and derives its expectation from
 * that adapter's own declarations, so a new harness is covered the moment it is
 * registered. A declared refusal is asserted as a refusal, never skipped.
 *
 * The suite checks that declarations, pins and discovery evidence agree. It
 * does not show that Apps, elicitation or Tasks work at a pin; only a live
 * qualification run against the real harness shows that.
 */
import { expect } from "vitest";
import { HARNESS_IDS, type Harness } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { getHarnessAdapter, registeredHarnessIds } from "../../registry";
import type { HarnessMcpPlanFacts } from "../../harness-mcp-plan";

export const CASES = registeredHarnessIds().map((id) => ({
  id,
  adapter: getHarnessAdapter(id),
  descriptor: HARNESS_DESCRIPTORS[id],
}));

export type ContractCase = (typeof CASES)[number];

/** Every SDK harness id is registered, so `describe.each(CASES)` misses none. */
export function assertFullMatrix(): void {
  expect(CASES.map((entry) => entry.id).sort()).toEqual(
    [...HARNESS_IDS].sort(),
  );
}

/** A model each runtime runs at its pin, per the evidence table. */
export const OWN_MODEL: Record<Harness, string> = {
  "claude-code": "anthropic/claude-haiku-4.5",
  codex: "openai/gpt-5.5",
  "copilot-cli": "openai/gpt-5.5",
  cursor: "cursor/auto",
  opencode: "anthropic/claude-haiku-4.5",
};

/** A model each runtime must refuse. */
export const FOREIGN_MODEL: Record<Harness, string> = {
  "claude-code": "openai/gpt-5.5",
  codex: "anthropic/claude-haiku-4.5",
  "copilot-cli": "anthropic/claude-haiku-4.5",
  cursor: "anthropic/claude-haiku-4.5",
  opencode: "openai/gpt-5.5",
};

/** A patch bump of a pinned version, for "what if the pin moved" rows. */
export function bumpedPin(version: string): string {
  const parts = version.split(".");
  const last = parts.at(-1) ?? "0";
  const digits = /^\d+$/.test(last) ? String(Number(last) + 1) : `${last}-next`;
  return [...parts.slice(0, -1), digits].join(".");
}

/** A hosted chat turn that is ready to forward, before admission. */
export function hostedChatFacts(
  overrides: Partial<HarnessMcpPlanFacts> = {},
): HarnessMcpPlanFacts {
  return {
    dispatch: { mcpClient: "harness" },
    forwardingRuntime: undefined,
    forwardingOrganization: true,
    accountRouting: false,
    forwardingEnabled: true,
    plane: "web-authorized",
    selectedServerCount: 1,
    hostId: "host-1",
    localExecution: false,
    admit: () => ({ delivery: "native", gaps: [] }),
    ...overrides,
  };
}

/** Keys sorted at every depth, so a snapshot diff shows only real changes. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}
