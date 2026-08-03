/**
 * POST /api/v1/projects/:projectId/agent — headless agent turn over the
 * public API.
 *
 * An external caller (first consumer: the MCPJam Slack bot) sends a plain
 * message history; the server runs ONE assistant turn through the shared
 * engine facade (`runUnifiedAssistantTurn`) with a curated set of platform
 * operations as tools, and returns the final assistant text plus references
 * to any resources the turn created. Synchronous JSON — the caller holds
 * conversation state and resends history each turn.
 *
 * RETRY CONTRACT: send `idempotencyKey` — a STABLE identity for the
 * triggering event, not a fresh uuid per attempt (the Slack app sends
 * `${teamId}:${event_id}`). Each WRITE op the turn performs derives its own
 * key from it, so a retried turn re-issues the same mutations onto the same
 * rows instead of authoring duplicate suites. Error responses still carry
 * `details.createdResources` so a caller can see what a failed turn already
 * persisted.
 *
 * The key makes a retry SAFE; it does not make one free. Callers should still
 * dedupe at their own trigger (the Slack app claims each event durably before
 * processing) so most retries never re-run the turn at all — and a retry whose
 * model authors materially different arguments hashes differently and is
 * correctly treated as a different write. Omitting the key preserves the old
 * non-idempotent behaviour rather than being rejected.
 *
 * Surface decisions (see the Slack-app v1 plan):
 *  - Tools are READ ops + atomic `create_eval_suite` ONLY. Run/cancel ops
 *    (spend eval quota) and `generate_eval_cases` (spends org credits) are
 *    excluded: `approvalMode: "auto-deny"` has no interactive fallback, so
 *    an unattended turn must never spend on the model's own initiative.
 *    Runs stay human-gated caller-side (the Slack "Run it" button posts to
 *    POST /eval-runs directly).
 *  - Every operation is HARD-CLAMPED to the route's `projectId`. The op
 *    catalog's `project` selector allows cross-project roaming for other
 *    surfaces; prompt instructions are not an authorization boundary, so
 *    this adapter overwrites the input and rejects mismatching explicit
 *    values. Org isolation stays enforced by Convex via the delegated JWT.
 *  - The model is pinned server-side (hosted catalog), billed to the
 *    caller's project through the hosted `/stream` rail.
 *  - No chat-session persistence: the caller owns the transcript.
 *  - No tasks seam (the /api/v1 surface refuses task opt-ins by type).
 *
 * Auth plumbing: the caller authenticates with a WorkOS API key (`sk_…`),
 * but BOTH the engine's Convex `/stream` calls and the self-dispatched
 * platform-op calls need a JWT — so the delegated org-scoped JWT minted by
 * `getConvexBearerForRequest` is used for both. Routing the ops through the
 * delegated JWT (not the raw `sk_` key) also keeps the agent's own tool
 * calls out of the caller's per-key rate bucket.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  PlatformApiClient,
  cancelEvalRunOperation,
  createEvalCaseOperation,
  createEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getEvalSuiteOperation,
  getHostOperation,
  listEnvironmentsOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listHostsOperation,
  listProjectServersOperation,
  listServerToolsOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { MCPJAM_HOSTED_ORIGIN, WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { parseWithSchema } from "../web/errors.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  deriveOperationIdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from "../../utils/idempotency.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import {
  capForModel,
  toToolError,
} from "../../utils/built-in-tools/mcpjam.js";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import type { ModelDefinition } from "@/shared/types";
import { captureServerEvent } from "../../utils/analytics.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import { logger } from "../../utils/logger.js";
import { createProposedAction } from "../../services/slack-backend.js";
import { v1Error, v1Resource } from "./envelope.js";

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/**
 * The public-agent op list: reads + atomic suite creation. Deliberately NOT
 * derived from the in-app `WORKSPACE_OPERATIONS` set (and deliberately not
 * added to it — `isMcpjamToolId` must keep returning false for
 * `create_eval_suite`, or the in-app chat gate widens).
 */
export const AGENT_API_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, unknown>
> = [
  // READ — free, and the difference between an agent that inspects the
  // project and one that guesses at it.
  listProjectServersOperation,
  listServerToolsOperation,
  listEvalSuitesOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  getEvalCaseOperation,
  listEvalSuiteRunsOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalRunStepsOperation,
  listHostsOperation,
  getHostOperation,
  listEnvironmentsOperation,
  // WRITE — persists, but spends nothing. Every one is idempotency-keyed
  // (see WRITE_OPERATION_NAMES) and echoed in the response envelope.
  createEvalSuiteOperation,
  createEvalCaseOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
];

