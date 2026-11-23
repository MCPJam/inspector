/**
 * The reconnect backend over the backend's service functions, against a
 * stubbed deployment: a real Convex client whose fetch answers as
 * `webClientService:read` and `:apply`, the profile-key route and storage
 * would. Checks what goes on the wire and how refusals become outcomes.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WebBackendRefusal, type PendingStep } from "../backend.js";
import {
  createConvexLedgerReader,
  createConvexWebReconnectBackend,
} from "../convex-backend.js";
import { createWebRecoveryCoordinator } from "../coordinator.js";
import { openWebProfile } from "../profile-cipher.js";
import { reconcileWithLedger } from "../reconcile.js";

const ENV = {
  CONVEX_URL: "https://backend.example.test",
  CONVEX_HTTP_URL: "https://routes.example.test",
  INSPECTOR_SERVICE_TOKEN: "fixture-service-token",
};
const ACTOR = { actorExternalId: "user_fixture" };
const PROJECT = "project-1";
const ACCOUNT = "web-account-1";
const SEAT = {
  accountEmail: "seat@example.com",
  workspaceName: "Test workspace",
};
const PROFILE = new TextEncoder().encode("fixture-profile");
const STEP: PendingStep = {
  stepId: "step-1",
  startedAt: "2026-11-20T10:00:00.000Z",
  turnId: "turn-1",
};

type Answer = unknown | WebBackendRefusal;
type Call = {
  to: string;
  args: Record<string, unknown>;
  headers: Headers;
  body?: Uint8Array;
};

/** A deployment that answers each command, route and upload from `answers`. */
function stubDeployment(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const reply = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith(ENV.CONVEX_URL)) {
      const { path, args } = JSON.parse(String(init?.body));
      const sent = args[0] as Record<string, unknown>;
      const { action } = sent.command as { action: string };
      calls.push({ to: `${path} ${action}`, args: sent, headers });
      const answer = answers[action];
      if (answer instanceof WebBackendRefusal) {
        const errorData = { code: answer.code, message: answer.message };
        return reply(560, { status: "error", errorMessage: "", errorData });
      }
      return reply(200, { status: "success", value: answer ?? null });
    }
    if (url.endsWith("/profile-key")) {
      calls.push({
        to: "profile-key",
        args: JSON.parse(String(init?.body)),
        headers,
      });
      const answer = answers["profile-key"];
      if (answer instanceof WebBackendRefusal) {
        return reply(409, { error: { code: answer.code } });
      }
      return reply(200, answer);
    }
    const body = new Uint8Array(init?.body as ArrayBuffer);
    calls.push({ to: "upload", args: {}, headers, body });
    return reply(200, { storageId: "storage-1" });
  };
  return { calls, fetchImpl, options: { env: ENV, fetchImpl } };
}

const OPEN_REQUEST = {
  requestId: "request-1",
  webAccountId: ACCOUNT,
  status: "open",
  reason: "signed_out",
  openedAt: 1,
  notificationCount: 1,
  waitingRunCount: 1,
};
const ACCOUNT_VIEW = {
  webAccountId: ACCOUNT,
  projectId: PROJECT,
  status: "needs_sign_in",
  ...SEAT,
  profileVersion: 3,
  label: "Test seat",
};

function profileKey(dataKey: Buffer, expectedProfileVersion = 3) {
  return {
    webAccountId: ACCOUNT,
    expectedProfileVersion,
    dataKey: dataKey.toString("base64"),
    wrappedKey: "sealed-key",
    uploadUrl: "https://storage.example.test/upload",
  };
}

