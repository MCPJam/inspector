/**
 * The approval-execution route, pinned before it is refactored.
 *
 * `POST /projects/:projectId/proposed-actions/:actionId/execute` carries three
 * properties that nothing else in the codebase re-implements, and none of them
 * had a test:
 *
 *   1. THE PROPOSAL IS THE CONTRACT — what executes is the PERSISTED operation
 *      and input, re-clamped to the PERSISTED project. Nothing from the request
 *      body may influence it.
 *   2. THE CLICKER IS THE AUTHORIZER — the route is reachable only from the
 *      surface that collected the approval, and a mismatched team / project /
 *      org gets the same non-disclosing answer as a missing proposal.
 *   3. THE CLAIM IS DURABLE — a claim failure fails CLOSED, and once the claim
 *      is held every exit either completes it (work may have started) or
 *      releases it (work provably did not).
 *
 * These are the invariants the surface-abstraction refactor must not move, so
 * they are asserted here first and left untouched by it.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveSlackActingUserMock,
  getProposedActionMock,
  beginProposedActionMock,
  completeProposedActionMock,
  releaseProposedActionMock,
  createProposedActionMock,
  getOrgAgentPolicyMock,
  getConvexBearerMock,
  getSelfFetchMock,
} = vi.hoisted(() => {
  process.env.DO_NOT_TRACK = "1";
  return {
    resolveSlackActingUserMock: vi.fn(),
    getProposedActionMock: vi.fn(),
    beginProposedActionMock: vi.fn(),
    completeProposedActionMock: vi.fn(),
    releaseProposedActionMock: vi.fn(),
    createProposedActionMock: vi.fn(),
    getOrgAgentPolicyMock: vi.fn(),
    getConvexBearerMock: vi.fn(),
    getSelfFetchMock: vi.fn(),
  };
});

const FakeSlackBackendUnavailable = vi.hoisted(
  () => class SlackBackendUnavailable extends Error {}
);

vi.mock("../../../services/slack-backend.js", () => ({
  resolveSlackActingUser: resolveSlackActingUserMock,
  getProposedAction: getProposedActionMock,
  beginProposedAction: beginProposedActionMock,
  completeProposedAction: completeProposedActionMock,
  releaseProposedAction: releaseProposedActionMock,
  createProposedAction: createProposedActionMock,
  getOrgAgentPolicy: getOrgAgentPolicyMock,
  SlackBackendUnavailable: FakeSlackBackendUnavailable,
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  // Execution mints the clicker's token UNCACHED, so it can carry this
  // action's id — every write the operation makes then lands an audit row
  // naming the proposal a human approved rather than the clicker acting alone.
  getConvexBearerForApprovedAction: getConvexBearerMock,
}));

vi.mock("../../../utils/self-app.js", () => ({
  getSelfFetch: getSelfFetchMock,
}));

import v1Routes from "../index.js";
import { clearOrgAgentPolicyCache } from "../../../utils/org-agent-policy.js";
import { AGENT_API_GATED_OPERATIONS } from "../agent.js";
import { gatedEntryFor } from "../agent-op-registry.js";
import { resetSlackRateLimitForTests } from "../../../middleware/slack-service-auth.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../../utils/idempotency.js";
import {
  installRegistryDirectoryServerOperation,
  runEvalSuiteOperation,
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";

const TOKEN = "slk_proposed_actions_test_token_0123456789";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

const LINK = {
  userId: "user_1",
  workosUserId: "workos|alice",
  organizationId: "org_1",
  defaultProjectId: null,
};

/** A stored proposal that passes every gate, so each test mutates one field. */
function storedProposal(overrides: Record<string, unknown> = {}) {
  return {
    actionId: "act_1",
    surface: "slack",
    surfaceTenantId: "T1",
    surfaceConversationId: "C1",
    surfaceActorId: "U_PROPOSER",
    surfaceExecutorId: null,
    teamId: "T1",
    channelId: "C1",
    operation: runEvalSuiteOperation.name,
    input: { suite: "smoke", project: "p1" },
    organizationId: "org_1",
    projectId: "p1",
    status: "proposed" as const,
    expired: false,
    ...overrides,
  };
}

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function executeRequest(
  app: Hono,
  opts: {
    projectId?: string;
    actionId?: string;
    slackUserId?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<Response> {
  const projectId = opts.projectId ?? "p1";
  const actionId = opts.actionId ?? "act_1";
  return Promise.resolve(
    app.request(
      `/api/v1/projects/${projectId}/proposed-actions/${actionId}/execute`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.token ?? TOKEN}`,
          "x-mcpjam-slack-team-id": "T1",
          "x-mcpjam-slack-user-id": opts.slackUserId ?? "U_CLICKER",
          ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }
    )
  );
}

describe("POST /api/v1/projects/:projectId/proposed-actions/:actionId/execute", () => {
  beforeEach(() => {
    resetSlackRateLimitForTests();
    // The policy cache is process-global and 60 s TTL; a case that left an
    // entry behind would silently decide the next one's outcome.
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = TOKEN_HASH;
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    resolveSlackActingUserMock.mockResolvedValue(LINK);
    getProposedActionMock.mockResolvedValue(storedProposal());
    beginProposedActionMock.mockResolvedValue({
      ok: true,
      operation: runEvalSuiteOperation.name,
      input: { suite: "smoke" },
      organizationId: "org_1",
      projectId: "p1",
      teamId: "T1",
    });
    completeProposedActionMock.mockResolvedValue({ ok: true });
    releaseProposedActionMock.mockResolvedValue({ released: true });
    getConvexBearerMock.mockResolvedValue("delegated-jwt");
    getSelfFetchMock.mockReturnValue(async () => new Response("{}"));
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ── The clicker is the authorizer ────────────────────────────────────

  it("refuses a caller that is not the approval surface", async () => {
    // No `slk_` credential ⇒ no clicker to attribute the spend to. An `sk_`
    // caller reaching this route would be executing an approval nobody gave.
    const res = await makeApp().request(
      "/api/v1/projects/p1/proposed-actions/act_1/execute",
      { method: "POST", headers: { Authorization: "Bearer sk_whatever" } }
    );
    expect(res.status).toBe(401);
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND — never an oracle — for another workspace's proposal", async () => {
    getProposedActionMock.mockResolvedValue(
      storedProposal({ surfaceTenantId: "T_OTHER", teamId: "T_OTHER" })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    // Same wording as a genuinely missing proposal: distinguishing the two
    // would turn this route into an existence oracle for other orgs' ids.
    expect(body.message).toBe("That approval is no longer available.");
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a proposal belonging to another project", async () => {
    getProposedActionMock.mockResolvedValue(
      storedProposal({ projectId: "p_other" })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    // Byte-identical to the tenant/org/missing answers. A "different project"
    // message would confirm the id exists in this workspace and let a caller
    // binary-search which project it lives in.
    expect(body.message).toBe("That approval is no longer available.");
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("checks the ORG before claiming, so an outsider cannot burn the proposal", async () => {
    // One Slack workspace can host people from several MCPJam orgs. Letting an
    // outsider reach the claim would let them take it and then fail auth —
    // burning it for the colleague who could legitimately approve it.
    getProposedActionMock.mockResolvedValue(
      storedProposal({ organizationId: "org_other" })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND when the proposal does not exist", async () => {
    getProposedActionMock.mockResolvedValue(null);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("refuses a claim whose identity diverged from the pre-claim read", async () => {
    // The operation to execute is resolved from the read; the input from the
    // claim. If the row changed identity in between, running would execute
    // something nobody was shown — so the route enforces the equality instead
    // of assuming it, and deliberately strands the suspect claim (no release:
    // a proposal whose identity moved is not one any click should spend).
    beginProposedActionMock.mockResolvedValue({
      ok: true,
      operation: "call_server_tool",
      input: { suite: "smoke" },
      organizationId: "org_1",
      projectId: "p1",
      teamId: "T1",
    });
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    expect(releaseProposedActionMock).not.toHaveBeenCalled();
    expect(completeProposedActionMock).not.toHaveBeenCalled();
  });

  it("answers SERVER_UNREACHABLE — not NOT_FOUND — when the read fails", async () => {
    // "Could not ask" is not "does not exist": a clicker told their approval
    // had vanished would go looking for a proposal sitting there intact.
    getProposedActionMock.mockRejectedValue(
      new FakeSlackBackendUnavailable("down")
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(502);
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  // ── The proposal is the contract ─────────────────────────────────────

  it("refuses a proposal naming an operation this build does not gate", async () => {
    getProposedActionMock.mockResolvedValue(
      storedProposal({ operation: "delete_everything" })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(400);
    // Refuse rather than reach for some other operation by the same name.
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("executes the PERSISTED input, re-clamped to the PERSISTED project", async () => {
    beginProposedActionMock.mockResolvedValue({
      ok: true,
      operation: runEvalSuiteOperation.name,
      // The persisted input names a DIFFERENT project than the claim's — the
      // claim's projectId is what must win.
      input: { suite: "smoke", project: "p_stale" },
      organizationId: "org_1",
      projectId: "p1",
      teamId: "T1",
    });
    const executeSpy = vi
      .spyOn(runEvalSuiteOperation, "execute")
      .mockResolvedValue({ runId: "run_1" } as never);

    const res = await executeRequest(makeApp(), {
      // Nothing in the body may steer the execution.
      body: { operation: "cancel_eval_run", input: { suite: "attacker" } },
    });
    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(
      { suite: "smoke", project: "p1" },
      expect.anything()
    );
  });

  it("carries an install proposal's PINS through to the operation's execute", async () => {
    // The mutation-side rejection lives in the backend; what this route owes
    // the freeze is that the persisted pins reach `operation.execute` intact,
    // so the backend has something to check.
    const pinnedInput = {
      catalogServerId: "cs_1",
      endpointUrl: "https://mcp.linear.app/mcp",
      expectedContentHash: "hash_at_propose",
    };
    getProposedActionMock.mockResolvedValue(
      storedProposal({
        operation: installRegistryDirectoryServerOperation.name,
        input: { ...pinnedInput, project: "p1" },
      })
    );
    beginProposedActionMock.mockResolvedValue({
      ok: true,
      operation: installRegistryDirectoryServerOperation.name,
      input: pinnedInput,
      organizationId: "org_1",
      projectId: "p1",
      teamId: "T1",
    });
    const executeSpy = vi
      .spyOn(installRegistryDirectoryServerOperation, "execute")
      .mockResolvedValue({
        serverId: "srv_1",
        serverName: "linear",
        outcome: "created",
      } as never);

    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(
      {
        catalogServerId: "cs_1",
        endpointUrl: "https://mcp.linear.app/mcp",
        expectedContentHash: "hash_at_propose",
        project: "p1",
      },
      expect.anything()
    );
  });

  it("refuses an install whose stored input is missing its pins", async () => {
    // Defense in depth behind the mint-time refusal: a row minted before the
    // `requiredFrozenKeys` contract — or a tampered one — must not execute,
    // because the click would install whatever the registry resolves to NOW
    // rather than what the approver saw. Retired as failed, never released:
    // the row is permanently invalid and a release would hand the same broken
    // button to the next click.
    getProposedActionMock.mockResolvedValue(
      storedProposal({
        operation: installRegistryDirectoryServerOperation.name,
        input: { catalogServerId: "cs_1", project: "p1" },
      })
    );
    beginProposedActionMock.mockResolvedValue({
      ok: true,
      operation: installRegistryDirectoryServerOperation.name,
      input: { catalogServerId: "cs_1" },
      organizationId: "org_1",
      projectId: "p1",
      teamId: "T1",
    });
    const executeSpy = vi.spyOn(
      installRegistryDirectoryServerOperation,
      "execute"
    );

    const res = await executeRequest(makeApp());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(completeProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "act_1",
        status: "failed",
        failureReason: expect.stringContaining("pins"),
      })
    );
    expect(releaseProposedActionMock).not.toHaveBeenCalled();
  });

  it("stamps `proposal:<actionId>:<operation>` as the inner idempotency key", async () => {
    // A redelivered click, or a retry after this process died mid-execution,
    // presents the same key and lands on the same run rather than a second one.
    let seenKey: string | null = null;
    getSelfFetchMock.mockReturnValue(async (request: Request) => {
      seenKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      return new Response(JSON.stringify({ runId: "run_1" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const executeSpy = vi
      .spyOn(runEvalSuiteOperation, "execute")
      .mockImplementation(async (_input, { client }) => {
        // Drive one request through the injected client so the header the
        // route stamps on every inner request is observable.
        await (client as PlatformApiClient).getMe();
        return { runId: "run_1" } as never;
      });

    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalled();
    expect(seenKey).toBe(`proposal:act_1:${runEvalSuiteOperation.name}`);
  });

  // ── The claim is durable ─────────────────────────────────────────────

  it("fails CLOSED when the claim cannot be taken", async () => {
    // An unreachable backend must never be read as permission to spend.
    beginProposedActionMock.mockRejectedValue(new Error("backend down"));
    const executeSpy = vi.spyOn(runEvalSuiteOperation, "execute");
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(502);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("reports an expired approval as a validation error, not a 404", async () => {
    beginProposedActionMock.mockResolvedValue({
      ok: false,
      reason: "expired",
    });
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/expired/i);
  });

  it("reports a lost claim race as CONFLICT, distinguishing running from handled", async () => {
    beginProposedActionMock.mockResolvedValue({
      ok: false,
      reason: "already_claimed",
      status: "executing",
    });
    const running = await executeRequest(makeApp());
    expect(running.status).toBe(409);
    await expect(running.json()).resolves.toMatchObject({
      message: "That action is already running.",
    });

    beginProposedActionMock.mockResolvedValue({
      ok: false,
      reason: "already_claimed",
      status: "succeeded",
    });
    const handled = await executeRequest(makeApp());
    expect(handled.status).toBe(409);
    await expect(handled.json()).resolves.toMatchObject({
      message: "That action has already been handled.",
    });
  });

  it("RELEASES the claim when the clicker's token cannot be minted", async () => {
    // Provably before the spend: nothing ran, so the proposal must go back to
    // `proposed` for a legitimate retry rather than being stranded.
    getConvexBearerMock.mockRejectedValue(new Error("not a member"));
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(401);
    expect(releaseProposedActionMock).toHaveBeenCalledWith("act_1");
    expect(completeProposedActionMock).not.toHaveBeenCalled();
  });

  it("marks FAILED — never released — when the operation itself throws", async () => {
    // We cannot prove the operation did not start, and an "unsure" release is
    // how an approved action gets billed twice.
    vi.spyOn(runEvalSuiteOperation, "execute").mockRejectedValue(
      new Error("boom")
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(500);
    expect(completeProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "act_1", status: "failed" })
    );
    expect(releaseProposedActionMock).not.toHaveBeenCalled();
  });

  it("still answers 200 when recording a SUCCESS fails", async () => {
    // The work is done. Failing the response would tell the user their
    // approved action did not happen, which is false.
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
    } as never);
    completeProposedActionMock.mockRejectedValue(new Error("bookkeeping down"));
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      actionId: "act_1",
      operation: runEvalSuiteOperation.name,
      status: "succeeded",
    });
  });

  it("returns the operation and status the caller renders from", async () => {
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
      suiteId: "ts_1",
    } as never);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      actionId: "act_1",
      operation: runEvalSuiteOperation.name,
      status: "succeeded",
      result: { runId: "run_1", suiteId: "ts_1" },
    });
  });

  // ── Surface abstraction ──────────────────────────────────────────────

  it("claims as the CLICKER, in the surface's own id space", async () => {
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
    } as never);
    await executeRequest(makeApp(), { slackUserId: "U_CLICKER" });
    expect(beginProposedActionMock).toHaveBeenCalledWith({
      actionId: "act_1",
      // Not `U_PROPOSER`: the proposer's identity executes nothing.
      executorId: "U_CLICKER",
    });
  });

  it("refuses a proposal from a DIFFERENT surface with the same tenant id", async () => {
    // Tenant ids are only unique WITHIN a product. Comparing the surface too
    // is what stops one product's id from matching another's by coincidence.
    getProposedActionMock.mockResolvedValue(
      storedProposal({ surface: "discord", teamId: null })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(404);
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy teamId for a row written before the surface columns", async () => {
    // A mid-deploy row carries its tenant only in `teamId`. Refusing it would
    // strand every proposal made in the minutes before the rollout.
    getProposedActionMock.mockResolvedValue(
      storedProposal({ surface: undefined, surfaceTenantId: null })
    );
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
    } as never);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
  });

  it("derives kind and a typed resource SERVER-SIDE from the registry", async () => {
    // A host that synthesised the URL itself would need to know each
    // operation's result shape, and would link to nothing the moment one
    // changed.
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
      suite: { id: "ts_1", name: "smoke" },
    } as never);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      resource?: { type: string; id: string; url: string };
    };
    expect(body.kind).toBe("start");
    expect(body.resource).toMatchObject({ type: "eval_run", id: "run_1" });
    // `?project=` makes the link land on the right project for viewers whose
    // picker is parked elsewhere (eval routes carry no project segment).
    expect(body.resource!.url).toContain("/evals/suite/ts_1/runs/run_1");
    expect(body.resource!.url).toContain("project=p1");
  });

  it("never charges a link-builder failure to the operation", async () => {
    // The work is DONE and already recorded `succeeded`. A throw in the link
    // builder reaching the operation's catch would re-record it `failed` and
    // answer 500 — telling the user their approved action did not happen, and
    // leaving the lifecycle row contradicting itself over a formatting helper.
    const entry = gatedEntryFor(runEvalSuiteOperation.name)!;
    const original = entry.proposal.resource;
    entry.proposal.resource = () => {
      throw new Error("bad link");
    };
    try {
      vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
        runId: "run_1",
        suite: { id: "ts_1" },
      } as never);
      const res = await executeRequest(makeApp());
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: "succeeded" });
      expect(completeProposedActionMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "succeeded" })
      );
      expect(completeProposedActionMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" })
      );
    } finally {
      entry.proposal.resource = original;
    }
  });

  it("omits the resource when the action produced nothing linkable", async () => {
    // Absent means "there is nothing to look at", which is different from
    // "the host could not work out a link".
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      status: "queued",
    } as never);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.not.toHaveProperty("resource");
  });

  // ── Org capability policy ────────────────────────────────────────────

  it("refuses a disabled operation WITHOUT claiming the proposal", async () => {
    // A post-claim denial would BURN the proposal: the row goes `executing`
    // and nobody can approve it afterwards. An org that disables an op
    // mid-flight should stop the clicks, not destroy the buttons.
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: [runEvalSuiteOperation.name],
    });
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "FORBIDDEN",
      message:
        "This action has been disabled by your organization's administrators.",
    });
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the policy cannot be read", async () => {
    // The alternative to "try again in a moment" is spending under a policy we
    // could not read. Unlike tool assembly, that trade does not go the other
    // way here.
    getOrgAgentPolicyMock.mockRejectedValue(
      new FakeSlackBackendUnavailable("convex down")
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      code: "SERVER_UNREACHABLE",
    });
    expect(beginProposedActionMock).not.toHaveBeenCalled();
  });

  it("treats a route-missing backend as an empty policy", async () => {
    // Deployable ahead of the backend: a 404 means the deployment predates the
    // policy route, which is a complete answer, not an outage.
    const missing = new FakeSlackBackendUnavailable("404") as Error & {
      status?: number;
    };
    missing.status = 404;
    getOrgAgentPolicyMock.mockRejectedValue(missing);
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({} as never);
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(200);
    expect(beginProposedActionMock).toHaveBeenCalled();
  });

  it("checks the policy AFTER the unknown-operation refusal", async () => {
    // Order matters: an operation this build does not gate is a louder, more
    // specific failure than "your org turned this off".
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: ["definitely_not_an_operation"],
    });
    getProposedActionMock.mockResolvedValue(
      storedProposal({ operation: "definitely_not_an_operation" })
    );
    const res = await executeRequest(makeApp());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // The allowlist refuses first, so the policy is never consulted — without
    // this the same 400 would appear if the order were reversed and the policy
    // simply failed to match the name.
    expect(getOrgAgentPolicyMock).not.toHaveBeenCalled();
  });

  it("reports the run resource to the backend so the activity feed can link it", async () => {
    vi.spyOn(runEvalSuiteOperation, "execute").mockResolvedValue({
      runId: "run_1",
      suite: { id: "ts_1" },
    } as never);
    await executeRequest(makeApp());
    expect(completeProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        resourceId: "run_1",
        resourceUrl: expect.stringContaining("/evals/suite/ts_1/runs/run_1"),
      })
    );
  });

  it("gates on exactly the operations the agent surface proposes", () => {
    // The route resolves `record.operation` against this set; a name outside
    // it is refused. Keeping the two in lockstep is what stops a rollback from
    // executing an operation the current build no longer means to gate.
    expect(AGENT_API_GATED_OPERATIONS.map((op) => op.name)).toContain(
      runEvalSuiteOperation.name
    );
  });
});
