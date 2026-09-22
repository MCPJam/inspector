/**
 * Execute an action a human approved.
 *
 * The agent turn cannot spend. When the model wants to run a suite, run a case,
 * generate cases, or cancel a run, its tool call PROPOSES the operation (see
 * the gated tier in `agent-op-registry.ts`) and a person is shown a control.
 * This route is what that control hits.
 *
 * THREE PROPERTIES MAKE THE CLICK SAFE, and all three live here:
 *
 *   1. THE PROPOSAL IS THE CONTRACT. `beginProposedAction` returns the
 *      PERSISTED operation and input, and those are what execute. Nothing from
 *      the request body decides what runs — an approval control's payload can
 *      be minted by anyone able to post in the workspace, so a click may only
 *      ever say WHICH proposal to run.
 *   2. THE CLICKER IS THE AUTHORIZER. This route runs under a SURFACE auth
 *      method, so the delegated JWT is minted for the person who CLICKED, and
 *      the mint re-verifies their org membership. The proposer's identity
 *      executes nothing: someone who has been removed from the org cannot spend
 *      through a control they left behind, and someone who never had access to
 *      the project cannot gain it by clicking.
 *   3. THE CLAIM IS DURABLE. `proposed → executing` is a transactional
 *      transition in the backend; a double-click races there and exactly one
 *      caller wins. The loser is told, not billed.
 *
 * The tenant check below is not redundant with the claim: the claim guarantees
 * ONE execution, not a LEGITIMATE one. Without the surface/tenant/project
 * comparison, a workspace that learned another workspace's action id could
 * spend the other org's quota — the claim would happily hand it the operation
 * to run.
 *
 * NOTHING HERE IS SLACK-SPECIFIC any more. The route reads the canonical
 * surface trio off the auth context, so a second wrapper needs a new auth
 * branch and an entry in `SURFACE_AUTH_METHODS`, and not one line of this file.
 */
import { Hono } from "hono";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import type {
  ExecutedActionResource,
  ExecuteProposedActionResponse,
} from "@mcpjam/sdk/public-api";
import {
  AGENT_API_GATED_OPERATIONS,
  executedActionResource,
  gatedEntryFor,
} from "./agent-op-registry.js";
import { resolveSurfaceActor } from "./approval-surface.js";
import {
  beginProposedAction,
  completeProposedAction,
  getProposedAction,
  releaseProposedAction,
  SlackBackendUnavailable,
} from "../../services/slack-backend.js";
import { getOrgAgentPolicyStrict } from "../../utils/org-agent-policy.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { getConvexBearerForApprovedAction } from "../../utils/v1-convex-token.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../utils/idempotency.js";
import { logger } from "../../utils/logger.js";
import { v1Error, v1Resource } from "./envelope.js";

const proposedActions = new Hono();

/** Wall clock for one approved execution. Generous: a suite run is not fast. */
const EXECUTION_TIMEOUT_MS = 120_000;

const GATED_BY_NAME = new Map(
  AGENT_API_GATED_OPERATIONS.map((operation) => [operation.name, operation])
);

