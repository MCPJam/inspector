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
 *  - Tools are TIERED by what an operation costs. READ ops and non-spending
 *    WRITE ops (`AGENT_API_OPERATIONS`) execute directly. Ops that SPEND —
 *    run suite, run case, generate cases, cancel run
 *    (`AGENT_API_GATED_OPERATIONS`) — are PROPOSAL-ONLY: the tool validates
 *    against the op's real schema, persists a proposal, and returns an opaque
 *    action id; a human click executes it. `approvalMode: "auto-deny"` has no
 *    interactive fallback, so an unattended turn must never spend on the
 *    model's own initiative. Destructive ops stay excluded entirely — a
 *    proposal makes spend deliberate, not a deletion recoverable.
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
  createEvalSuiteOperation,
  derivePermalinksFor,
  runEvalSuiteOperation,
  withPermalinkEnvelope,
  type PlatformPermalink,
  type PlatformResourceType,
} from "@mcpjam/sdk/platform";
import type { ProposedAction as PublicProposedAction } from "@mcpjam/sdk/public-api";
import {
  AGENT_API_GATED_OPERATIONS,
  AGENT_API_OPERATIONS,
  AGENT_OP_PROMPT_NOTES,
  listAgentOpCatalog,
  proposalMetaFor,
  WRITE_OPERATION_NAMES,
  type AnyPlatformOperation,
} from "./agent-op-registry.js";
import {
  resolveProposalSurface,
  type ProposalSurface,
} from "./approval-surface.js";
import { MCPJAM_HOSTED_ORIGIN, WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { parseWithSchema } from "../web/errors.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import {
  deriveOperationIdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from "../../utils/idempotency.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import { capForModel, toToolError } from "../../utils/built-in-tools/mcpjam.js";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import type { ModelDefinition } from "@/shared/types";
import { captureServerEvent } from "../../utils/analytics.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import { logger } from "../../utils/logger.js";
import { createProposedAction } from "../../services/slack-backend.js";
import { getOrgAgentPolicyCached } from "../../utils/org-agent-policy.js";
import { v1Error, v1Resource } from "./envelope.js";

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

// The tool surface itself now lives in `agent-op-registry.ts`: one entry per
// operation, with the tier, the proposal copy, and any prompt guidance. The
// tiers and the idempotency set are DERIVED from it and re-exported here so
// existing importers (the approval route, the tests) keep their import site.
export {
  AGENT_API_GATED_OPERATIONS,
  AGENT_API_OPERATIONS,
  WRITE_OPERATION_NAMES,
} from "./agent-op-registry.js";

export type CreatedResource = {
  /**
   * The permalink registry's resource type.
   *
   * Widened from the literal `"eval_suite"` when created resources started
   * coming from the shared permalink policies: a launch produces an
   * `eval_run`, an install a `project_server`, and a host that only knew one
   * type would have dropped them. `PlatformResourceType` rather than `string`
   * so the value is still one the app can route — hosts render an unknown
   * type through their generic link block, which is the point of carrying the
   * type at all.
   */
  type: PlatformResourceType;
  id: string;
  name?: string;
  url: string;
};

/** Discord component custom_id has a 100-character ceiling. Keep this a
 * server contract even while Slack remains the first caller. */
export const MAX_AGENT_ACTION_ID_LENGTH = 100;

export function isValidAgentActionId(actionId: string): boolean {
  return typeof actionId === "string" && actionId.length > 0 && actionId.length <= MAX_AGENT_ACTION_ID_LENGTH;
}

/**
 * How many linkable resources ONE tool call may contribute to the turn's
 * `createdResources`.
 *
 * A batch create (`create_eval_cases` accepts many at once) would otherwise
 * put dozens of link blocks in a Slack reply. Ten is the same ceiling the
 * MCP worker's text fallback uses, so the two surfaces truncate alike.
 */
const MAX_CREATED_RESOURCES_PER_CALL = 10;

/**
 * How many permalinks may ride alongside ONE tool result to the model.
 *
 * The links sit OUTSIDE `capForModel`'s budget (see the call site), so they
 * need a bound of their own or a listing at its page limit would spend
 * kilobytes on URLs the model will not use. Generous next to
 * `MAX_CREATED_RESOURCES_PER_CALL` because these are read results, where
 * "which of these rows do I open" is the actual question, and ~25 links is a
 * small fraction of the 24k payload cap they sit beside.
 */
const MAX_MODEL_PERMALINKS = 25;

/**
 * Operation-name prefixes that BRING SOMETHING INTO EXISTENCE.
 *
 * A prefix list rather than an explicit set: the catalog gains operations
 * regularly, and a set would silently stop reporting each new create until
 * someone remembered this file. The naming convention is already load-bearing
 * across the catalog (`create_*`, `run_*`, `launch_*`, `start_*`,
 * `generate_*`, `install_*`), so keying on it is reading a rule the catalog
 * already follows rather than inventing a second one.
 */
const CREATE_OPERATION_PREFIXES = [
  "create_",
  "run_",
  "launch_",
  "start_",
  "generate_",
  "install_",
  "publish_",
] as const;

/**
 * Where one operation's result can be opened, for EVERY operation.
 *
 * Read off the operation's own permalink policy rather than a name check and a
 * hand-built URL. Two things follow: an operation added later contributes its
 * links without touching this file, and the URL agrees with the one the MCP
 * worker, the CLI and the approval path hand out, because all four ask the
 * same builder.
 */
function permalinksFor(
  operation: AnyPlatformOperation,
  result: unknown,
  input: unknown,
  projectId: string
): PlatformPermalink[] {
  return derivePermalinksFor(
    operation,
    result,
    input,
    {
      appOrigin: MCPJAM_HOSTED_ORIGIN,
      resolvedScope: { projectId },
    },
    (error, operationName) => {
      logger.warn("[v1/agent] could not build a permalink", {
        operation: operationName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
}

/**
 * The subset of those links that names a resource the turn BROUGHT INTO EXISTENCE.
 *
 * CREATES only, not every write. A read's rows are not "created" — a
 * `list_project_servers` turn reporting twenty created resources would be
 * describing the project rather than what it did — and neither is an EDIT:
 * `update_eval_suite` and `name_environment` change a row that already
 * existed, and the public contract (`AgentTurnResponse.createdResources`) and
 * the Slack renderer both say "created". Saying it of an edit is a lie the
 * host then renders as one.
 *
 * The MODEL still sees every permalink through the tool-result envelope; this
 * narrower list is what the HOST renders as created-resource blocks.
 */
function createdResourcesFrom(
  operation: AnyPlatformOperation,
  permalinks: readonly PlatformPermalink[],
  result: unknown
): CreatedResource[] {
  if (
    operation.readOnly ||
    !CREATE_OPERATION_PREFIXES.some((prefix) =>
      operation.name.startsWith(prefix)
    )
  ) {
    return [];
  }
  // The NAME matters beyond display: `offerRunsForCreatedSuites` matches a
  // model-authored `suite` argument against it, and a model names a suite it
  // just created by name as often as by id.
  const suiteName = (result as { suite?: { name?: string } })?.suite?.name;
  return permalinks
    .slice(0, MAX_CREATED_RESOURCES_PER_CALL)
    .map((permalink) => ({
      type: permalink.resource.type,
      id: permalink.resource.id,
      ...(permalink.resource.type === "eval_suite" && suiteName
        ? { name: suiteName }
        : {}),
      url: permalink.url,
    }));
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
  // Zod 4 keeps `superRefine` checks on the ZodObject itself. Calling
  // `.extend()` on such an object throws because it could invalidate those
  // checks; use `.safeExtend()` when available so the gated tool surface can
  // advertise the same schema without turning the whole agent request into a
  // 500. The operation's original schema is still used for execution-time
  // validation, so its cross-field checks remain intact.
  const extend =
    typeof (
      asObject as z.ZodObject<z.ZodRawShape> & {
        safeExtend?: typeof asObject.extend;
      }
    ).safeExtend === "function"
      ? (
          asObject as z.ZodObject<z.ZodRawShape> & {
            safeExtend: typeof asObject.extend;
          }
        ).safeExtend
      : asObject.extend;
  return extend.call(asObject, {
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

/**
 * A proposal as this route tracks it.
 *
 * `input` is INTERNAL: it is what got persisted, kept here so a failed turn's
 * error details can still describe what was offered. Everything else matches
 * the public `ProposedAction` wire type, and only those fields are serialized —
 * the input never leaves the server, because a host that received it might be
 * tempted to send it back, and then the click would be saying what it does.
 */
export type ProposedAction = PublicProposedAction & {
  /** The validated, project-clamped input the click will execute. */
  input: Record<string, unknown>;
};

/** The envelope projection: the public fields, and only those. */
function toWireProposal(proposal: ProposedAction): PublicProposedAction {
  return {
    actionId: proposal.actionId,
    operation: proposal.operation,
    description: proposal.description,
    buttonLabel: proposal.buttonLabel,
    kind: proposal.kind,
    ...(proposal.confirmSeverity
      ? { confirmSeverity: proposal.confirmSeverity }
      : {}),
    ...(proposal.target ? { target: proposal.target } : {}),
  };
}

/**
 * Persist a proposal and record it for the envelope.
 *
 * Shared by the gated tools (the model asked) and the created-suite offer (we
 * offered), so both go through the SAME machinery: same derived action id, same
 * response-level dedupe, same registry-supplied copy. A second path that minted
 * proposals its own way would be a second set of rules for what a click can do.
 *
 * @returns the minted action id (with the human-readable description), or a
 * model-facing `error` when nothing was persisted — either a retryable
 * persistence failure or a fail-closed freeze refusal
 */
async function persistProposal(opts: {
  operation: AnyPlatformOperation;
  input: Record<string, unknown>;
  projectId: string;
  proposed: ProposedAction[];
  surface: ProposalSurface;
  turnIdempotencyKey?: string;
  /** Used to FREEZE argument meanings at mint time. See `normalizeArgs`. */
  client?: PlatformApiClient;
}): Promise<{ actionId: string; description: string } | { error: string }> {
  const { operation, projectId, proposed, surface } = opts;
  const meta = proposalMetaFor(operation.name);
  const retryableError = {
    error: `Could not propose ${operation.title} right now. Try again in a moment.`,
  };
  const unpinnableError = {
    error:
      `Could not pin ${operation.title} to the current registry entry, so ` +
      "nothing was proposed. Re-read the entry and try again.",
  };
  // FROZEN BEFORE ANYTHING ELSE, because everything downstream — the derived
  // action id, the stored row, the description a human reads, the arguments
  // approval executes — has to describe the same set. `allAttached: true`
  // would otherwise be re-expanded at click time against whatever is attached
  // THEN, silently widening an approved spend.
  //
  // FAIL-CLOSED for entries that declare `requiredFrozenKeys` (the installs):
  // there the mint-time pin IS what the human approves, so a freeze that
  // failed — or a caller with no client to freeze with — REFUSES the mint
  // rather than persisting a proposal whose click would install whatever the
  // registry row resolves to an hour later.
  if (meta.requiredFrozenKeys.length > 0 && !opts.client) {
    logger.warn("[v1/agent] no client to freeze a pin-required proposal", {
      operation: operation.name,
    });
    return unpinnableError;
  }
  let input: Record<string, unknown>;
  try {
    input = opts.client
      ? await meta.normalizeArgs(opts.input, {
          projectId,
          client: opts.client,
        })
      : opts.input;
  } catch (error) {
    // Only a `requiredFrozenKeys` entry lets a normalizer throw reach here;
    // the generic tier degrades inside `normalizeArgs` instead.
    logger.warn("[v1/agent] refusing to mint an unpinned proposal", {
      operation: operation.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return unpinnableError;
  }
  const missingPins = meta.requiredFrozenKeys.filter(
    (key) => input[key] === undefined
  );
  if (missingPins.length > 0) {
    // Belt to the throw's braces: a normalizer that RETURNED without its pins
    // is the same unpinned proposal as one that threw.
    logger.warn("[v1/agent] frozen proposal input is missing required pins", {
      operation: operation.name,
      missing: missingPins,
    });
    return unpinnableError;
  }
  // Derived where possible: same turn + same operation + same arguments must
  // yield the SAME proposal, so a redelivery re-offers the existing control
  // rather than minting a second one. `randomUUID` only for callers with no
  // stable turn identity, where a duplicate proposal is the lesser risk than
  // none at all.
  const actionId = opts.turnIdempotencyKey
    ? deriveOperationIdempotencyKey(
        opts.turnIdempotencyKey,
        `proposal:${operation.name}`,
        meta.hashInput(input)
      )
    : randomUUID();
  if (!isValidAgentActionId(actionId)) {
    logger.error("[v1/agent] generated action id exceeded surface limit", {
      operation: operation.name,
      length: actionId.length,
    });
    return retryableError;
  }
  try {
    await createProposedAction({
      actionId,
      surface: surface.surfaceKind,
      surfaceTenantId: surface.tenantId,
      surfaceActorId: surface.actorId,
      surfaceConversationId: surface.conversationId,
      operation: operation.name,
      input,
      organizationId: surface.organizationId,
      projectId,
    });
  } catch (error) {
    logger.warn("[v1/agent] could not persist a proposed action", {
      operation: operation.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return retryableError;
  }

  // The derived id already collapses repeats in the BACKEND row; this collapses
  // them in the RESPONSE. A model that invokes the same gated tool twice with
  // the same arguments has proposed one action, and a caller rendering one
  // control per entry would otherwise show two for a single spend — the exact
  // duplicate the derived id exists to prevent.
  if (!proposed.some((existing) => existing.actionId === actionId)) {
    proposed.push({
      actionId,
      operation: operation.name,
      input,
      description: meta.description(input),
      // Rendering metadata travels WITH the proposal. A host that had to map
      // operation names to labels itself would show "Approve" for every op it
      // shipped before — which is how a new gated action reaches users looking
      // exactly like a generic one.
      buttonLabel: meta.buttonLabel,
      kind: meta.kind,
      // Resolved per proposal: the hazard can depend on the arguments (enabling
      // a schedule commits to recurring spend; disabling one stops it).
      ...(meta.severityFor(input)
        ? { confirmSeverity: meta.severityFor(input) }
        : {}),
      // What the proposal is about, so a host can correlate it with the turn's
      // created resources instead of guessing from the operation name.
      ...(meta.targetFor(input) ? { target: meta.targetFor(input) } : {}),
    });
  }
  return { actionId, description: meta.description(input) };
}

/**
 * Offer to RUN each suite the turn just created.
 *
 * The suite link used to carry its own "Run it" button, wired straight to
 * `POST /eval-runs` — a second, parallel way to spend that shared none of the
 * proposal path's properties (no persisted contract, no durable claim, no
 * clicker re-authorization at the same seam). This retires it: the offer is now
 * an ordinary proposal, and the button a host renders for it is the same button
 * it renders for every other approval.
 *
 * ENTIRELY BEST-EFFORT. The suite exists and its link is already in the
 * envelope; a proposal that cannot be persisted costs the user one click of
 * convenience, and failing the turn over it would cost them the answer.
 */
async function offerRunsForCreatedSuites(opts: {
  created: CreatedResource[];
  proposed: ProposedAction[];
  projectId: string;
  surface: ProposalSurface;
  /** See `buildGatedProposalTools`. */
  client?: PlatformApiClient;
  turnIdempotencyKey?: string;
  /** The org's disabled operations. See `buildGatedProposalTools`. */
  disabledOperations?: ReadonlySet<string>;
}): Promise<void> {
  // This path MINTS A PROPOSAL WITHOUT GOING THROUGH THE TOOL ARRAY, so
  // filtering the tools is not enough: an org that switched `run_eval_suite`
  // off would still be handed a Run-it button for every suite the turn
  // created. Checked once, outside the loop — the answer cannot change
  // mid-turn.
  if (opts.disabledOperations?.has(runEvalSuiteOperation.name)) return;

  for (const resource of opts.created) {
    if (resource.type !== "eval_suite") continue;
    // Skip when the model ALREADY proposed running this suite in this turn.
    // The derived action id collapses byte-identical inputs, but the model
    // proposes by whatever selector it used (a name) while this offers by id,
    // so the ids would differ and the user would be shown two buttons for one
    // run. Compare the TARGET instead.
    const alreadyOffered = opts.proposed.some(
      (existing) =>
        existing.operation === runEvalSuiteOperation.name &&
        (existing.input.suite === resource.id ||
          (resource.name !== undefined && existing.input.suite === resource.name))
    );
    if (alreadyOffered) continue;

    const input = { project: opts.projectId, suite: resource.id };
    const parsed = (
      runEvalSuiteOperation.inputSchema as z.ZodType<Record<string, unknown>>
    ).safeParse(input);
    if (!parsed.success) continue;
    await persistProposal({
      operation: runEvalSuiteOperation,
      input: parsed.data,
      projectId: opts.projectId,
      proposed: opts.proposed,
      surface: opts.surface,
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.turnIdempotencyKey
        ? { turnIdempotencyKey: opts.turnIdempotencyKey }
        : {}),
    });
  }
}

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
  /**
   * The platform client a proposal normalizer uses to resolve selectors at
   * mint time. Optional so a caller that cannot supply one still gets
   * proposals — with the arguments unfrozen, which is the pre-existing
   * behaviour and never worse than no proposal at all. The exception is an
   * operation whose entry declares `requiredFrozenKeys` (the registry
   * installs): those cannot mint unpinned, so without a client
   * `persistProposal` refuses them instead.
   */
  client?: PlatformApiClient;
  /**
   * The turn's stable identity. When present, the action id is DERIVED from it
   * rather than random, so a redelivered Slack event that re-proposes the same
   * action lands on the same proposal row instead of offering the user a second
   * button for the same spend. Two identical buttons in a thread are two clicks
   * away from being billed twice.
   */
  turnIdempotencyKey?: string;
  /**
   * Where the approval control will be rendered, and who it will be attributed
   * to. Absent means this caller has no surface — see the refusal below.
   */
  surface?: ProposalSurface;
  /**
   * Operations the org has switched off. OMITTED ENTIRELY rather than offered
   * and then refused: a tool the model can see is a tool it plans around, and
   * an agent that announces an action and then reports it was blocked is worse
   * than one that never offered it. The execute route rejects them too — this
   * is the seam that stops them being proposed in the first place.
   *
   * TIGHTEN-ONLY: this set can only remove operations the registry already
   * offers, so a name nobody recognises filters nothing.
   */
  disabledOperations?: ReadonlySet<string>;
}): ToolSet {
  const tools: ToolSet = {};
  for (const operation of AGENT_API_GATED_OPERATIONS) {
    if (opts.disabledOperations?.has(operation.name)) continue;
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
      execute: async (input: Record<string, unknown>, { abortSignal }) => {
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }
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
            .map(
              (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
            )
            .join("; ");
          return {
            error: `Invalid input for ${operation.name} — fix these fields and retry: ${issues}`,
          };
        }

        if (!opts.surface) {
          // No surface to render a control on. Refusing is the honest answer:
          // silently proposing into the void would let the model report an
          // action as pending that nobody can ever approve.
          return {
            error: `${operation.title} needs human approval, which this caller cannot collect. Ask the user to run it from the MCPJam app.`,
          };
        }

        // Re-check: validation above can yield, and the turn's wall clock may
        // have fired meanwhile. Persisting after an abort would leave a
        // proposal behind for a turn that answered with a timeout.
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }

        const minted = await persistProposal({
          operation,
          input: parsed.data,
          projectId: opts.projectId,
          proposed: opts.proposed,
          surface: opts.surface,
          ...(opts.client ? { client: opts.client } : {}),
          ...(opts.turnIdempotencyKey
            ? { turnIdempotencyKey: opts.turnIdempotencyKey }
            : {}),
        });
        if ("error" in minted) {
          // Not "proposed": the model must not tell the user a button exists,
          // whether persistence failed or the freeze refused the mint.
          return { error: minted.error };
        }
        return {
          proposed: true,
          actionId: minted.actionId,
          // The FROZEN description — the same text the approval control shows,
          // which for an install includes the resolved endpoint host.
          description: minted.description,
          note: "Awaiting human approval. Do not claim this has started.",
        };
      },
    });
  }
  return tools;
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
  clientWithHeaders?: (
    extraHeaders: Record<string, string>
  ) => PlatformApiClient;
  /**
   * Operations the org has switched off. Same rule as the gated tier: omitted,
   * not refused. Applies to reads as well as writes — an org that does not
   * want the agent reading its server catalog is expressing a real preference,
   * and there is nothing about a read that makes it exempt.
   */
  disabledOperations?: ReadonlySet<string>;
}): ToolSet {
  const tools: ToolSet = {};
  for (const operation of AGENT_API_OPERATIONS) {
    if (opts.disabledOperations?.has(operation.name)) continue;
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
            .map(
              (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
            )
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
          // Derived from the RAW result, before either transform below
          // reshapes it.
          const permalinks = permalinksFor(
            operation,
            result,
            parsed.data,
            opts.projectId
          );
          opts.created.push(
            ...createdResourcesFrom(operation, permalinks, result)
          );
          // The MODEL sees them too, which is what the system prompt's
          // "hand the user that url" rule refers to. Without this the rule
          // named a field this surface never emitted, and a read like
          // `list_project_servers` gave the model nothing but ids — the exact
          // situation that had it inventing app URLs.
          // Cap the PAYLOAD, then attach the links OUTSIDE the cap.
          //
          // `capForModel` replaces an over-cap value wholesale with
          // `{truncated, preview}`, so enveloping first and capping after
          // discarded the permalinks on exactly the results that need them
          // most: a long listing, where the model is handed a truncated blob
          // and the link is the only thing it can still act on.
          const capped = capForModel(stripProjectSwitchingMetadata(result));
          if (permalinks.length === 0) return capped;
          return withPermalinkEnvelope(
            capped,
            permalinks.slice(0, MAX_MODEL_PERMALINKS)
          );
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
 * The rules that hold for every operation on this surface.
 *
 * The ground-rules section is LAST on purpose: per-operation guidance from the
 * registry is appended straight onto its end, so a new tool's note lands as one
 * more bullet in the same list rather than needing a home carved out for it.
 */
const AGENT_API_BASE_PROMPT_LINES: readonly string[] = [
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
  "- When a tool result carries a `permalinks` array, hand the user that `url` EXACTLY as written. NEVER invent, shorten, or rewrite an MCPJam app URL, and never build one from an id: a hand-made link opens whichever project the reader last selected, which is usually not the one you are talking about. If a result has no permalink, give the id and say where to find it.",
  "- Tool input schemas are AUTHORITATIVE. Never consult docs to learn a tool's argument shape — the schema you were given is the truth. If a tool returns a validation error naming fields, correct exactly those fields and retry the same call.",
  "- Consult the MCPJam docs tools (when available) for product questions instead of answering from memory.",
  "- Keep replies concise and concrete. If the request is ambiguous, ask instead of inventing.",
];

/**
 * Assembled ONCE at module load: base rules + the registry's per-operation
 * notes, in registry order.
 *
 * Assembly, not interpolation. Nothing volatile goes in (no projectId, no
 * timestamp), so the value is constant per build and the cacheable prompt
 * prefix survives across a conversation's requests — the property that makes
 * every turn after the first cheap. The project boundary is enforced by the
 * tool adapter, not the prompt, so the prompt only needs to SAY it, not carry
 * the id.
 */
export const AGENT_API_SYSTEM_PROMPT = [
  ...AGENT_API_BASE_PROMPT_LINES,
  ...AGENT_OP_PROMPT_NOTES,
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
          (total, message) =>
            total + Buffer.byteLength(message.content, "utf8"),
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
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    // Printable ASCII only. The key becomes a HEADER value on every write the
    // turn issues, and `Headers.set` throws on a control character — so a key
    // containing CR, LF, or NUL would let every read succeed and every write
    // fail, leaving a half-finished turn. Rejecting it at the boundary makes
    // that a 400 the caller can read instead.
    .regex(/^[\x20-\x7E]+$/, "idempotencyKey must be printable ASCII")
    .optional(),
  /**
   * Where a proposal's approval control will be rendered — a channel, a
   * thread, a DM, whatever the caller's surface calls it. Required for the
   * GATED tools to be usable at all: without somewhere to collect the click,
   * proposing is refused rather than silently queued somewhere nobody can
   * approve it.
   */
  conversationId: z.string().min(1).max(256).optional(),
  /**
   * The Slack-named spelling of `conversationId`.
   *
   * Kept indefinitely, not deprecated-with-a-date: the bot is a separately
   * deployed service, so at any moment one version of it is sending this and
   * another is sending `conversationId`. `conversationId` wins when both
   * arrive.
   */
  slackChannelId: z.string().min(1).max(256).optional(),
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

/**
 * GET /api/v1/agent-ops — the agent's operation registry, as data.
 *
 * Exists so the org-settings Capabilities page CANNOT DRIFT from the registry.
 * The alternative — a hand-maintained op list in the client bundle — drifts
 * silently in both directions: a tool added here has no toggle until someone
 * remembers the client, and a tool removed here leaves a toggle that disables
 * nothing while claiming to.
 *
 * Static build metadata: no project, no org, no user data, and identical for
 * every caller. It still sits behind the v1 bearer gate (and off the guest
 * allowlist) because the only consumer is an org admin's settings page, and
 * default-deny is the cheaper mistake.
 */
// This route never calls Convex, so nothing downstream re-checks the bearer —
// see middleware/require-verified-auth.ts. Mounted as `.use` rather than as an
// inline handler argument so Hono keeps inferring the route's path params.
agent.use("/agent-ops", requireVerifiedAuth());

agent.get("/agent-ops", async (c) => {
  return v1Resource(c, { operations: listAgentOpCatalog() });
});

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
    // NOTE: self-dispatched requests re-enter bearer auth carrying the
    // delegated JWT, not the original `sk_` key, so the middleware labels them
    // a passthrough JWT with no `mcpjamOrganizationId` — every gateway-level
    // org clamp (`getDelegatedOrganizationId`) is a no-op on this path. That
    // is contained, not open: the JWT's own org claim is enforced inside
    // Convex membership resolution (`delegatedScopeAllowsOrganization`), which
    // is the canonical barrier. But gateway-only niceties (the `POST
    // /projects` org fill-in, the membership-enumeration clamps) do not apply
    // to ops invoked through this client.
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
    // Proposals need a surface to render the control on AND an org to
    // attribute the spend to. Both come from the auth context, resolved by a
    // single helper so no route re-implements "which chat product is this".
    // Callers with neither get the read/write tiers only — the gated tools are
    // omitted entirely rather than offered and then refused, so the model
    // never plans around an action it cannot take.
    const proposalSurface = resolveProposalSurface(c, body);

    // The org's capability policy, keyed off the AUTH CONTEXT's organization
    // — not the proposal surface, which is undefined for `sk_`/JWT callers who
    // have no chat surface but do have an org whose policy still applies.
    // Fails open (see `org-agent-policy.ts`): a Convex blip must not strip
    // every tool from every turn.
    const disabledOperations = await getOrgAgentPolicyCached(
      c.get("mcpjamOrganizationId")
    );

    const builtInTools = {
      ...buildAgentApiToolSet({
        client,
        projectId,
        created,
        ...(body.idempotencyKey
          ? { turnIdempotencyKey: body.idempotencyKey }
          : {}),
        clientWithHeaders: makeClient,
        disabledOperations,
      }),
      ...(proposalSurface
        ? buildGatedProposalTools({
            projectId,
            proposed,
            client,
            ...(body.idempotencyKey
              ? { turnIdempotencyKey: body.idempotencyKey }
              : {}),
            surface: proposalSurface,
            disabledOperations,
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

    // Offer to run whatever the turn created. Done AFTER the turn rather than
    // inside the create tool so the model cannot talk itself out of it, and so
    // it applies to a failed turn too — a suite that got created before the
    // engine died is still a suite the user is about to be shown, and it should
    // arrive with the same way to run it as a successful turn's would.
    //
    // Skipped on ABORT, matching the gated tools: persisting a proposal for a
    // turn that answered with a timeout leaves a control behind for an
    // exchange the user never saw finish.
    if (proposalSurface && !abortController.signal.aborted) {
      await offerRunsForCreatedSuites({
        created,
        proposed,
        projectId,
        surface: proposalSurface,
        client,
        ...(body.idempotencyKey
          ? { turnIdempotencyKey: body.idempotencyKey }
          : {}),
        disabledOperations,
      });
    }

    // A failed/timed-out turn may still have PERSISTED suites (the create
    // op completed before the failure). Surface them in the error details
    // so a retrying caller doesn't double-create.
    const errorDetails = () => {
      const details: Record<string, unknown> = {};
      if (created.length > 0) details.createdResources = created;
      // A failed turn may still have PROPOSED actions. Surfacing them lets a
      // caller render the buttons anyway rather than stranding approvals the
      // user was about to be offered. Same public projection as the success
      // envelope — the persisted input stays server-side either way.
      if (proposed.length > 0) {
        details.proposedActions = proposed.map(toWireProposal);
      }
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
    //
    // Also check lastEngineError even when turnTrace IS present: a
    // spend-precheck denial (issue #3708) returns 200 OK with a JSON body,
    // so the engine's error path fires onEngineError but runSucceeded still
    // flips to true (the per-step error exits the loop, the safety epilogue
    // runs, and onConversationComplete sets capturedTurnTrace). Without this
    // second check the agent route would return a silent empty-reply 200.
    const rateLimitCodes = new Set(["user_rate_limit", "org_rate_limit"]);
    if (!result.turnTrace || lastEngineError) {
      const message =
        lastEngineError?.message ??
        "Agent turn failed: the engine returned no turn trace.";
      const rateLimited =
        lastEngineError?.httpStatus === 429 ||
        (lastEngineError?.code !== undefined &&
          rateLimitCodes.has(lastEngineError.code)) ||
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
      // holds what it does. `buttonLabel`/`kind`/`confirmSeverity` ride along
      // so the host words the button and the announcement from what the SERVER
      // decided, rather than from an operation-name table it has to keep in
      // step with this build.
      proposedActions: proposed.map(toWireProposal),
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