/**
 * GATED — operations that SPEND (eval quota, org credits).
 *
 * The model gets a tool per operation with the operation's REAL input schema,
 * but the tool does not execute: it validates, persists a proposal, and
 * returns an action id. A human click is what runs it.
 *
 * `approvalMode: "auto-deny"` means an unattended turn has no interactive
 * fallback, so the alternative to a proposal is not "ask the user" — it is
 * either spending on the model's own initiative or not offering the action at
 * all. Destructive ops (`delete_*`, `use_sandbox_image`, `reset_computer`)
 * stay excluded entirely: a proposal makes spend deliberate, but it does not
 * make an irreversible deletion recoverable.
 */
export const AGENT_API_GATED_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, unknown>
> = [
  runEvalSuiteOperation,
  runEvalCaseOperation,
  generateEvalCasesOperation,
  cancelEvalRunOperation,
];

/**
 * Operations that PERSIST. Every one of these gets a derived per-call
 * idempotency key when the caller supplied a turn key, so a retried turn's
 * writes land on the rows the first attempt created instead of duplicating
 * them. Read ops are excluded deliberately: a key on a read is noise on the
 * wire and would be stored on nothing.
 *
 * This set must grow whenever a write op is added to `AGENT_API_OPERATIONS` —
 * a write left out of it silently loses retry safety, which is exactly the
 * failure this endpoint's docblock used to warn about.
 */
const WRITE_OPERATION_NAMES: ReadonlySet<string> = new Set([
  createEvalSuiteOperation.name,
  createEvalCaseOperation.name,
  updateEvalCaseOperation.name,
  updateEvalSuiteOperation.name,
]);

export type CreatedResource = {
  type: "eval_suite";
  id: string;
  name?: string;
  url: string;
};

function suiteUrl(suiteId: string, projectId: string): string {
  // `?project=` makes the link self-describing: eval routes carry no project
  // segment, so without it the app renders whatever project the viewer's
  // picker was parked on (an empty state for everyone but the author).
  return `${MCPJAM_HOSTED_ORIGIN}/evals/suite/${encodeURIComponent(suiteId)}?project=${encodeURIComponent(projectId)}`;
}

const PROJECT_SCOPE_ERROR =
  "This agent surface is scoped to a single project; omit the `project` " +
  "argument (it is filled in automatically).";

/**
 * Some catalog ops (e.g. `get_eval_run`) REQUIRE `project` in their input
 * schema — which would tell the model the field is mandatory while the
 * system prompt says to omit it (the clamp fills it in). Advertise the
 * field as optional instead, without touching the op's own schema.
 * @param schema the operation's zod input schema
 */
function relaxProjectRequirement(schema: unknown): unknown {
  const asObject = schema as z.ZodObject<z.ZodRawShape> | undefined;
  if (!asObject?.shape?.project || typeof asObject.extend !== "function") {
    return schema;
  }
  return asObject.extend({
    project: z
      .string()
      .trim()
      .optional()
      .describe("Omit — automatically scoped to the current project."),
  });
}

/**
 * Project-scope hygiene: several listing ops return `otherProjects`
 * (switching metadata for roaming surfaces). This surface is clamped to
 * one project, so that list would disclose the org's other projects to
 * the model and the caller — strip it.
 * @param result a platform-op result
 */
function stripProjectSwitchingMetadata(result: unknown): unknown {
  if (result && typeof result === "object" && "otherProjects" in result) {
    const { otherProjects: _dropped, ...rest } = result as Record<
      string,
      unknown
    >;
    return rest;
  }
  return result;
}

export type ProposedAction = {
  actionId: string;
  operation: string;
  /** The validated, project-clamped input the click will execute. */
  input: Record<string, unknown>;
  /** Human-readable summary for the button. Never a promise — see below. */
  description: string;
};