proposedActions.post(
  "/projects/:projectId/proposed-actions/:actionId/execute",
  async (c) => {
    const projectId = c.req.param("projectId");
    const actionId = c.req.param("actionId");
    if (actionId.length > 100) {
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }

    // Proposals exist only for a CHAT SURFACE, because that is the only place a
    // control can be rendered and a clicker identified. An `sk_` or JWT caller
    // reaching here would have no clicker to attribute the spend to.
    const actor = resolveSurfaceActor(c);
    if (!actor) {
      return v1Error(
        c,
        "UNAUTHORIZED",
        "Approved actions can only be executed from the surface that collected the approval."
      );
    }

    let record;
    try {
      record = await getProposedAction(actionId);
    } catch (error) {
      // 503, never 404: "could not ask" is not "does not exist". A clicker told
      // their approval had vanished would go looking for a proposal that is
      // sitting there intact.
      logger.error("[v1/proposed-actions] could not read the proposal", {
        error: error instanceof Error ? error.message : String(error),
        is_backend_unavailable: error instanceof SlackBackendUnavailable,
      });
      return v1Error(
        c,
        "SERVER_UNREACHABLE",
        "Could not reach MCPJam to check that approval. Try again in a moment."
      );
    }

    // A missing proposal and one belonging to another workspace get the SAME
    // answer. Distinguishing them would turn this route into an oracle for
    // whether a given action id exists in some other org.
    //
    // `teamId` is the fallback, not the check: a row written before the
    // surface columns existed carries its tenant only there. Comparing the
    // SURFACE too is what stops one product's tenant id from ever matching
    // another's by coincidence.
    const recordTenantId = record?.surfaceTenantId ?? record?.teamId ?? null;
    if (
      !record ||
      (record.surface ?? "slack") !== actor.surfaceKind ||
      recordTenantId !== actor.tenantId
    ) {
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }
    // ORG CHECK BEFORE THE CLAIM. One Slack workspace can host people from
    // several MCPJam orgs. Letting an outsider reach `beginProposedAction`
    // would let them CLAIM the proposal and then fail authorization — burning
    // it, so the colleague who could legitimately approve it never gets to.
    // Same non-disclosing answer, so this is not an oracle either.
    if (record.organizationId !== actor.organizationId) {
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }
    // Same answer AGAIN for a project mismatch, and only after org membership
    // is proven: a distinct "different project" message — or answering before
    // the org check — would confirm to an outsider that the id exists in this
    // workspace and let them narrow down which project it lives in.
    if (record.projectId !== projectId) {
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }

    const operation = GATED_BY_NAME.get(record.operation);
    if (!operation) {
      // The proposal names an operation this build does not gate — a rollback,
      // or a tampered row. Refuse rather than reaching for some other operation
      // by the same name: a proposal is only as safe as the exact thing it says.
      logger.warn("[v1/proposed-actions] proposal names an unknown operation", {
        operation: record.operation.slice(0, 100).replace(/[\r\n]/g, ""),
      });
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "That approval is for an action this server no longer offers."
      );
    }

    // ORG CAPABILITY POLICY, AFTER THE ALLOWLIST AND BEFORE THE CLAIM.
    //
    // Position is the whole point. After the allowlist, because an operation
    // this build does not gate is a different (louder) failure. Before the
    // claim, because a post-claim denial BURNS the proposal — the row goes to
    // `executing` and nobody can approve it afterwards, so an org that
    // disabled an op mid-flight would also destroy every pending button for it
    // rather than simply refusing the click (see the comment above the org
    // check for the same reasoning applied to outsiders).
    //
    // Disabling does NOT proactively expire pending proposals; this rejection
    // is what catches the clicks, and the 1-hour TTL retires the buttons.
    //
    // FAIL CLOSED. Unlike tool assembly, the alternative here is spending
    // under a policy we could not read. No disclosure concern: org membership
    // was proven above, so this caller is entitled to know their org's own
    // configuration.
    let disabledOperations: ReadonlySet<string>;
    try {
      disabledOperations = await getOrgAgentPolicyStrict(actor.organizationId);
    } catch (error) {
      logger.error("[v1/proposed-actions] could not read the org policy", {
        error: error instanceof Error ? error.message : String(error),
      });
      return v1Error(
        c,
        "SERVER_UNREACHABLE",
        "Could not check your organization's settings right now. Try again in a moment."
      );
    }
    if (disabledOperations.has(record.operation)) {
      return v1Error(
        c,
        "FORBIDDEN",
        "This action has been disabled by your organization's administrators."
      );
    }

    let claim;
    try {
      claim = await beginProposedAction({
        actionId,
        // The CLICKER, in the surface's own id space. Never the proposer:
        // their identity executes nothing.
        executorId: actor.actorId,
      });
    } catch (error) {
      // Fail closed. An unreachable backend must never be read as permission
      // to spend — that is the whole reason the claim exists.
      logger.error("[v1/proposed-actions] could not claim the proposal", {
        error: error instanceof Error ? error.message : String(error),
      });
      return v1Error(
        c,
        "SERVER_UNREACHABLE",
        "Could not start that action right now. Try again in a moment."
      );
    }

    if (!claim.ok) {
      if (claim.reason === "expired") {
        return v1Error(
          c,
          "VALIDATION_ERROR",
          "That approval expired. Ask again and I'll propose it fresh."
        );
      }
      if (claim.reason === "already_claimed") {
        return v1Error(
          c,
          "CONFLICT",
          claim.status === "executing"
            ? "That action is already running."
            : "That action has already been handled."
        );
      }
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }

    // THE CLAIM IS THE CONTRACT — enforced, not assumed. `operation` was
    // resolved from the PRE-claim read; if the row changed identity between
    // that read and the claim, executing would run something nobody was
    // shown. Nothing writes those columns today, so this should be
    // unreachable — which is exactly why it must refuse loudly if it is ever
    // reached. Deliberately NOT released: a proposal whose identity moved is
    // not one any click should spend, so it is left to age out of its lease.
    if (
      claim.operation !== record.operation ||
      claim.projectId !== record.projectId
    ) {
      logger.error(
        "[v1/proposed-actions] claim diverged from the pre-claim read",
        { actionId }
      );
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }

    // DEFENSE IN DEPTH for the mint-time freeze. An entry that declares
    // `requiredFrozenKeys` (the registry installs) can only be minted with
    // its pins present, so a stored input missing one is a row minted before
    // that contract — or a tampered one — and executing it would install
    // whatever the registry resolves to NOW, not what the approver saw.
    // Completed as FAILED rather than released: the row is permanently
    // invalid, and a release would just hand the same broken button to the
    // next click.
    const requiredPins =
      gatedEntryFor(operation.name)?.proposal.requiredFrozenKeys ?? [];
    const missingPins = requiredPins.filter(
      (key) => claim.input[key] === undefined
    );
    if (missingPins.length > 0) {
      // Declared 400, not a thrown catch-site: `reportRouteFailure` would
      // still page unless we mint a fake 4xx error object. `logger.error`
      // with no Error argument captures `new Error(message)` on every stale
      // click. Same warn as the unknown-operation refusal above.
      logger.warn("[v1/proposed-actions] refused an unpinned proposal", {
        operation: operation.name,
        missing: missingPins,
      });
      await completeProposedAction({
        actionId,
        status: "failed",
        failureReason: `input is missing required pins: ${missingPins.join(
          ", "
        )}`,
      }).catch(() => {});
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "That approval was recorded without the details a click must pin down. Ask again and I'll propose it fresh."
      );
    }

    // From here the claim is HELD. Every exit must either complete it or
    // release it, or the proposal is stranded `executing` and the sweep will
    // deliberately refuse to reap it.
    const selfFetch = getSelfFetch();
    if (!selfFetch) {
      await releaseProposedAction(actionId).catch(() => {});
      return v1Error(
        c,
        "INTERNAL_ERROR",
        "In-process /api/v1 dispatch is not registered."
      );
    }

    let convexJwt: string;
    try {
      // The CLICKER's delegated token. Minting re-verifies their membership of
      // the org, so approval by someone since removed fails right here rather
      // than spending.
      //
      // Minted UNCACHED so it can carry this action's id: every write the
      // operation makes then lands an audit row that names the proposal a
      // human approved, rather than looking like the clicker acting alone.
      convexJwt = await getConvexBearerForApprovedAction(c, actionId);
    } catch (error) {
      await releaseProposedAction(actionId).catch(() => {});
      logger.warn(
        "[v1/proposed-actions] could not mint a token for the clicker",
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return v1Error(
        c,
        "UNAUTHORIZED",
        "Your MCPJam access could not be confirmed for this project."
      );
    }

    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      EXECUTION_TIMEOUT_MS
    );

    try {
      const client = new PlatformApiClient({
        baseUrl: "http://self.mcpjam.internal/api/v1",
        getAuth: () => convexJwt,
        fetch: async (input, init) => {
          // The deadline has to reach the INNER request. Without forwarding the
          // signal, the timeout only stops us waiting — the self-dispatched
          // operation keeps running and can complete long after we told the
          // user it timed out. `init.signal` is respected when the caller set
          // one, so this only fills the gap.
          const request = new Request(input, {
            ...init,
            signal: init?.signal ?? abortController.signal,
          });
          // The action id IS the idempotency key — scoped by the backend to
          // (creator, suite, key), so a redelivered click by the SAME approver
          // lands on the same run rather than billing a second one. That
          // per-creator scope is also why a claim whose process died is CLOSED
          // at lease lapse rather than handed to the next clicker: a different
          // approver's re-drive would miss the dedupe entirely, and
          // call_server_tool has no idempotency to miss.
          request.headers.set(
            IDEMPOTENCY_KEY_HEADER,
            `proposal:${actionId}:${operation.name}`
          );
          return selfFetch(request);
        },
      });

      // The PERSISTED input, re-clamped to the persisted project. Both come
      // from the proposal; the request body is never consulted.
      const input = { ...claim.input, project: claim.projectId };
      const result = await operation.execute(input as never, {
        client,
        signal: abortController.signal,
      });

      // What the caller renders from, and what the org's activity row links
      // to. `kind` comes from the registry; `resource` comes from the
      // OPERATION's own permalink policy. Either way it is derived
      // SERVER-SIDE: a host that synthesised the URL itself would have to
      // know each operation's result shape, and would silently link to
      // nothing the moment one changed.
      //
      // Built HERE, before the completion call, and isolated from the
      // operation's own try/catch on purpose. The work is DONE; a throw in a
      // link builder that reached the catch below would re-record the same
      // action as `failed` and answer 500, telling the user their approved
      // action did not happen and leaving the lifecycle row contradicting
      // itself — over a formatting helper. A failure to build a link may only
      // ever cost the link.
      const meta = gatedEntryFor(operation.name)?.proposal;
      let resource: ExecutedActionResource | undefined;
      try {
        resource = executedActionResource(operation, result, input, {
          projectId: claim.projectId,
        });
      } catch (error) {
        logger.warn("[v1/proposed-actions] could not build the result link", {
          operation: operation.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await completeProposedAction({
        actionId,
        status: "succeeded",
        ...(resource?.id ? { resourceId: resource.id } : {}),
        ...(resource?.url ? { resourceUrl: resource.url } : {}),
      }).catch((error) => {
        // The work is DONE. A failed bookkeeping write only costs a stale
        // row; failing the response would tell the user their approved
        // action did not happen, which is false.
        logger.warn(
          "[v1/proposed-actions] action succeeded but recording it failed",
          { error: error instanceof Error ? error.message : String(error) }
        );
      });

      const response: ExecuteProposedActionResponse = {
        actionId,
        operation: operation.name,
        status: "succeeded",
        kind: meta?.kind ?? "start",
        ...(resource ? { resource } : {}),
        result,
      };
      return v1Resource(c, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // FAILED, not released. We cannot prove the operation did not start —
      // a timeout in particular means the run may well be going — and an
      // "unsure" release is how an approved action gets billed twice.
      await completeProposedAction({
        actionId,
        status: "failed",
        failureReason: message,
      }).catch(() => {});
      logger.error("[v1/proposed-actions] approved action failed", {
        operation: operation.name,
        error: message,
      });
      if (abortController.signal.aborted) {
        return v1Error(
          c,
          "TIMEOUT",
          `${operation.title} took too long. Check the MCPJam app — it may still be running.`
        );
      }
      return v1Error(c, "INTERNAL_ERROR", `${operation.title} failed.`);
    } finally {
      clearTimeout(timer);
    }
  }
);

export default proposedActions;
