/**
 * NATIVE MCP JOURNEYS — what a local runtime whose own MCP client dials
 * MCPJam's per-server proxy owes the member. `run-gateway-turn.ts` runs them
 * for every gateway runtime that delivers MCP that way.
 *
 * A real MCP server sits behind the path a local turn builds: MCPJam's
 * loopback per-server proxy (`startLocalHarnessMcpPlane`), the session config
 * from `buildHarnessProxyMcpJsonFromManager`, and MCPJam's own MCP client. The
 * scripted model asks for the server's side-effecting tool (`MCPWRITE`), and
 * the server counts every `tools/call` that reaches it.
 *
 * Asserted:
 *  - approval off: the call runs once and nobody is asked;
 *  - approval on: the turn pauses with no call sent, and none is sent while
 *    the decision waits;
 *  - Allow runs the call exactly once; Deny runs nothing;
 *  - Stop while paused runs nothing and leaves no process;
 *  - the stopped turn's approval cannot be answered afterwards;
 *  - the next message resumes the conversation without replaying the call;
 *  - the server sees MCPJam's client and no MCPJam correlation metadata.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { HarnessV1PermissionMode } from "@ai-sdk/harness";
import { resolveAgentLoop } from "../../agent-loop-dispatch.js";
import { resolveHarnessMcpPlan } from "../../harness-mcp-plan.js";
import { buildHarnessProxyMcpJsonFromManager } from "../../run-harness-turn.js";
import { startLocalHarnessMcpPlane } from "../mcp-plane.js";
import { diskResumeState } from "../resume-state.js";
import type { Harness } from "@mcpjam/sdk/host-config/internal";

const SERVER_ID = "journey";
/** How long a pending decision waits before the journeys check for writes. */
const PENDING_MS = 1_500;

type WireCall = { name: unknown; meta: unknown };

