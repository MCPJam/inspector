/**
 * One step of a climb MCPJam picks for: one picker turn and the round it
 * submits. The same function runs on the hosted worker (a claimed step) and in
 * a person's Inspector (a local job); each brings its own lease and bearer.
 *
 * The turn is `runUnifiedAssistantTurn` with no stream. Its tools are the
 * real server's read-only tools and a fixed list of climb and mock operations
 * (`picker-tools.ts`), run as the person who started the climb. The turn's
 * transcript is stored as a chat session before the round is submitted, so the
 * round can link it, and stored again when the turn ends. What the turn cost is
 * reported to the climb so its credit limit sees it.
 *
 * A step never throws a refusal into its runner's loop: it answers what the
 * runner must tell the backend. `submittedRound` is the one thing a runner
 * reports on release; a turn that submitted nothing answers none, and the
 * backend retries it once before it pauses the climb.
 */
import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { logger } from "../../utils/logger.js";
import { createConvexClient } from "../../routes/v1/convex-client.js";
import { climbFns } from "./backend.js";
import { buildPickerPlatformClient } from "./picker-client.js";
import { defaultPickerPorts, type PickerPorts, type PickerTurnResult } from "./picker-ports.js";
import { pickerSystemPrompt, pickerUserMessage } from "./picker-prompt.js";
import { estimateTurnSpend, type TurnSpend } from "./picker-spend.js";
import { buildPickerTools } from "./picker-tools.js";

/** One picker turn's step cap, from the engineering spec (decision 18). */
export const PICKER_MAX_STEPS = 30;

export type StepClaim = {
  climbId: string;
  generation: number;
  projectId: string;
  pickerModel: string;
  heartbeatIntervalMs: number;
  /** A step cut off after it registered its round: the round to launch again, not a new turn. */
  resumeRound: null | { roundNumber: number; unitKey: string; idempotencyKey: string; serverId: string; serverVersion?: string };
};

/** What the runner's lease lets a step do. Each runner (the hosted worker's routes, the local mutations) brings its own. */
export interface StepLease {
  renew(): Promise<{ leaseOk: boolean; stop: boolean }>;
  spend(spend: TurnSpend): Promise<void>;
}

export type StepResult =
  /** The turn ended; `submittedRound` is the round it submitted, if any. */
  | { kind: "done"; submittedRound?: number }
  /** The lease was taken over or ran out: write nothing, and do not release. */
  | { kind: "lost" }
  /** The climb was stopped under the step. */
  | { kind: "stopped" };

export type StepOptions = {
  ports?: PickerPorts;
  /** Aborts the turn from outside, as a shutdown that cannot wait does. */
  signal?: AbortSignal;
};

const sessionIdOf = (claim: StepClaim) => `climb-step-${claim.climbId}-${claim.generation}`;

/** The round a turn submitted, read from its own `submit_climb_round` result. */
export function submittedRoundOf(result: Pick<PickerTurnResult, "toolResults">): number | undefined {
  for (const entry of [...result.toolResults].reverse()) {
    if (entry.toolName !== "submit_climb_round") continue;
    const output = entry.output as { type?: string; value?: unknown } | undefined;
    const value = (output && typeof output === "object" && "type" in output ? output.value : output) as { roundNumber?: unknown; error?: unknown } | undefined;
    if (typeof value?.roundNumber === "number" && !value.error) return value.roundNumber;
  }
  return undefined;
}

