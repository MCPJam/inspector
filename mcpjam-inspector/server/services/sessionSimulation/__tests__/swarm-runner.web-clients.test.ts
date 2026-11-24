/**
 * A web client swarm runs at most one session per usable web account at
 * once: each session holds its account for all its turns, the rest wait for
 * one to free up, and a lost account stops only its own session. The shared
 * session core is stubbed, so these tests see the runner's own scheduling.
 * Evidence: fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportAttemptMock = vi.fn();
const runSyntheticHostSessionMock = vi.fn();
const readAccountsMock = vi.fn();

vi.mock("../../swarm-agent.js", async () => ({
  ...(await vi.importActual<typeof import("../../swarm-agent.js")>("../../swarm-agent.js")),
  reportTargetGrounding: vi.fn(async () => ({})),
  reportAttempt: (...args: unknown[]) => reportAttemptMock(...args),
  swarmPersonaNextTurn: vi.fn(),
  heartbeatJourneyRun: vi.fn(async () => undefined),
  finalizePendingAttempts: vi.fn(async () => undefined),
  fetchPinnedSkill: vi.fn(),
}));
vi.mock("../runner.js", async () => ({
  ...(await vi.importActual<typeof import("../runner.js")>("../runner.js")),
  runSyntheticHostSession: (...args: unknown[]) => runSyntheticHostSessionMock(...args),
  captureAndPersistWidgetSnapshotsForSession: vi.fn(),
}));
vi.mock("../../web-clients/backend-connector-resolver.js", async () => ({
  ...(await vi.importActual<typeof import("../../web-clients/backend-connector-resolver.js")>(
    "../../web-clients/backend-connector-resolver.js",
  )),
  webClientService: () => ({ read: (command: unknown) => readAccountsMock(command), apply: vi.fn() }),
}));
// A hosted server, where a swarm takes the project's accounts.
vi.mock("../../web-clients/web-client-environment.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../web-clients/web-client-environment.js")
  >("../../web-clients/web-client-environment.js")),
  webClientTurnsRunHosted: () => true,
}));
vi.mock("../../web-clients/hosted-web-client-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../web-clients/hosted-web-client-runtime.js")>(
    "../../web-clients/hosted-web-client-runtime.js",
  )),
  actorForRun: async () => ({ actorUserId: "owner-1" }),
}));

import { startJourneyRun } from "../swarm-runner.js";

const WEB_HOST = {
  hostName: "ChatGPT web",
  hostConfigId: "hc-web",
  modelId: "chatgpt-web/default",
  harness: "chatgpt-web" as const,
  systemPrompt: "",
  requireToolApproval: false,
  serverIds: ["server-1"],
};

function opts(hostIds: string[]) {
  return {
    runId: "run-1",
    projectId: "proj-1",
    hosts: hostIds.map((hostId) => ({ ...WEB_HOST, hostId })),
    personaSnapshot: { personaId: "p1", name: "Persona One", role: "tester", notes: "" },
    sessionsPerTarget: 1,
    maxTurns: 2,
    convexHttpUrl: "https://convex.site",
    getBearer: async () => "token",
    managerFactory: async () => ({ manager: {} as never, connectedServerIds: ["server-1"], dispose: async () => {} }),
  };
}

function accounts(...ids: string[]) {
  readAccountsMock.mockResolvedValue(
    ids.map((webAccountId, index) => ({
      webAccountId,
      vendor: "chatgpt",
      status: "ready",
      hasProfile: true,
      isDefault: index === 0,
    })),
  );
}

/** Each session's account, and a way to end the session. */
function heldSessions() {
  const sessions: Array<{ account: string | undefined; end(): void; adapter: any }> = [];
  runSyntheticHostSessionMock.mockImplementation(
    (adapter: any) =>
      new Promise((resolve) => {
        sessions.push({
          account: adapter.runtime.webClientRun?.webAccountIds?.[0],
          adapter,
          end: () => resolve({ outcome: "succeeded" }),
        });
      }),
  );
  return sessions;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  reportAttemptMock.mockReset().mockResolvedValue({ ok: true, applied: true });
  runSyntheticHostSessionMock.mockReset();
  readAccountsMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a web client swarm's accounts", () => {
  it("queues a session until the account it needs frees up", async () => {
    accounts("acct-1");
    const sessions = heldSessions();
    const run = startJourneyRun(opts(["host-1", "host-2"]));
    await settle();
    expect(sessions.map((session) => session.account)).toEqual(["acct-1"]);
    expect(sessions[0]!.adapter.runtime.webClientRun).toMatchObject({ actor: { actorUserId: "owner-1" } });
    sessions[0]!.end();
    await settle();
    expect(sessions.map((session) => session.account)).toEqual(["acct-1", "acct-1"]);
    sessions[1]!.end();
    await run;
  });

  it("runs one session per account at once", async () => {
    accounts("acct-1", "acct-2");
    const sessions = heldSessions();
    const run = startJourneyRun(opts(["host-1", "host-2"]));
    await settle();
    expect(sessions.map((session) => session.account).sort()).toEqual(["acct-1", "acct-2"]);
    for (const session of sessions) session.end();
    await run;
  });

  it("stops a waiting session with the account's reason when none is left", async () => {
    accounts("acct-1");
    const sessions = heldSessions();
    const run = startJourneyRun(opts(["host-1", "host-2"]));
    await settle();
    sessions[0]!.adapter.runtime.webClientRun.onAccountLost("ChatGPT web needs sign-in. Sign in again, then send again.");
    sessions[0]!.end();
    await run;
    expect(sessions).toHaveLength(1);
    expect(reportAttemptMock).toHaveBeenCalledWith(
      "https://convex.site",
      "token",
      expect.objectContaining({
        hostId: "host-2",
        status: "failed",
        errorCode: "web_account_unavailable",
        errorMessage: "ChatGPT web needs sign-in. Sign in again, then send again.",
      }),
    );
  });

  it("leaves another runner's attempt alone when no account is left before this runner's claim", async () => {
    accounts("acct-1");
    const sessions = heldSessions();
    // A duplicate runner already claimed host-2's attempt, so a claim here replays.
    reportAttemptMock.mockImplementation(async (_url: string, _bearer: string, report: any) => ({
      ok: true,
      applied: !(report.hostId === "host-2" && report.status === "running"),
    }));
    const run = startJourneyRun(opts(["host-1", "host-2"]));
    await settle();
    sessions[0]!.adapter.runtime.webClientRun.onAccountLost("ChatGPT web needs sign-in. Sign in again, then send again.");
    sessions[0]!.end();
    await run;
    const host2 = reportAttemptMock.mock.calls.map((call) => call[2]).filter((report) => report.hostId === "host-2");
    expect(host2.map((report) => report.status)).toEqual(["running"]);
  });

  it("still ends this runner's own attempt when its session fails after the claim", async () => {
    accounts("acct-1");
    runSyntheticHostSessionMock.mockRejectedValue(new Error("the session broke"));
    // The sweep's re-claim of the attempt this runner holds replays, like any repeat claim.
    const claimed = new Set<string>();
    reportAttemptMock.mockImplementation(async (_url: string, _bearer: string, report: any) => {
      const key = `${report.hostId}:${report.sessionIdx}`;
      const first = report.status !== "running" || !claimed.has(key);
      if (report.status === "running") claimed.add(key);
      return { ok: true, applied: first };
    });
    await startJourneyRun(opts(["host-1"]));
    expect(reportAttemptMock).toHaveBeenCalledWith(
      "https://convex.site",
      "token",
      expect.objectContaining({ hostId: "host-1", sessionIdx: 0, status: "failed", errorCode: "host_worker_failed" }),
    );
  });
});
