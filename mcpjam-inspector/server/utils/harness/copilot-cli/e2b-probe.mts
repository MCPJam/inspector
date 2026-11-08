// Development-only tracer: real sandbox, CLI, host approval and retained bridge;
// a scripted Responses model and a counted host tool keep the result deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Sandbox } from "e2b";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { tool, jsonSchema } from "ai";
import { createE2BHarnessSandboxProvider } from "../e2b-sandbox-provider.js";
import { createCopilotCli } from "./index.js";

import { withWarmBridgeBootstrap } from "../warm-bridge-files.js";

const decision = process.env.PROBE_DECISION ?? "allow";
if (!["allow", "deny", "stop", "lost-process"].includes(decision))
  throw new Error("Unknown probe decision.");
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("Set E2B_API_KEY to run the hosted tracer.");
const sandbox = process.env.PROBE_SANDBOX_ID
  ? await Sandbox.connect(process.env.PROBE_SANDBOX_ID, { apiKey })
  : await Sandbox.create("mcpjam-computer", { apiKey, timeoutMs: 12 * 60_000 });
try {
  const name = "mcp__probe__record_write";
  const writes: string[] = [];
  const events: { phase: string; type: string; callId?: string }[] = [];
  const mockPath = "/home/user/.probe/copilot-model.mjs";
  await sandbox.files.write(
    mockPath,
    await readFile(
      new URL("../local/conformance/mock-responses.mjs", import.meta.url),
      "utf8",
    ),
  );
  const model = await sandbox.commands.run(`node ${mockPath}`, {
    background: true,
    envs: { MOCK_PORT: "18185" },
    onStderr: (data) => process.stderr.write(data),
  });
  try {
    const agent = (startupTimeoutMs?: number) =>
      new HarnessAgent({
        harness: withWarmBridgeBootstrap(
          createCopilotCli({
            startupTimeoutMs,
            model: "openai/gpt-5.5",
            auth: {
              OPENAI_BASE_URL: "http://127.0.0.1:18185/v1",
              COPILOT_MODEL_PROXY_PLACEHOLDER: "fixture-only",
            },
          }),
        ),
        sandbox: createE2BHarnessSandboxProvider({
          sandboxId: sandbox.sandboxId,
          apiKey,
        }),
        tools: {
          [name]: tool({
            description: "Append one synthetic record.",
            inputSchema: jsonSchema<Record<string, never>>({
              type: "object",
              properties: {},
              additionalProperties: false,
            }),
            execute: async (_input, { toolCallId }) => {
              writes.push(toolCallId);
              return { content: [{ type: "text", text: "Recorded." }] };
            },
          }),
        },
        toolApproval: { [name]: "user-approval" },
      });
    const first = agent();
    const session = await first.createSession({});
    const stream = await first.stream({ session, prompt: "HOSTWRITE" });
    let approvalId: string | undefined;
    let callId: string | undefined;
    for await (const part of stream.fullStream) {
      if (part.type === "error") throw part.error;
      events.push({ phase: "before", type: part.type });
      if (part.type === "tool-call") callId = part.toolCallId;
      if (part.type === "tool-approval-request") {
        assert.equal(part.toolCall.toolCallId, callId);
        approvalId = part.approvalId;
        break;
      }
    }
    assert.ok(callId && approvalId, "Expected a pending host approval.");
    const continuation = await session.suspendTurn();
    assert.equal(continuation.harnessId, "copilot-cli");
    assert.equal(writes.length, 0);
    const next = agent(6500);
    if (decision === "lost-process") {
      const meta = JSON.parse(
        await sandbox.files.read(
          `/home/user/.agent-runs/${session.sessionId}/bridge/bridge-meta.json`,
        ),
      );
      assert.equal(meta.type, "copilot-cli");
      assert.ok(Number.isSafeInteger(meta.pid) && meta.pid > 1);
      await sandbox.commands.run(`kill -KILL ${meta.pid}`);
      await assert.rejects(
        next.createSession({
          sessionId: session.sessionId,
          continueFrom: structuredClone(continuation),
        }),
        /no longer running/,
      );
      assert.deepEqual(writes, []);
      process.stdout.write(
        JSON.stringify({
          decision,
          sessionId: session.sessionId,
          callId,
          writes,
          lateApprovalRefused: true,
        }) + "\n",
      );
    } else {
      const resumed = await next.createSession({
        sessionId: session.sessionId,
        continueFrom: structuredClone(continuation),
      });
      if (decision === "stop") {
        // Hosted Stop discards the runtime. HarnessAgent.stop() parks unfinished turns.
        await resumed.destroy();
        await assert.rejects(
          next.createSession({
            sessionId: session.sessionId,
            continueFrom: structuredClone(continuation),
          }),
          /no longer running/,
          "A late approval must not recreate the stopped turn",
        );
        assert.deepEqual(writes, []);
        process.stdout.write(
          JSON.stringify({
            decision,
            sessionId: session.sessionId,
            callId,
            writes,
            lateApprovalRefused: true,
          }) + "\n",
        );
      } else {
        const result = await next.continueStream({
          session: resumed,
          toolApprovalContinuations: [
            {
              type: "tool-approval-response",
              approvalId,
              approved: decision === "allow",
            },
          ],
        });
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error;
          events.push({
            phase: "after",
            type: part.type,
            ...("toolCallId" in part ? { callId: part.toolCallId } : {}),
          });
        }
        assert.deepEqual(writes, decision === "allow" ? [callId] : []);
        assert.ok(
          events.some((e) => e.phase === "after" && e.type === "finish"),
        );
        const log = await sandbox.files.read(
          `/home/user/.agent-runs/${session.sessionId}/bridge/event-log.ndjson`,
        );
        const trace = log
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row));
        for (const type of ["tool-call", "tool-result"]) {
          assert.equal(
            trace.filter(
              (row) =>
                row.type === type &&
                row.toolCallId === callId &&
                row.toolName === name,
            ).length,
            1,
          );
        }
        await resumed.stop();
        process.stdout.write(
          JSON.stringify({
            sandboxId: sandbox.sandboxId,
            sessionId: session.sessionId,
            harness: continuation.harnessId,
            approvalId,
            callId,
            decision,
            pendingWrites: 0,
            writes,
            events,
            bridgeTrace: trace.map((e) => ({
              seq: e.seq,
              type: e.type,
              toolCallId: e.toolCallId,
              toolName: e.toolName,
            })),
          }) + "\n",
        );
      }
    }
  } finally {
    await model.kill();
  }
} finally {
  if (!process.env.PROBE_SANDBOX_ID) await sandbox.kill();
}