/**
 * Build the proposal-only tools for the GATED operations.
 *
 * Each tool carries the operation's REAL input schema, so the model is
 * validated against the same contract execution would use — a proposal that
 * would fail at execution time is a proposal that should never have been
 * offered, and a human is about to be asked to approve it.
 *
 * The proposal is persisted server-side and the model receives only an opaque
 * `actionId`. That is what makes the click safe: the button carries the id,
 * the backend supplies the operation, and nothing the model or the click
 * payload says can change what runs.
 */
function buildGatedProposalTools(opts: {
  projectId: string;
  proposed: ProposedAction[];
  slack?: { teamId: string; channelId: string; slackUserId: string; organizationId: string };
}): ToolSet {
  const tools: ToolSet = {};
  for (const operation of AGENT_API_GATED_OPERATIONS) {
    tools[operation.name] = tool({
      description:
        `${operation.description} ` +
        "REQUIRES HUMAN APPROVAL: calling this does NOT run it. It proposes " +
        "the action and returns an approval id; a person must click to " +
        "confirm. Say that you have proposed it — never that it has run or " +
        "started.",
      inputSchema: relaxProjectRequirement(
        operation.inputSchema
      ) as typeof operation.inputSchema,
      execute: async (input: Record<string, unknown>) => {
        const requested =
          typeof input.project === "string" ? input.project.trim() : "";
        if (requested && requested !== opts.projectId) {
          return { error: PROJECT_SCOPE_ERROR };
        }
        // Validate against the op's REAL schema. Same field-addressed error
        // shape as the executing tools, so the model can correct and retry.
        const clamped = { ...input, project: opts.projectId };
        const parsed = (
          operation.inputSchema as z.ZodType<Record<string, unknown>>
        ).safeParse(clamped);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          return {
            error: `Invalid input for ${operation.name} — fix these fields and retry: ${issues}`,
          };
        }

        if (!opts.slack) {
          // No surface to render a button on. Refusing is the honest answer:
          // silently proposing into the void would let the model report an
          // action as pending that nobody can ever approve.
          return {
            error: `${operation.title} needs human approval, which this caller cannot collect. Ask the user to run it from the MCPJam app.`,
          };
        }

        const actionId = randomUUID();
        try {
          await createProposedAction({
            actionId,
            teamId: opts.slack.teamId,
            channelId: opts.slack.channelId,
            operation: operation.name,
            input: parsed.data,
            organizationId: opts.slack.organizationId,
            projectId: opts.projectId,
            proposedBySlackUserId: opts.slack.slackUserId,
          });
        } catch (error) {
          logger.warn("[v1/agent] could not persist a proposed action", {
            operation: operation.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            error: `Could not propose ${operation.title} right now. Try again in a moment.`,
          };
        }

        const description = describeProposal(operation.name, parsed.data);
        opts.proposed.push({
          actionId,
          operation: operation.name,
          input: parsed.data,
          description,
        });
        return {
          proposed: true,
          actionId,
          description,
          note: "Awaiting human approval. Do not claim this has started.",
        };
      },
    });
  }
  return tools;
}

/**
 * A short, concrete summary of what a click will do.
 *
 * States the TARGET, not a cost: any number here would be an estimate, and an
 * estimate rendered next to an approval button reads as a promise. The caller
 * renders its own cost hint alongside, clearly labelled as one.
 */
function describeProposal(
  operationName: string,
  input: Record<string, unknown>
): string {
  const named = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  switch (operationName) {
    case runEvalSuiteOperation.name:
      return `Run eval suite ${named("suite") ?? named("suiteId") ?? "(unnamed)"}`;
    case runEvalCaseOperation.name:
      return `Run eval case ${named("case") ?? named("caseId") ?? "(unnamed)"}`;
    case generateEvalCasesOperation.name:
      return `Generate eval cases for ${named("suite") ?? named("suiteId") ?? "(unnamed)"}`;
    case cancelEvalRunOperation.name:
      return `Cancel run ${named("run") ?? named("runId") ?? "(unnamed)"}`;
    default:
      return operationName;
  }
}

/**
 * Build the endpoint's ToolSet from the op list: one AI-SDK tool per
 * operation, with (a) the project input clamped to the route's projectId and
 * (b) successful create results collected into `created` BEFORE the
 * model-facing cap can truncate them.
 */