/** The MCP server, MCPJam's client for it, and the proxy the CLI dials. */
export async function startNativeMcpPath(turnId: string) {
  const calls: WireCall[] = [];
  const clients: unknown[] = [];
  const node = toNodeHandler(
    createMcpHandler(() => {
      const mcp = new McpServer(
        { name: "journey", version: "1" },
        { capabilities: { tools: {} } },
      );
      mcp.registerTool(
        "record_write",
        {
          description: "Record a note. Each call is a write the journeys count.",
          inputSchema: z.object({ note: z.string() }),
        },
        async ({ note }) => ({
          content: [{ type: "text" as const, text: `RECORDED:${note}` }],
        }),
      );
      return mcp;
    }),
  );
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
    const params = body?.params ?? {};
    if (body?.method === "initialize") clients.push(params.clientInfo);
    else if (params._meta?.["io.modelcontextprotocol/clientInfo"])
      clients.push(params._meta["io.modelcontextprotocol/clientInfo"]);
    if (body?.method === "tools/call")
      calls.push({ name: params.name, meta: params._meta });
    await node(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  const manager = new MCPClientManager({ [SERVER_ID]: { url } });
  await manager.connectToServer(SERVER_ID, { url });
  const plane = await startLocalHarnessMcpPlane({
    manager,
    serverIds: [SERVER_ID],
    turnId,
  });
  const { mcpJson } = await buildHarnessProxyMcpJsonFromManager({
    manager,
    selectedServerIds: [SERVER_ID],
    authHeader: "",
    projectId: "conformance-project",
    strategy: plane.strategy,
    scopeStepUpCorrelationId: turnId,
  });
  return {
    mcpJson,
    writes: () => calls.filter((call) => call.name === "record_write").length,
    calls,
    clients,
    /** Between turns the proxy refuses the parked process, as a local turn's
     *  pause holds it; the next decision rebinds it. */
    hold: () => plane.hold(),
    rebind: () =>
      plane.rebind({ manager, serverIds: [SERVER_ID], turnId }),
    close: async () => {
      await plane.close();
      await manager.disconnectAllServers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type NativeMcpPath = Awaited<ReturnType<typeof startNativeMcpPath>>;

/** One journey session, opened and stopped by the driver that owns the processes. */
export type JourneySession = {
  agent: HarnessAgent;
  session: HarnessAgentSession;
  sessionId: string;
  /** Stop the session; returns what it left behind. */
  stop(): Promise<string[]>;
};

type StreamPart = { type: string; [key: string]: unknown };
type Paused = { approvalId: string; toolName: string };
type Turn = { text: string; paused?: Paused; parts: string[]; errors: string[]; ms: number };

/** Read a turn to its end. A paused turn's stream ends at its approval request. */
async function read(stream: AsyncIterable<StreamPart>): Promise<Turn> {
  const started = performance.now();
  const turn: Turn = { text: "", parts: [], errors: [], ms: 0 };
  for await (const part of stream) {
    turn.parts.push(part.type);
    if (part.type === "text-delta") turn.text += String(part.text ?? "");
    if (part.type === "error") turn.errors.push(String(part.error));
    if (part.type === "tool-approval-request") {
      const call = part.toolCall as { toolName?: string } | undefined;
      turn.paused = {
        approvalId: String(part.approvalId),
        toolName: String(call?.toolName ?? ""),
      };
    }
  }
  turn.ms = Math.round(performance.now() - started);
  return turn;
}

const prompt = (journey: JourneySession, text: string) =>
  journey.agent
    .stream({ session: journey.session, prompt: text })
    .then((result) => read(result.fullStream as AsyncIterable<StreamPart>));

/** Answer the paused call the way a chat turn does: suspend, reopen, continue. */
async function answer(journey: JourneySession, paused: Paused, approved: boolean) {
  const continueFrom = await journey.session.suspendTurn();
  journey.session = await journey.agent.createSession({
    sessionId: journey.sessionId,
    continueFrom,
  });
  const result = await journey.agent.continueStream({
    session: journey.session,
    toolApprovalContinuations: [
      { type: "tool-approval-response", approvalId: paused.approvalId, approved },
    ],
  });
  return read(result.fullStream as AsyncIterable<StreamPart>);
}

export async function runNativeMcpJourneys(input: {
  harnessId: Harness;
  path: NativeMcpPath;
  open(permissionMode: HarnessV1PermissionMode): Promise<JourneySession>;
  say(line: string): void;
}) {
  const { path } = input;
  const say = (label: string, turn?: Turn) =>
    input.say(turn ? `${label}: ${turn.ms}ms parts=${turn.parts.join(",")}${turn.paused ? ` paused=${turn.paused.toolName}` : ""} text=${JSON.stringify(turn.text.slice(0, 120))}` : label);
  const failures: string[] = [];
  const report: Record<string, unknown> = {};
  const expectWrites = (label: string, expected: number) => {
    const writes = path.writes();
    if (writes !== expected) failures.push(`${label}: the server saw ${writes} write(s), expected ${expected}`);
  };
  const expectPause = (label: string, turn: Turn): Paused | undefined => {
    if (!turn.paused) failures.push(`${label}: the call ran without asking (parts ${turn.parts.join(",")})`);
    // The name host attribution parses back to the server and its tool.
    else if (turn.paused.toolName !== `mcp__${SERVER_ID}__record_write`)
      failures.push(`${label}: the approval names ${turn.paused.toolName}, not the server's tool`);
    return turn.paused;
  };

  // The route the turn runner plans for a local turn of this client.
  const plan = resolveHarnessMcpPlan({
    dispatch: resolveAgentLoop({ harness: input.harnessId }),
    forwardingRuntime: undefined, forwardingOrganization: false, accountRouting: false,
    forwardingEnabled: false, plane: "local-loopback", selectedServerCount: 1,
    localExecution: true, admit: () => ({ gaps: [] }),
  });
  report.route = { upstream: plan.upstream, delivery: plan.delivery };
  if (plan.upstream !== "mcpjam" || plan.delivery !== "mcp-endpoint")
    failures.push(`a local turn plans ${plan.upstream}/${plan.delivery}, not MCPJam's proxy`);

  // Approval off: nobody is asked and the call runs once.
  const off = await input.open("allow-all");
  const offTurn = await prompt(off, "MCPWRITE off");
  report.off = offTurn;
  say("approval off", offTurn);
  if (offTurn.paused) failures.push("approval off: the turn asked anyway");
  if (!offTurn.text.includes("RECORDED:off")) failures.push("approval off: the server's result did not reach the model");
  expectWrites("approval off", 1);
  failures.push(...(await off.stop()));

  // Approval on: pause with nothing sent, then Allow exactly once.
  const on = await input.open("allow-reads");
  const pending = await prompt(on, "MCPWRITE allowed");
  say("approval on", pending);
  const allowedCall = expectPause("approval on", pending);
  await sleep(PENDING_MS);
  expectWrites("while the decision is pending", 1);
  path.hold();
  if (allowedCall) {
    path.rebind();
    const allowed = await answer(on, allowedCall, true);
    report.allow = allowed;
    say("Allow", allowed);
    if (!allowed.text.includes("RECORDED:allowed")) failures.push("Allow: the server's result did not reach the model");
  }
  expectWrites("Allow", 2);

  // Deny: nothing is sent and the model hears no.
  const denyTurn = await prompt(on, "MCPWRITE denied");
  say("Deny asks", denyTurn);
  const deniedCall = expectPause("Deny", denyTurn);
  if (deniedCall) {
    const denied = await answer(on, deniedCall, false);
    report.deny = denied;
    say("Deny", denied);
    if (denied.text.includes("RECORDED:")) failures.push("Deny: a result came back for a denied call");
    // The model hears a refusal, not a broken permission flow.
    if (/malformed|flow failed/i.test(denied.text)) failures.push(`Deny: the runtime rejected the answer: ${denied.text.slice(0, 200)}`);
  }
  expectWrites("Deny", 2);

  // Stop while paused: nothing is sent, nothing is left running.
  const stopTurn = await prompt(on, "MCPWRITE stopped");
  say("Stop asks", stopTurn);
  const stoppedCall = expectPause("Stop while paused", stopTurn);
  const continuation = await on.session.suspendTurn();
  path.hold();
  failures.push(...(await on.stop()));
  expectWrites("Stop while paused", 2);

  // The stopped turn's approval: refused, still nothing sent.
  if (stoppedCall) {
    path.rebind();
    const stale = await on.agent
      .createSession({ sessionId: on.sessionId, continueFrom: continuation })
      .then((session) =>
        on.agent.continueStream({
          session,
          toolApprovalContinuations: [
            { type: "tool-approval-response", approvalId: stoppedCall.approvalId, approved: true },
          ],
        }),
      )
      .then((result) => read(result.fullStream as AsyncIterable<StreamPart>))
      .then(
        (turn) => (turn.errors.length > 0 ? turn.errors[0] : undefined),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    report.staleApproval = stale ?? "accepted";
    if (stale === undefined) failures.push("a stopped turn's approval was accepted");
    await sleep(PENDING_MS);
    expectWrites("a stopped turn's approval", 2);
  }

  // The next message: the conversation resumes, the paused call does not.
  // A chat turn resumes the paused turn's session (`sessionResumeStateFrom`)
  // on a fresh bridge (`diskResumeState`).
  on.session = await on.agent.createSession({
    sessionId: on.sessionId,
    resumeFrom: diskResumeState({
      type: "resume-session" as const,
      harnessId: continuation.harnessId,
      specificationVersion: continuation.specificationVersion,
      data: continuation.data,
    }),
  });
  const followUp = await prompt(on, "COUNT");
  report.followUp = followUp;
  say("follow-up", followUp);
  // The stopped turn's prompt may or may not have reached the saved history.
  if (!/SCENARIOS=MCPWRITE,MCPWRITE,(MCPWRITE,)?COUNT\b/.test(followUp.text))
    failures.push(`the follow-up lost the conversation: ${followUp.text.slice(0, 160)}`);
  await sleep(PENDING_MS);
  expectWrites("the follow-up", 2);
  failures.push(...(await on.stop()));

  report.client = path.clients[0];
  report.calls = path.calls;
  if (path.clients.length === 0) failures.push("the server never saw a client identity");
  if (path.calls.some((call) => JSON.stringify(call.meta ?? {}).includes("mcpjam/")))
    failures.push("MCPJam correlation metadata reached the server");
  say(`native MCP: route=${JSON.stringify(report.route)} client=${JSON.stringify(report.client)} writes=${path.writes()} stale=${JSON.stringify(report.staleApproval)}`);
  return { failures, report };
}
