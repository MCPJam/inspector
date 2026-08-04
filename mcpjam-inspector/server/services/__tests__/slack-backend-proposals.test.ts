/**
 * The proposal wire payload — the one thing standing between a slipped deploy
 * order and stranded approvals.
 *
 * `createProposedAction` and `beginProposedAction` send BOTH the generic surface
 * quad and its Slack-named aliases. A backend that predates the generic columns
 * REQUIRES the aliases and 400s without them; the current backend prefers the
 * generic ones and ignores the rest. Sending both is what makes this build work
 * against either version.
 *
 * That property is invisible in normal operation and only fails during a
 * rollout, so it is asserted at the HTTP boundary here rather than left to be
 * discovered mid-deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginProposedAction,
  createProposedAction,
} from "../slack-backend.js";

const SLACK_PROPOSAL = {
  actionId: "act_1",
  surface: "slack",
  surfaceTenantId: "T1",
  surfaceActorId: "U_PROPOSER",
  surfaceConversationId: "C1",
  operation: "run_eval_suite",
  input: { suite: "smoke" },
  organizationId: "org_1",
  projectId: "p1",
};

describe("proposal wire compatibility", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  // `process.env` is shared by every test in the process. Leaving a fake
  // Convex URL and a fake service token behind would hand them to whichever
  // suite runs next — and a test that silently reads someone else's config is
  // worse than one that fails.
  const originalEnv = {
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The JSON body of the single request the call made. */
  async function sentBody(): Promise<Record<string, unknown>> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body));
  }

  it("sends BOTH spellings for a Slack proposal", async () => {
    await createProposedAction(SLACK_PROPOSAL);
    const body = await sentBody();
    // Generic: what the current backend reads.
    expect(body).toMatchObject({
      surface: "slack",
      surfaceTenantId: "T1",
      surfaceActorId: "U_PROPOSER",
      surfaceConversationId: "C1",
    });
    // Slack aliases: what a backend that predates the generic columns REQUIRES.
    expect(body).toMatchObject({
      teamId: "T1",
      channelId: "C1",
      proposedBySlackUserId: "U_PROPOSER",
    });
  });

  it("omits the Slack aliases for a NON-Slack surface", async () => {
    // A guild id in `teamId` would make a Discord proposal look like a Slack
    // one to exactly the code that cannot tell the difference.
    await createProposedAction({
      ...SLACK_PROPOSAL,
      surface: "discord",
      surfaceTenantId: "G1",
      surfaceConversationId: "CH1",
      surfaceActorId: "D_ALICE",
    });
    const body = await sentBody();
    expect(body.surface).toBe("discord");
    expect(body).not.toHaveProperty("teamId");
    expect(body).not.toHaveProperty("channelId");
    expect(body).not.toHaveProperty("proposedBySlackUserId");
  });

  it("sends both spellings of the CLICKER when claiming", async () => {
    // A claim that 400s is an approval the user watched fail.
    await beginProposedAction({ actionId: "act_1", executorId: "U_CLICKER" });
    const body = await sentBody();
    expect(body).toMatchObject({
      executorId: "U_CLICKER",
      executedBySlackUserId: "U_CLICKER",
    });
  });

  it("still posts to the path both backend versions serve", async () => {
    await createProposedAction(SLACK_PROPOSAL);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://convex.test/slack/proposed-actions/create");
  });
});
