import { randomUUID } from "node:crypto";
import { isCallToolResultError } from "@mcpjam/sdk";
import { EVIDENCE_UNAVAILABLE_MESSAGE } from "../../../services/mcp-http-bridge.js";
import type { ToolCallEvidenceHook } from "../../../services/mcp-http-bridge.js";
import { createConvexEvidenceTransport, createHarnessEvidenceClient } from "../harness-evidence-client.js";
import { localHarnessBackend } from "./readiness.js";

export async function localHarnessEvidence(bearer: string, iterationId: string, turnId: string) {
  const decision = await localHarnessBackend(bearer).query("testSuites:getLocalHarnessEvidenceDecision" as never, { iterationId } as never) as { runId?: string; captureEnabled: boolean; gradingSource: "narration" | "evidence" };
  if (!decision.captureEnabled) return { decision };
  if (!decision.runId) throw new Error("Evidence capture requires an authorized suite run");
  const client = createHarnessEvidenceClient({ scope: { runId: decision.runId, iterationId, turnId }, transport: createConvexEvidenceTransport(bearer) });
  return { decision, evidence: (): ToolCallEvidenceHook => {
    const requestId = randomUUID();
    return {
      beforeExecute: async ({ serverId, toolName, arguments: args }) => (await client.recordStart({ requestId, serverId, toolName, arguments: args, startedAtMs: Date.now() })) ? { ok: true } : { ok: false, reason: EVIDENCE_UNAVAILABLE_MESSAGE },
      afterExecute: async ({ outcome }) => { await client.recordSettlement({ requestId, outcomeKind: outcome.kind === "error" ? "jsonrpc_error" : isCallToolResultError(outcome.result) ? "call_tool_error" : "success", response: outcome.kind === "error" ? { error: outcome.errorEnvelope } : outcome.result, settledAtMs: Date.now() }); },
    };
  } };
}
