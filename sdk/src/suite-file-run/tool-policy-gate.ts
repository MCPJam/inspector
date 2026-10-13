/**
 * The local run's tool-policy enforcement point.
 *
 * Same decisions as the hosted in-process gate
 * (`server/services/evals/tool-policy-gate.ts`), from the same pure contract
 * (`decideToolPolicy` via a launch-time `ToolPolicySnapshot`): a denied call
 * never reaches the MCP server; the model gets the marked refusal result the
 * hosted gate returns; the block is recorded against its case, iteration and
 * `toolCallId`; and the marker keeps the call out of executed-tool spans and
 * graded tool calls.
 *
 * What is NOT here: the benchmark's side-effect manifests and artifact
 * ledgers, which bound what a pinned benchmark may write and stay with the
 * hosted runner; and page tools, which a local run never has.
 *
 * One gate per ITERATION. Blocks and call ids are iteration state: sharing a
 * gate across concurrent iterations would let one iteration's refusal be
 * graded against another.
 */

import type { ToolSet } from "ai";
import {
  TOOL_POLICY_BLOCK_MARKER,
  decideToolPolicyFromSnapshot,
  type ToolPolicySnapshot,
} from "../contract/tool-policy.js";
import type { SuiteFileToolPolicyBlock } from "./types.js";

export type LocalToolPolicyGate = {
  blocks: SuiteFileToolPolicyBlock[];
  blockedToolCallIds: () => ReadonlySet<string>;
  wrap: (tools: ToolSet) => ToolSet;
};

export function createLocalToolPolicyGate(args: {
  snapshot: ToolPolicySnapshot;
  caseId: string;
  iterationNumber: number;
}): LocalToolPolicyGate {
  const blocks: SuiteFileToolPolicyBlock[] = [];
  const blockedIds = new Set<string>();
  return {
    blocks,
    blockedToolCallIds: () => new Set(blockedIds),
    wrap(tools) {
      const wrapped: ToolSet = { ...tools };
      for (const [toolName, tool] of Object.entries(tools)) {
        // Every tool in a local run is an MCP server tool, so every one is
        // decided — including a tool the snapshot never saw, which the
        // snapshot denies as `unknownAtLaunch`.
        const decision = decideToolPolicyFromSnapshot({
          snapshot: args.snapshot,
          toolName,
        });
        if (decision.allowed) continue;
        wrapped[toolName] = {
          ...tool,
          // Replaces the MCP execute outright: the server is never called.
          execute: async (
            _input: unknown,
            options?: { toolCallId?: string }
          ) => {
            const toolCallId = options?.toolCallId;
            blocks.push({
              caseId: args.caseId,
              iterationNumber: args.iterationNumber,
              toolName,
              ...(toolCallId ? { toolCallId } : {}),
              reason: decision.reason,
              classification: decision.classification,
            });
            if (toolCallId) blockedIds.add(toolCallId);
            return {
              content: [
                {
                  type: "text",
                  text: `Call blocked by tool policy: ${decision.reason}`,
                },
              ],
              [TOOL_POLICY_BLOCK_MARKER]: true,
            };
          },
        } as ToolSet[string];
      }
      return wrapped;
    },
  };
}