export function buildAgentApiToolSet(opts: {
  client: PlatformApiClient;
  projectId: string;
  created: CreatedResource[];
  /**
   * The caller's turn-level idempotency key (the Slack bot sends
   * `${teamId}:${event_id}`). When present, every WRITE op is dispatched
   * through a client that carries a key derived from it.
   */
  turnIdempotencyKey?: string;
  /**
   * Builds a client that stamps `extraHeaders` on its requests. A per-call
   * client is used rather than mutating shared state because tool calls can
   * run concurrently — a shared "current key" holder would let one call's key
   * be applied to another's write.
   */
  clientWithHeaders?: (extraHeaders: Record<string, string>) => PlatformApiClient;
}): ToolSet {
  const tools: ToolSet = {};
  for (const operation of AGENT_API_OPERATIONS) {
    tools[operation.name] = tool({
      description: `${operation.description} (Scoped to the current project automatically.)`,
      inputSchema: relaxProjectRequirement(
        operation.inputSchema
      ) as typeof operation.inputSchema,
      execute: async (input: Record<string, unknown>, { abortSignal }) => {
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }
        // HARD CLAMP: the route's project always wins. An explicit different
        // selector is rejected rather than silently rewritten so the model
        // learns the boundary instead of believing it roamed.
        const requested =
          typeof input.project === "string" ? input.project.trim() : "";
        if (requested && requested !== opts.projectId) {
          return { error: PROJECT_SCOPE_ERROR };
        }
        // Pre-validate against the op's REAL schema and return a
        // field-addressed error: downstream validation (the v1 route's
        // parseWithSchema) flattens zod failures to a bare "Invalid input",
        // which gives the model nothing to correct — it wanders off to docs
        // and burns the step budget instead of fixing the field.
        const clamped = { ...input, project: opts.projectId };
        const parsed = (
          operation.inputSchema as z.ZodType<Record<string, unknown>>
        ).safeParse(clamped);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          return {
            error: `Invalid input for ${operation.name} — fix these fields and retry: ${issues}`,
          };
        }
        // Write ops carry a derived key so a retried turn re-issuing the same
        // call lands on the row the first attempt created. The key is derived
        // from the VALIDATED input, not the raw one, so two inputs that
        // normalize identically share a key.
        let client = opts.client;
        if (
          opts.turnIdempotencyKey &&
          opts.clientWithHeaders &&
          WRITE_OPERATION_NAMES.has(operation.name)
        ) {
          client = opts.clientWithHeaders({
            [IDEMPOTENCY_KEY_HEADER]: deriveOperationIdempotencyKey(
              opts.turnIdempotencyKey,
              operation.name,
              parsed.data
            ),
          });
        }

        try {
          const result = await operation.execute(parsed.data, {
            client,
            signal: abortSignal,
          });
          if (operation.name === createEvalSuiteOperation.name) {
            const suite = (result as { suite?: { id?: string; name?: string } })
              ?.suite;
            if (suite?.id) {
              opts.created.push({
                type: "eval_suite",
                id: suite.id,
                ...(suite.name ? { name: suite.name } : {}),
                url: suiteUrl(suite.id, opts.projectId),
              });
            }
          }
          return capForModel(stripProjectSwitchingMetadata(result));
        } catch (error) {
          if (abortSignal?.aborted) {
            return { error: `${operation.title} was cancelled.` };
          }
          return toToolError(error, `${operation.title} failed.`);
        }
      },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Model + prompt (both static per build, on purpose)
// ---------------------------------------------------------------------------

/**
 * Pinned hosted model. There is no "hosted default" lookup in the catalog —
 * this is an explicit product choice, validated against the live catalog per
 * request so a catalog outage/self-hosted install fails loudly instead of
 * mis-billing.
 */
const AGENT_API_MODEL: ModelDefinition = {
  id: "anthropic/claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  hosted: true,
};

/**
 * Default model for AUTHORED SUITES — deliberately not the agent's own
 * model. Suites run every case × iteration on a schedule, so the default
 * is the cheap eval workhorse (same one the public-API docs examples
 * use); the user can always name a bigger model.
 */
const DEFAULT_SUITE_MODEL = "anthropic/claude-haiku-4.5";

/**
 * Static per build — nothing volatile (no projectId, no timestamp) so the
 * cacheable prompt prefix survives across a conversation's requests. The
 * project boundary is enforced by the tool adapter, not the prompt, so the
 * prompt only needs to SAY it, not carry the id.
 */
const AGENT_API_SYSTEM_PROMPT = [
  "## You are the MCPJam agent",
  "You help users work with their MCPJam project over an API surface (the first host is the MCPJam Slack app). Your specialty is turning conversations into eval suites: reading what the user wants tested, authoring test cases, and creating runnable suites with `create_eval_suite`.",
  "",
  "## Ground rules",
  "- Every operation is automatically scoped to the caller's current project. Omit the `project` argument.",
  "- NEVER invent server names or ids. Call `list_project_servers` first and use exactly what it returns. If no server matches what the user described, ask which server they mean — do not guess and do not fabricate placeholders.",
  "- Before authoring tool-call assertions, check the server's real tool names with `list_server_tools`.",
  "- Author cases as `steps` arrays; prefer a `prompt` step plus `toolCalledWith`-style assertions on the tools the conversation showed. Set `expectedOutput` when the user stated one.",
  `- When creating a suite, set the suite \`model\` explicitly to \`${DEFAULT_SUITE_MODEL}\` unless the user asks for a different model.`,
  "- Some actions SPEND the user's quota or credits (running a suite or a case, generating cases, cancelling a run). Calling those tools does NOT perform them: it PROPOSES the action and returns an approval id, and a person must click to confirm. Say that you've proposed it and what it will do. NEVER say it has started, is running, or has been cancelled.",
  "- If a proposal tool is not available to you, you cannot run anything at all. Say so plainly and report the ids the user needs — do not imply you started something.",
  "- Always report the ids of anything you created.",
  "- Tool input schemas are AUTHORITATIVE. Never consult docs to learn a tool's argument shape — the schema you were given is the truth. If a tool returns a validation error naming fields, correct exactly those fields and retry the same call.",
  "- Consult the MCPJam docs tools (when available) for product questions instead of answering from memory.",
  "- Keep replies concise and concrete. If the request is ambiguous, ask instead of inventing.",
].join("\n");

// ---------------------------------------------------------------------------
// Request/response contract
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGE_BYTES = 8_192;
/**
 * Aggregate history budget: the per-message caps alone would admit
 * ~400 KB (50 × 8 KB) per request; the whole history must fit a far
 * smaller envelope since every byte is resent each turn and billed.
 */
const MAX_TOTAL_MESSAGE_BYTES = 98_304; // 96 KB
const MAX_STEPS = 16;
const TURN_WALL_CLOCK_MS = 90_000;
/** In-process per-org concurrent-turn cap (same shape as evals' run cap). */
const MAX_CONCURRENT_TURNS_PER_ORG = 4;

const agentTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          // The quota is a spend cap, so enforce BYTES too — a char-only
          // limit is 4x bypassable with multibyte text.
          .refine(
            (value) => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
            { message: `Message exceeds ${MAX_MESSAGE_BYTES} bytes` }
          ),
      })
    )
    .min(1)
    .max(MAX_MESSAGES)
    .refine(
      (messages) =>
        messages.reduce(
          (total, message) => total + Buffer.byteLength(message.content, "utf8"),
          0
        ) <= MAX_TOTAL_MESSAGE_BYTES,
      {
        message: `Message history exceeds ${MAX_TOTAL_MESSAGE_BYTES} total bytes`,
      }
    ),
  /**
   * Caller's stable identity for THIS turn — the Slack bot sends
   * `${teamId}:${event_id}`. Every write the turn performs derives its own key
   * from it, so a redelivered event that re-runs the turn re-issues the same
   * mutations onto the same rows instead of authoring duplicates.
   *
   * Optional: callers that genuinely cannot produce a stable trigger identity
   * keep the previous (non-idempotent) behaviour rather than being rejected.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * Where a proposal's approval button will be rendered. Required for the
   * GATED tools to be usable at all — without a surface to collect the click,
   * proposing is refused rather than silently queued somewhere nobody can
   * approve it.
   */
  slackChannelId: z.string().min(1).max(64).optional(),
});