export async function runPickerStep(
  claim: StepClaim,
  lease: StepLease,
  getBearer: () => Promise<string>,
  options: StepOptions = {},
): Promise<StepResult> {
  const ports = options.ports ?? defaultPickerPorts;
  const abort = new AbortController();
  options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  let ended: "lost" | "stopped" | undefined;
  // The lease is renewed all through the step; one that is gone ends the turn, and its writes are refused anyway.
  const heartbeat = setInterval(() => {
    lease.renew().then(
      ({ leaseOk, stop }) => {
        if (!leaseOk) ended ??= "lost";
        else if (stop) ended ??= "stopped";
        if (ended) abort.abort();
      },
      (error: unknown) => {
        // An unreachable backend is not a lost lease; it expires by itself if the outage lasts.
        logger.warn("[climbs] a step's heartbeat did not reach the backend", { climbId: claim.climbId, error: error instanceof Error ? error.message : String(error) });
      },
    );
  }, claim.heartbeatIntervalMs);
  heartbeat.unref?.();
  try {
    const result = claim.resumeRound ? await resumeRound(claim, getBearer) : await takeTurn(claim, lease, getBearer, ports, abort.signal);
    return ended ? { kind: ended } : { kind: "done", ...(result !== undefined ? { submittedRound: result } : {}) };
  } catch (error) {
    if (ended) return { kind: ended };
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Launches again a round a cut-off step had registered: the same key replays it, and nothing is charged twice. */
async function resumeRound(claim: StepClaim, getBearer: () => Promise<string>): Promise<number> {
  const resume = claim.resumeRound!;
  const client = buildPickerPlatformClient(getBearer, { climbId: claim.climbId, generation: claim.generation });
  const submitted = await client.submitClimbRound({
    projectId: claim.projectId,
    climbId: claim.climbId,
    serverId: resume.serverId,
    ...(resume.serverVersion ? { serverVersion: resume.serverVersion } : {}),
    idempotencyKey: resume.idempotencyKey,
  });
  return submitted.roundNumber;
}

async function takeTurn(
  claim: StepClaim,
  lease: StepLease,
  getBearer: () => Promise<string>,
  ports: PickerPorts,
  signal: AbortSignal,
): Promise<number | undefined> {
  const { climbId, projectId } = claim;
  const bearer = await getBearer();
  const convex = createConvexClient(bearer);
  const climb: PlatformClimb = await convex.query(climbFns.get, { climbId });
  if (climb.picker !== "mcpjam") throw new Error(`Climb ${climbId} is not picked by MCPJam, so it has no step to run.`);

  const startedAt = Date.now();
  const messages: ModelMessage[] = [{ role: "user", content: pickerUserMessage({ climbId, serverName: climb.serverName, roundsStarted: climb.limits.roundsStarted }) }];
  const modelDefinition = await ports.resolveModel({ modelId: claim.pickerModel, projectId, bearer });
  const chatSessionId = sessionIdOf(claim);
  const authHeader = `Bearer ${bearer}`;
  const { runtime, modelSource = "mcpjam" } = await ports.resolveRuntime({ modelDefinition, projectId, authHeader, chatSessionId, tools: {}, messages });
  const store = (sessionMessages: ModelMessage[], extra: { expectedVersion?: number; turn?: PickerTurnResult }) =>
    ports.persist({
      chatSessionId,
      modelId: String(modelDefinition.id),
      modelSource,
      authHeader,
      projectId,
      sourceType: "direct",
      origin: "mcpjam_agent",
      directVisibility: "project",
      sessionMessages,
      systemPrompt: pickerSystemPrompt(),
      startedAt,
      lastActivityAt: Date.now(),
      ...(extra.expectedVersion !== undefined ? { expectedVersion: extra.expectedVersion } : {}),
      turnTrace: {
        ...(extra.turn?.turnTrace ?? { startedAt, endedAt: Date.now(), spans: [], modelId: String(modelDefinition.id) }),
        turnId: chatSessionId,
        promptIndex: 0,
      },
    });
  // The round links this transcript, so it has to exist before the round is submitted.
  const first = await store(messages, {});
  const linked = first.outcome === "saved" || first.outcome === "duplicate" ? first : undefined;
  if (!linked) logger.warn("[climbs] a picker step's transcript was not stored before its round, so the round will not link it", { climbId, outcome: first.outcome });

  const client = buildPickerPlatformClient(
    getBearer,
    { climbId, generation: claim.generation, ...(linked?.sessionDocId ? { chatSessionId: linked.sessionDocId } : {}) },
    `climb-step:${climbId}:${claim.generation}`,
  );
  const connection = await ports.connect({ projectId, bearer, serverId: climb.serverId });
  try {
    const prepared = await ports.prepareChat({
      mcpClientManager: connection.manager,
      selectedServers: [climb.serverId],
      modelDefinition,
      systemPrompt: pickerSystemPrompt(),
      requireToolApproval: false,
      excludeMcpToolNames: connection.writeTools,
      builtInTools: buildPickerTools({ convex, client, projectId, climbId }),
    });
    const hosted = runtime.kind === "hosted";
    const common = {
      streamSink: "none" as const,
      messages,
      systemPrompt: prepared.enhancedSystemPrompt,
      tools: prepared.allTools,
      maxSteps: PICKER_MAX_STEPS,
      abortSignal: signal,
      ...(prepared.progressivePlan ? { progressivePlan: prepared.progressivePlan } : {}),
      ...(prepared.discoveryState ? { discoveryState: prepared.discoveryState } : {}),
    };
    const turn = await ports.runTurn(
      hosted
        ? {
            ...common,
            runtime,
            persistMode: "caller",
            approvalMode: "auto-deny",
            sourceType: "direct",
            origin: "mcpjam_agent",
            modelDefinition,
            mcpClientManager: connection.manager,
            authContext: { kind: "user_bearer", token: authHeader },
            projectId,
            chatSessionId,
          }
        : { ...common, runtime },
    );
    if (turn.aborted) return undefined;
    // What the turn cost counts against the climb whether or not it submitted anything.
    await reportSpend(lease, await estimateTurnSpend(turn, String(modelDefinition.id)), claim);
    if (linked?.version !== undefined) {
      const final = await store(turn.messages, { expectedVersion: linked.version, turn });
      if (final.outcome !== "saved" && final.outcome !== "duplicate") {
        logger.warn("[climbs] a picker step's finished transcript was not stored", { climbId, outcome: final.outcome });
      }
    }
    return submittedRoundOf(turn) ?? (await roundsStartedSince(convex, climbId, climb.limits.roundsStarted));
  } finally {
    await connection.close();
  }
}

async function reportSpend(lease: StepLease, spend: TurnSpend, claim: StepClaim): Promise<void> {
  try {
    await lease.spend(spend);
  } catch (error) {
    // The turn already ran; the credit limit sees this turn's cost late, never the round's.
    logger.warn("[climbs] a picker step's spend was not reported", { climbId: claim.climbId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** A round the turn's own result did not show (its answer was cut for size): the climb's count tells. */
async function roundsStartedSince(convex: Pick<ConvexHttpClient, "query">, climbId: string, before: number): Promise<number | undefined> {
  const climb: PlatformClimb = await convex.query(climbFns.get, { climbId });
  return climb.limits.roundsStarted > before ? climb.limits.roundsStarted : undefined;
}
