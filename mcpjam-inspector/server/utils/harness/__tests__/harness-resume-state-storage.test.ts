import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexToJson, jsonToConvex } from "convex/values";
import { OrgLeaseTurn } from "../org-lease-turn";
import {
  claimHarnessSessionState,
  commitHarnessSessionState,
} from "../harness-session-state";

/**
 * A harness lane's resume state, committed and claimed back through the real
 * session-state client and the same `OrgLeaseTurn` calls a turn makes.
 *
 * The fake Convex passes each commit through `convexToJson`, as a Convex HTTP
 * action does when it hands its arguments to a mutation, so a field name
 * Convex refuses fails here the way it fails on a deployment.
 */
const CONVEX = "https://convex.test";
const BEARER = "Bearer t";
const OWNER = {
  projectId: "proj_1",
  harnessId: "codex" as const,
  ownerType: "direct-chat" as const,
  chatSessionId: "chat_1",
};

/** What `session.suspendTurn()` hands back for a Codex turn paused on bash. */
const continuation = {
  type: "continue-turn",
  harnessId: "codex",
  specificationVersion: "v1",
  data: {
    threadId: "thread_1",
    bridge: { port: 4100, token: "t", lastSeenEventId: 7, sandboxId: "sbx_1" },
  },
  turnSettings: {
    skills: [],
    tools: [
      {
        name: "read_wiki_structure",
        description: "List a repository's documentation topics",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { repoName: { $ref: "#/$defs/repo" } },
          $defs: { repo: { type: "string" } },
        },
      },
    ],
  },
  pendingToolApprovals: [
    {
      approvalId: "approval_1",
      toolCallId: "call_1",
      toolName: "bash",
      input: '{"command":"ls"}',
      kind: "builtin",
      providerExecuted: true,
    },
  ],
};

let stored: unknown;

beforeEach(() => {
  stored = undefined;
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      try {
        if (url === `${CONVEX}/web/harness/session-state/commit`) {
          stored = jsonToConvex(convexToJson(body.resumeState));
          return Response.json({ ok: true });
        }
        if (url === `${CONVEX}/web/harness/session-state/claim`) {
          return Response.json({
            ok: true,
            stateVersion: 1,
            state: { harnessSessionId: "native", resumeState: stored },
          });
        }
      } catch (error) {
        return Response.json(
          { ok: false, error: String(error) },
          { status: 500 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const turn = () => new OrgLeaseTurn({ harness: "codex", authHeader: BEARER });

async function commit(resumeState: unknown) {
  return commitHarnessSessionState({
    owner: OWNER,
    leaseId: "lease_1",
    expectedStateVersion: 0,
    harnessSessionId: "native",
    resumeState: turn().commitState(resumeState),
    computerId: "sbx_1",
    runtimeFingerprint: "fingerprint",
    awaitingApproval: true,
    bearer: BEARER,
  });
}

async function claimResumeState() {
  const claim = await claimHarnessSessionState({
    owner: OWNER,
    runtimeFingerprint: "fingerprint",
    leaseId: "lease_2",
    leasedBy: "turn_2",
    leaseTtlMs: 300_000,
    bearer: BEARER,
  });
  if (!claim.ok) throw new Error(claim.error);
  return turn().claimed(
    claim.state as { harnessSessionId: string; resumeState: unknown } | null,
  )?.resumeState;
}

describe("a paused turn's resume state in Convex", () => {
  it("commits a continuation whose tool schemas use $ keywords, and claims it back unchanged", async () => {
    expect(await commit(continuation)).toBe(true);
    expect(await claimResumeState()).toEqual(continuation);
  });

  it("stores the approval and bridge records as they were, for readers that do not unescape", async () => {
    await commit(continuation);
    expect(stored).toMatchObject({
      pendingToolApprovals: continuation.pendingToolApprovals,
      data: { bridge: { sandboxId: "sbx_1" } },
    });
  });

  it("leaves a resume state with no reserved keys as it was", () => {
    const { turnSettings: _settings, ...plain } = continuation;
    expect(turn().commitState(plain)).toEqual(plain);
  });
});