describe("Convex reconnect backend", () => {
  it("sends each command through the service functions as the actor", async () => {
    const deployment = stubDeployment({
      listWebAccounts: [ACCOUNT_VIEW],
      listWebReconnectRequests: [OPEN_REQUEST],
      reportWebSignInRequired: { requestId: "request-1", shouldNotify: true },
      markWebAccountNeedsSignIn: ACCOUNT_VIEW,
      handbackWebReconnect: { status: "resolved", resumableRunIds: ["run-1"] },
      claimResumableWebRuns: [
        {
          runId: "run-1",
          requestId: "request-1",
          pendingStep: JSON.stringify(STEP),
        },
        { runId: "run-2", requestId: "request-1", pendingStep: "not json" },
      ],
    });
    const backend = createConvexWebReconnectBackend(ACTOR, deployment.options);

    expect(await backend.listWebAccounts({ projectId: PROJECT })).toEqual([
      ACCOUNT_VIEW,
    ]);
    await backend.listWebReconnectRequests({ projectId: PROJECT });
    expect(
      await backend.reportWebSignInRequired({
        webAccountId: ACCOUNT,
        runId: "run-1",
        pendingStep: STEP,
        reason: "signed_out",
      }),
    ).toEqual({ requestId: "request-1", shouldNotify: true });
    await backend.markWebAccountNeedsSignIn({
      webAccountId: ACCOUNT,
      reason: "wrong_account",
    });
    await backend.handbackWebReconnect({
      requestId: "request-1",
      verifiedAccountEmail: SEAT.accountEmail,
    });
    // The unreadable step is dropped and reported, not resumed blind.
    expect(
      await backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
    ).toEqual([{ runId: "run-1", requestId: "request-1", pendingStep: STEP }]);

    expect(deployment.calls.map((call) => call.to)).toEqual([
      "webClientService:read listWebAccounts",
      "webClientService:read listWebReconnectRequests",
      "webClientService:apply reportWebSignInRequired",
      "webClientService:apply markWebAccountNeedsSignIn",
      "webClientService:apply handbackWebReconnect",
      "webClientService:apply claimResumableWebRuns",
    ]);
    for (const { to, args, headers } of deployment.calls) {
      // The service credential is the only authority; no user bearer is sent.
      expect(args.serviceToken).toBe(ENV.INSPECTOR_SERVICE_TOKEN);
      expect(headers.get("authorization")).toBeNull();
      expect(typeof args.requestId).toBe(
        to.includes(":read") ? "string" : "undefined",
      );
      expect(args.command).toMatchObject(ACTOR);
    }
    expect(deployment.calls[2]?.args.command).toEqual({
      action: "reportWebSignInRequired",
      ...ACTOR,
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep: JSON.stringify(STEP),
      reason: "signed_out",
    });
  });

  it("saves a profile as ciphertext under the key the backend issued", async () => {
    const dataKey = randomBytes(32);
    const deployment = stubDeployment({
      "profile-key": profileKey(dataKey),
      saveWebAccountProfile: { ok: true, profileVersion: 4 },
    });
    const backend = createConvexWebReconnectBackend(ACTOR, deployment.options);

    expect(
      await backend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
        savedFromRunId: "run-1",
      }),
    ).toEqual({ ok: true, profileVersion: 4 });
    const [key, upload, save] = deployment.calls;
    expect(key?.args).toEqual({ ...ACTOR, webAccountId: ACCOUNT });
    expect(key?.headers.get("x-inspector-service-token")).toBe(
      ENV.INSPECTOR_SERVICE_TOKEN,
    );
    const sealed = upload?.body ?? new Uint8Array();
    expect(Buffer.from(sealed).includes(Buffer.from(PROFILE))).toBe(false);
    expect(openWebProfile(sealed, dataKey)).toEqual(Buffer.from(PROFILE));
    const tampered = Uint8Array.from(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => openWebProfile(tampered, dataKey)).toThrow();
    expect(() => openWebProfile(sealed, randomBytes(32))).toThrow();
    expect(save?.args.command).toEqual({
      action: "saveWebAccountProfile",
      ...ACTOR,
      webAccountId: ACCOUNT,
      expectedProfileVersion: 3,
      storageId: "storage-1",
      wrappedKey: "sealed-key",
      savedFromRunId: "run-1",
    });

    // A key issued for a newer version means another save landed first.
    const stale = stubDeployment({ "profile-key": profileKey(dataKey, 4) });
    const staleBackend = createConvexWebReconnectBackend(ACTOR, stale.options);
    expect(
      await staleBackend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
      }),
    ).toEqual({ ok: false, reason: "version_conflict", profileVersion: 4 });
    expect(stale.calls.map((call) => call.to)).toEqual(["profile-key"]);
  });

  it.each([
    // The seat matched, so a conflict is a request cancelled meanwhile.
    ["CONFLICT", "handbackWebReconnect", "cancelled"],
    ["NOT_FOUND", "handbackWebReconnect", "not_found"],
    ["WEB_ACCOUNT_NEEDS_SIGN_IN", "profile-key", "not_signed_in"],
    ["NOT_FOUND", "listWebReconnectRequests", "not_found"],
  ])(
    "answers a handback refused with %s from %s as %s",
    async (code, refusedBy, outcome) => {
      const deployment = stubDeployment({
        listWebReconnectRequests: [OPEN_REQUEST],
        listWebAccounts: [ACCOUNT_VIEW],
        "profile-key": profileKey(randomBytes(32)),
        saveWebAccountProfile: { ok: true, profileVersion: 4 },
        handbackWebReconnect: { status: "resolved", resumableRunIds: [] },
        claimResumableWebRuns: [],
        [refusedBy]: new WebBackendRefusal(code),
      });
      const coordinator = createWebRecoveryCoordinator({
        backend: createConvexWebReconnectBackend(ACTOR, deployment.options),
        ledger: createConvexLedgerReader(deployment.options),
        resumeRun: vi.fn(),
      });

      expect(
        await coordinator.handback({
          projectId: PROJECT,
          requestId: "request-1",
          browser: {
            verifyAccount: async () => SEAT,
            captureProfile: async () => PROFILE,
          },
        }),
      ).toEqual({ status: outcome });
    },
  );

  it("keeps the status of a refusal whose body isn't JSON", async () => {
    const badGateway = () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    const save = (options: { env: typeof ENV; fetchImpl: typeof fetch }) =>
      createConvexWebReconnectBackend(ACTOR, options).saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
      });
    // The profile-key route is behind a proxy that fails.
    await expect(
      save({ env: ENV, fetchImpl: async () => badGateway() }),
    ).rejects.toThrow("HTTP 502");
    // The key is issued, then storage fails.
    const deployment = stubDeployment({
      "profile-key": profileKey(randomBytes(32)),
    });
    const storageDown: typeof fetch = async (input, init) =>
      String(input).endsWith("/upload")
        ? badGateway()
        : deployment.fetchImpl(input, init);
    await expect(save({ env: ENV, fetchImpl: storageDown })).rejects.toThrow(
      "The encrypted profile was not uploaded: HTTP 502.",
    );
  });

  it("passes other refusals and network failures on unchanged", async () => {
    const forbidden = stubDeployment({
      listWebReconnectRequests: new WebBackendRefusal("FORBIDDEN"),
    });
    const handback = (options: typeof forbidden.options) =>
      createWebRecoveryCoordinator({
        backend: createConvexWebReconnectBackend(ACTOR, options),
        ledger: createConvexLedgerReader(options),
        resumeRun: vi.fn(),
      }).handback({
        projectId: PROJECT,
        requestId: "request-1",
        browser: {
          verifyAccount: async () => SEAT,
          captureProfile: async () => PROFILE,
        },
      });
    await expect(handback(forbidden.options)).rejects.toMatchObject({
      name: "WebBackendRefusal",
      code: "FORBIDDEN",
    });
    const reset = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const offline = {
      env: ENV,
      fetchImpl: vi.fn<typeof fetch>(async () => Promise.reject(reset)),
    };
    await expect(handback(offline)).rejects.not.toBeInstanceOf(
      WebBackendRefusal,
    );
  });

  it("reads the durable ledger through findWebToolCalls", async () => {
    const entry = {
      id: "call-1",
      connectorId: "connector-1",
      runId: "run-1",
      turnId: "turn-1",
      jsonrpcId: "7",
      toolName: "create_note",
      argsHash: "a".repeat(64),
      state: "result",
      forwardedAt: "2026-11-20T10:00:01.000Z",
      upstreamStatus: 200,
    };
    const deployment = stubDeployment({ findWebToolCalls: [entry] });
    const ledger = createConvexLedgerReader(deployment.options);

    expect(
      await reconcileWithLedger(ledger, {
        runId: "run-1",
        connectorIds: ["connector-1"],
        step: STEP,
      }),
    ).toEqual({ status: "reconciled", calls: [entry] });
    expect(deployment.calls.map((call) => call.args.command)).toEqual([
      {
        action: "findWebToolCalls",
        connectorId: "connector-1",
        since: STEP.startedAt,
      },
      { action: "findWebToolCalls", turnId: "turn-1" },
    ]);
  });
});