const activeTurnsByOrg = new Map<string, number>();

function acquireTurnSlot(key: string): boolean {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active >= MAX_CONCURRENT_TURNS_PER_ORG) return false;
  activeTurnsByOrg.set(key, active + 1);
  return true;
}

function releaseTurnSlot(key: string): void {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active <= 1) activeTurnsByOrg.delete(key);
  else activeTurnsByOrg.set(key, active - 1);
}

// Docs MCP server: read-only product knowledge, same source as the in-app
// agent. Preflighted below — an outage degrades the turn, never fails it.
const DOCS_SERVER_ID = "mcpjam-docs";
const DEFAULT_DOCS_URL = "https://docs.mcpjam.com/mcp";
/** Docs are a nice-to-have — never let their preflight eat the turn budget. */
const DOCS_PREFLIGHT_TIMEOUT_MS = 5_000;

function extractAssistantText(
  assistantMessages: Array<{ content: unknown }>
): string {
  const parts: string[] = [];
  for (const message of assistantMessages) {
    if (typeof message.content === "string") {
      if (message.content) parts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

const agent = new Hono();

agent.post("/projects/:projectId/agent", async (c) => {
  const projectId = c.req.param("projectId");

  // Graceful degradation on OSS/self-hosted installs: the hosted engine and
  // the delegated-token mint both require the backend wiring.
  if (!process.env.CONVEX_HTTP_URL || !process.env.INSPECTOR_SERVICE_TOKEN) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "The agent endpoint requires a hosted MCPJam deployment."
    );
  }

  if (!isHostedCatalogModel(String(AGENT_API_MODEL.id), "anthropic")) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "The agent endpoint's hosted model is unavailable on this deployment."
    );
  }

  const body = parseWithSchema(
    agentTurnSchema,
    await c.req.json().catch(() => {
      return {};
    })
  );

  // sk_ callers get their org id from bearer auth; JWT callers reach this
  // route with neither var set (their bearer is validated at Convex), so
  // fall back to a PROJECT-scoped bucket — a shared global bucket would let
  // one tenant exhaust the endpoint for everyone.
  const orgKey =
    c.get("mcpjamOrganizationId") ??
    c.get("workosUserId") ??
    `project:${projectId}`;
  if (!acquireTurnSlot(orgKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent agent turns for this organization (max ${MAX_CONCURRENT_TURNS_PER_ORG}).`
    );
  }

  const startedAt = Date.now();
  let manager: MCPClientManager | undefined;
  const abortController = new AbortController();
  const wallClock = setTimeout(
    () => abortController.abort(),
    TURN_WALL_CLOCK_MS
  );
  // Caller disconnects (Slack gave up, network drop) must also stop the
  // turn — an abandoned request should not keep consuming model capacity.
  const requestSignal = c.req.raw.signal;
  const onRequestAbort = () => abortController.abort();
  if (requestSignal.aborted) {
    abortController.abort();
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  try {
    // One delegated org-scoped JWT for both the engine's Convex calls and the
    // self-dispatched platform-op calls (see module docblock).
    const convexJwt = await getConvexBearerForRequest(c);
    const authHeader = `Bearer ${convexJwt}`;

    const selfFetch = getSelfFetch();
    if (!selfFetch) {
      return v1Error(
        c,
        "INTERNAL_ERROR",
        "In-process /api/v1 dispatch is not registered."
      );
    }
    const makeClient = (extraHeaders: Record<string, string> = {}) =>
      new PlatformApiClient({
        baseUrl: "http://self.mcpjam.internal/api/v1",
        getAuth: () => convexJwt,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          for (const [name, value] of Object.entries(extraHeaders)) {
            request.headers.set(name, value);
          }
          return selfFetch(request);
        },
      });
    const client = makeClient();

    const created: CreatedResource[] = [];
    const proposed: ProposedAction[] = [];
    // Proposals need a Slack surface AND an org to attribute them to; both
    // come from `slack_service` auth. Other callers get the read/write tiers
    // only — the gated tools are omitted entirely rather than offered and
    // then refused, so the model never plans around an action it cannot take.
    const slackTeamId = c.get("slackTeamId");
    const slackUserId = c.get("slackUserId");
    const organizationId = c.get("mcpjamOrganizationId");
    const slackProposalContext =
      c.get("authMethod") === "slack_service" &&
      slackTeamId &&
      slackUserId &&
      organizationId &&
      body.slackChannelId
        ? {
            teamId: slackTeamId,
            channelId: body.slackChannelId,
            slackUserId,
            organizationId,
          }
        : undefined;

    const builtInTools = {
      ...buildAgentApiToolSet({
        client,
        projectId,
        created,
        ...(body.idempotencyKey
          ? { turnIdempotencyKey: body.idempotencyKey }
          : {}),
        clientWithHeaders: makeClient,
      }),
      ...(slackProposalContext
        ? buildGatedProposalTools({
            projectId,
            proposed,
            slack: slackProposalContext,
          })
        : {}),
    };

    // Docs server with preflight-degrade: `getToolsForAiSdk` (inside
    // `prepareChatV2`) fails the whole turn when a selected server errors at
    // connect/list time, so a docs outage must deselect it, not 500 the turn.
    manager = new MCPClientManager(
      {
        [DOCS_SERVER_ID]: {
          url: process.env.MCPJAM_DOCS_MCP_URL ?? DEFAULT_DOCS_URL,
          timeout: 30_000,
        },
      },
      {
        defaultTimeout: WEB_STREAM_TIMEOUT_MS,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      }
    );
    // The preflight must stay inside the turn's wall clock: the docs
    // client's own 30 s connect timeout would otherwise stack ON TOP of
    // the 90 s budget. Race it against a short deadline + the turn signal;
    // any non-success degrades (no docs), never delays or fails the turn.
    // The losing timer is disarmed once the race settles so a successful
    // preflight can't later emit a false timeout warning.
    let preflightDeadline: NodeJS.Timeout | undefined;
    let onPreflightAbort: (() => void) | undefined;
    const docsAvailable = await Promise.race([
      manager.listTools(DOCS_SERVER_ID).then(
        () => true,
        (reason) => {
          logger.warn("[v1/agent] docs MCP server unavailable; continuing", {
            error: reason instanceof Error ? reason.message : String(reason),
          });
          return false;
        }
      ),
      new Promise<boolean>((resolve) => {
        preflightDeadline = setTimeout(() => {
          logger.warn("[v1/agent] docs MCP preflight timed out; continuing");
          resolve(false);
        }, DOCS_PREFLIGHT_TIMEOUT_MS);
        onPreflightAbort = () => resolve(false);
        abortController.signal.addEventListener("abort", onPreflightAbort, {
          once: true,
        });
      }),
    ]).finally(() => {
      if (preflightDeadline !== undefined) clearTimeout(preflightDeadline);
      if (onPreflightAbort) {
        abortController.signal.removeEventListener("abort", onPreflightAbort);
      }
    });
    const selectedServers = docsAvailable ? [DOCS_SERVER_ID] : [];

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers,
      modelDefinition: AGENT_API_MODEL,
      systemPrompt: AGENT_API_SYSTEM_PROMPT,
      builtInTools,
      skillsSource: { kind: "none" },
      // The toolset is small and fixed — discovery meta-tools would only
      // add search/load indirection steps and hide the op schemas.
      progressiveToolDiscovery: { enabled: false },
    });

    const chatSessionId = randomUUID();
    const rt = await resolveTurnRuntime({
      modelDefinition: AGENT_API_MODEL,
      projectId,
      authHeader,
      sourceType: "direct",
      chatSessionId,
      tools: prepared.allTools,
    });
    if (rt.runtime.kind !== "hosted") {
      // Unreachable for a pinned hosted-catalog model; guard so a resolver
      // change can't silently route this endpoint onto a BYOK rail.
      return v1Error(
        c,
        "INTERNAL_ERROR",
        "Agent turn resolved to an unexpected runtime."
      );
    }

    let lastEngineError:
      | { message: string; code?: string; httpStatus?: number }
      | undefined;

    const result = await runUnifiedAssistantTurn({
      runtime: rt.runtime,
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      messages: body.messages,
      modelDefinition: AGENT_API_MODEL,
      systemPrompt: prepared.enhancedSystemPrompt,
      tools: prepared.allTools,
      mcpClientManager: manager,
      authContext: { kind: "user_bearer", token: authHeader },
      sourceType: "direct",
      origin: "mcpjam_agent",
      maxSteps: MAX_STEPS,
      projectId,
      chatSessionId,
      abortSignal: abortController.signal,
      ...(prepared.progressivePlan
        ? { progressivePlan: prepared.progressivePlan }
        : {}),
      ...(prepared.discoveryState
        ? { discoveryState: prepared.discoveryState }
        : {}),
      onEngineError: (event: {
        message: string;
        code?: string;
        httpStatus?: number;
      }) => {
        lastEngineError = event;
      },
    });

    // A failed/timed-out turn may still have PERSISTED suites (the create
    // op completed before the failure). Surface them in the error details
    // so a retrying caller doesn't double-create.
    const errorDetails = () => {
      const details: Record<string, unknown> = {};
      if (created.length > 0) details.createdResources = created;
      // A failed turn may still have PROPOSED actions. Surfacing them lets a
      // caller render the buttons anyway rather than stranding approvals the
      // user was about to be offered.
      if (proposed.length > 0) details.proposedActions = proposed;
      return Object.keys(details).length > 0 ? details : undefined;
    };

    if (abortController.signal.aborted) {
      captureTurnEvent(c, {
        startedAt,
        outcome: "timeout",
        toolCallCount: result.toolCalls.length,
      });
      return v1Error(
        c,
        "TIMEOUT",
        `Agent turn exceeded the ${TURN_WALL_CLOCK_MS / 1000}s limit.`,
        errorDetails()
      );
    }

    // Hosted-engine failure contract: a missing turnTrace on a non-aborted
    // turn means the engine failed; the structured cap/quota detail only
    // arrives via onEngineError in streamSink:"none" mode.
    if (!result.turnTrace) {
      const message =
        lastEngineError?.message ??
        "Agent turn failed: the engine returned no turn trace.";
      const rateLimited =
        lastEngineError?.httpStatus === 429 ||
        rt.classifyFailure(message) === "rate_limited";
      captureTurnEvent(c, {
        startedAt,
        outcome: rateLimited ? "rate_limited" : "failed",
        toolCallCount: result.toolCalls.length,
      });
      return v1Error(
        c,
        rateLimited ? "RATE_LIMITED" : "INTERNAL_ERROR",
        message,
        errorDetails()
      );
    }

    const reply = extractAssistantText(result.assistantMessages);
    captureTurnEvent(c, {
      startedAt,
      outcome: "ok",
      toolCallCount: result.toolCalls.length,
      opNames: result.toolCalls.map((call) => call.toolName),
      createdCount: created.length,
    });

    return v1Resource(c, {
      reply,
      toolCalls: result.toolCalls.map((call) => ({
        operation: call.toolName,
      })),
      createdResources: created,
      // Actions awaiting a human click. The caller renders these as buttons;
      // the `actionId` is all a click needs to carry, because the backend
      // holds what it does.
      proposedActions: proposed,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      },
    });
  } finally {
    clearTimeout(wallClock);
    requestSignal.removeEventListener("abort", onRequestAbort);
    releaseTurnSlot(orgKey);
    // Cleanup must never clobber or delay the response — guard against a
    // SYNC throw too (a bare call would escape the finally and discard a
    // computed 200). Detached rather than awaited, but observably so: a
    // failed teardown is logged, never swallowed silently.
    try {
      void manager?.disconnectAllServers().catch((error) => {
        logger.warn("[v1/agent] MCP manager teardown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn("[v1/agent] MCP manager teardown threw synchronously", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

/**
 * Server-authoritative telemetry (`agent_turn_completed` is client-only —
 * this surface has no client). Names, booleans, counts, durations ONLY:
 * tool args/outputs here are customer conversation content.
 */
function captureTurnEvent(
  c: Parameters<typeof captureServerEvent>[0],
  data: {
    startedAt: number;
    outcome: "ok" | "failed" | "rate_limited" | "timeout";
    toolCallCount: number;
    opNames?: string[];
    createdCount?: number;
  }
): void {
  // API-key callers never pass the Convex authorize exchange that normally
  // fills `userExternalId`; the WorkOS user id from bearer auth IS the
  // actorKey the analytics identity contract requires.
  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  const workosUserId = c.get("workosUserId");
  if (ctx && !ctx.userExternalId && workosUserId) {
    c.set("requestLogContext", { ...ctx, userExternalId: workosUserId });
  }
  captureServerEvent(c, "api_agent_turn_completed", {
    surface: "api",
    outcome: data.outcome,
    duration_ms: Date.now() - data.startedAt,
    tool_call_count: data.toolCallCount,
    ...(data.opNames ? { op_names: data.opNames } : {}),
    ...(data.createdCount !== undefined
      ? { created_count: data.createdCount }
      : {}),
  });
}

export default agent;
