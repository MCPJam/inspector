/**
 * Execute an action a human approved.
 *
 * The agent turn cannot spend. When the model wants to run a suite, run a case,
 * generate cases, or cancel a run, its tool call PROPOSES the operation (see
 * `AGENT_API_GATED_OPERATIONS` in `agent.ts`) and a person is shown a button.
 * This route is what that button hits.
 *
 * THREE PROPERTIES MAKE THE CLICK SAFE, and all three live here:
 *
 *   1. THE PROPOSAL IS THE CONTRACT. `beginProposedAction` returns the
 *      PERSISTED operation and input, and those are what execute. Nothing from
 *      the request body decides what runs — a Block Kit button's `value` can be
 *      minted by anyone able to post in the workspace, so a click may only ever
 *      say WHICH proposal to run.
 *   2. THE CLICKER IS THE AUTHORIZER. This route runs under `slack_service`
 *      auth, so the delegated JWT is minted for the person who CLICKED, and the
 *      mint re-verifies their org membership. The proposer's identity executes
 *      nothing: someone who has been removed from the org cannot spend through
 *      a button they left behind, and someone who never had access to the
 *      project cannot gain it by clicking.
 *   3. THE CLAIM IS DURABLE. `proposed → executing` is a transactional
 *      transition in the backend; a double-click races there and exactly one
 *      caller wins. The loser is told, not billed.
 *
 * The tenant check below is not redundant with the claim: the claim guarantees
 * ONE execution, not a LEGITIMATE one. Without the team/project comparison, a
 * workspace that learned another workspace's action id could spend the other
 * org's quota — the claim would happily hand it the operation to run.
 */
import { Hono } from "hono";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import { AGENT_API_GATED_OPERATIONS } from "./agent.js";
import {
  beginProposedAction,
  completeProposedAction,
  getProposedAction,
  releaseProposedAction,
  SlackBackendUnavailable,
} from "../../services/slack-backend.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
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

    const isDiscord = c.get("authMethod") === "discord_service";
    const slackTeamId = c.get("slackTeamId");
    const slackUserId = c.get("slackUserId");
    const surfaceTenantId = c.get("surfaceTenantId");
    const surfaceActorId = c.get("surfaceActorId");
    if (
      (!isDiscord &&
        (c.get("authMethod") !== "slack_service" ||
          !slackTeamId ||
          !slackUserId)) ||
      (isDiscord && (!surfaceTenantId || !surfaceActorId))
    ) {
      return v1Error(
        c,
        "UNAUTHORIZED",
        "Approved actions can only be executed from the Slack surface that collected the approval."
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
    const sameSurface = isDiscord
      ? record?.surface === "discord" &&
        record.surfaceTenantId === surfaceTenantId
      : record?.surface !== "discord" && record?.teamId === slackTeamId;
    if (!record || !sameSurface) {
      return v1Error(c, "NOT_FOUND", "That approval is no longer available.");
    }
    if (record.projectId !== projectId) {
      return v1Error(
        c,
        "NOT_FOUND",
        "That approval belongs to a different project."
      );
    }

    // ORG CHECK BEFORE THE CLAIM. One Slack workspace can host people from
    // several MCPJam orgs. Letting an outsider reach `beginProposedAction`
    // would let them CLAIM the proposal and then fail authorization — burning
    // it, so the colleague who could legitimately approve it never gets to.
    // Same non-disclosing answer, so this is not an oracle either.
    if (record.organizationId !== c.get("mcpjamOrganizationId")) {
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

    let claim;
    try {
      claim = await beginProposedAction({
        actionId,
        ...(isDiscord
          ? { executorId: surfaceActorId }
          : { executedBySlackUserId: slackUserId }),
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
      convexJwt = await getConvexBearerForRequest(c);
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
          // The action id IS the idempotency key. A redelivered click, or a
          // retry after this process died mid-execution, presents the same key
          // and lands on the same run rather than billing a second one.
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

      await completeProposedAction({ actionId, status: "succeeded" }).catch(
        (error) => {
          // The work is DONE. A failed bookkeeping write only costs a stale
          // row; failing the response would tell the user their approved
          // action did not happen, which is false.
          logger.warn(
            "[v1/proposed-actions] action succeeded but recording it failed",
            { error: error instanceof Error ? error.message : String(error) }
          );
        }
      );

      return v1Resource(c, {
        actionId,
        operation: operation.name,
        status: "succeeded",
        result,
      });
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
