/**
 * The reconnect backend over the process's one backend service client,
 * against stubs: a `WebClientService` that answers each command as the
 * backend's `webClientService:read` and `:apply` would (refusals are real
 * `ConvexError`s), and a fetch that answers as the profile-key route and
 * storage would. Checks what is sent and how refusals become outcomes.
 */
import { randomBytes } from "node:crypto";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { WebClientService } from "../../backend-connector-resolver.js";
import { WebBackendRefusal, type PendingStep } from "../backend.js";
import {
  createConvexLedgerReader,
  createConvexWebReconnectBackend,
  type ProfileKeyRoute,
} from "../convex-backend.js";
import { createWebRecoveryCoordinator } from "../coordinator.js";
import { openWebProfile } from "../profile-cipher.js";
import { reconcileWithLedger } from "../reconcile.js";

const ACTOR = { actorExternalId: "user_fixture" };
const PROJECT = "project-1";
const ACCOUNT = "web-account-1";
const SEAT = {
  accountEmail: "seat@example.com",
  workspaceName: "Test workspace",
};
const PROFILE = new TextEncoder().encode("fixture-profile");
const SERVICE_TOKEN = "fixture-service-token";
const STEP: PendingStep = {
  stepId: "send",
  startedAt: "2026-11-20T10:00:00.000Z",
  turnId: "turn-1",
};

type Answer = unknown;

/** The shared service client, answering each action from `answers`. */
function stubService(answers: Record<string, Answer>) {
  const calls: Array<{
    via: "read" | "apply";
    command: Record<string, unknown>;
  }> = [];
  const answer =
    (via: "read" | "apply") =>
    async (command: Record<string, unknown>): Promise<unknown> => {
      calls.push({ via, command });
      const value = answers[String(command.action)];
      if (value instanceof WebBackendRefusal) {
        throw new ConvexError({ code: value.code, message: value.message });
      }
      return value ?? null;
    };
  const service: WebClientService = {
    read: answer("read"),
    apply: answer("apply"),
  };
  return { calls, service };
}

/** The profile-key route and storage upload, answering from `key`. */
function stubRoute(key: Answer) {
  const sent: Array<{ to: string; headers: Headers; body: Uint8Array }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const to = String(input).endsWith("/profile-key")
      ? "profile-key"
      : "upload";
    const body = new Uint8Array(
      typeof init?.body === "string"
        ? new TextEncoder().encode(init.body)
        : (init?.body as Uint8Array),
    );
    sent.push({ to, headers: new Headers(init?.headers), body });
    if (to === "upload") return Response.json({ storageId: "storage-1" });
    if (key instanceof WebBackendRefusal) {
      return Response.json({ error: { code: key.code } }, { status: 409 });
    }
    return Response.json(key);
  };
  const route: ProfileKeyRoute = {
    convexHttpUrl: "https://routes.example.test",
    serviceToken: SERVICE_TOKEN,
    fetchImpl,
  };
  return { sent, route };
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
  vendor: "claude",
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
  it("sends each command through the shared service as the actor", async () => {
    const { calls, service } = stubService({
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
    const backend = createConvexWebReconnectBackend(ACTOR, {
      service,
      route: stubRoute(null).route,
    });

    // Only the fields recovery reads come back.
    expect(await backend.listWebAccounts({ projectId: PROJECT })).toEqual([
      {
        webAccountId: ACCOUNT,
        projectId: PROJECT,
        vendor: "claude",
        status: "needs_sign_in",
        ...SEAT,
        profileVersion: 3,
      },
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

    expect(
      calls.map(({ via, command }) => `${via} ${String(command.action)}`),
    ).toEqual([
      "read listWebAccounts",
      "read listWebReconnectRequests",
      "apply reportWebSignInRequired",
      "apply markWebAccountNeedsSignIn",
      "apply handbackWebReconnect",
      "apply claimResumableWebRuns",
    ]);
    for (const { command } of calls) {
      expect(command).toMatchObject(ACTOR);
      // Convex refuses an undefined field, so none is sent.
      expect(Object.values(command)).not.toContain(undefined);
    }
    expect(calls[2]?.command).toEqual({
      action: "reportWebSignInRequired",
      ...ACTOR,
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep: JSON.stringify(STEP),
      reason: "signed_out",
    });
  });

  it("passes on the backend's answer that the account was signed in again since the run's restore", async () => {
    const { calls, service } = stubService({ reportWebSignInRequired: { reloadProfile: true } });
    const backend = createConvexWebReconnectBackend(ACTOR, { service, route: stubRoute(null).route });
    expect(
      await backend.reportWebSignInRequired({
        webAccountId: ACCOUNT,
        runId: "run-1",
        pendingStep: STEP,
        reason: "signed_out",
        restoredProfileVersion: 2,
      }),
    ).toEqual({ reloadProfile: true });
    expect(calls[0]?.command).toMatchObject({ action: "reportWebSignInRequired", restoredProfileVersion: 2 });
  });

  it("saves a profile as ciphertext under the key the backend issued", async () => {
    const dataKey = randomBytes(32);
    const { calls, service } = stubService({
      saveWebAccountProfile: { ok: true, profileVersion: 4 },
    });
    const { sent, route } = stubRoute(profileKey(dataKey));
    const backend = createConvexWebReconnectBackend(ACTOR, { service, route });

    expect(
      await backend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
        savedFromRunId: "run-1",
      }),
    ).toEqual({ ok: true, profileVersion: 4 });
    const [key, upload] = sent;
    expect(JSON.parse(new TextDecoder().decode(key?.body))).toEqual({
      ...ACTOR,
      webAccountId: ACCOUNT,
    });
    expect(key?.headers.get("x-inspector-service-token")).toBe(SERVICE_TOKEN);
    const sealed = upload?.body ?? new Uint8Array();
    expect(Buffer.from(sealed).includes(Buffer.from(PROFILE))).toBe(false);
    expect(openWebProfile(sealed, dataKey)).toEqual(Buffer.from(PROFILE));
    const tampered = Uint8Array.from(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => openWebProfile(tampered, dataKey)).toThrow();
    expect(() => openWebProfile(sealed, randomBytes(32))).toThrow();
    expect(calls).toEqual([
      {
        via: "apply",
        command: {
          action: "saveWebAccountProfile",
          ...ACTOR,
          webAccountId: ACCOUNT,
          expectedProfileVersion: 3,
          storageId: "storage-1",
          wrappedKey: "sealed-key",
          savedFromRunId: "run-1",
        },
      },
    ]);

    // A key issued for a newer version means another save landed first.
    const stale = stubRoute(profileKey(dataKey, 4));
    const staleService = stubService({});
    expect(
      await createConvexWebReconnectBackend(ACTOR, {
        service: staleService.service,
        route: stale.route,
      }).saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
      }),
    ).toEqual({ ok: false, reason: "version_conflict", profileVersion: 4 });
    expect(stale.sent.map((call) => call.to)).toEqual(["profile-key"]);
    expect(staleService.calls).toEqual([]);
  });

  it.each([
    // The request reads cancelled after the conflict: it was cancelled meanwhile.
    ["CONFLICT", "handbackWebReconnect", "cancelled"],
    ["NOT_FOUND", "handbackWebReconnect", "not_found"],
    ["WEB_ACCOUNT_NEEDS_SIGN_IN", "profile-key", "not_signed_in"],
    ["NOT_FOUND", "listWebReconnectRequests", "not_found"],
  ])(
    "answers a handback refused with %s from %s as %s",
    async (code, refusedBy, outcome) => {
      const refusal = new WebBackendRefusal(code);
      let reads = 0;
      const { service } = stubService({
        // Open when the handback reads it, cancelled on any read after that.
        get listWebReconnectRequests() {
          reads += 1;
          return [
            reads === 1
              ? OPEN_REQUEST
              : { ...OPEN_REQUEST, status: "cancelled" },
          ];
        },
        listWebAccounts: [ACCOUNT_VIEW],
        saveWebAccountProfile: { ok: true, profileVersion: 4 },
        handbackWebReconnect: { status: "resolved", resumableRunIds: [] },
        claimResumableWebRuns: [],
        ...(refusedBy === "profile-key" ? {} : { [refusedBy]: refusal }),
      });
      const key =
        refusedBy === "profile-key" ? refusal : profileKey(randomBytes(32));
      const coordinator = createWebRecoveryCoordinator({
        backend: createConvexWebReconnectBackend(ACTOR, {
          service,
          route: stubRoute(key).route,
        }),
        ledger: createConvexLedgerReader(service),
        resumeRun: vi.fn(),
      });

      expect(
        await coordinator.handback({
          projectId: PROJECT,
          requestId: "request-1",
          browserFor: () => ({
            verifyAccount: async () => SEAT,
            captureProfile: async () => PROFILE,
          }),
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
    const save = (fetchImpl: typeof fetch) =>
      createConvexWebReconnectBackend(ACTOR, {
        service: stubService({}).service,
        route: {
          convexHttpUrl: "https://routes.example.test",
          serviceToken: SERVICE_TOKEN,
          fetchImpl,
        },
      }).saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 3,
        profile: PROFILE,
      });
    // The profile-key route is behind a proxy that fails.
    await expect(save(async () => badGateway())).rejects.toThrow("HTTP 502");
    // The key is issued, then storage fails.
    const issued =
      stubRoute(profileKey(randomBytes(32))).route.fetchImpl ?? fetch;
    const storageDown: typeof fetch = async (input, init) =>
      String(input).endsWith("/upload") ? badGateway() : issued(input, init);
    await expect(save(storageDown)).rejects.toThrow(
      "The encrypted profile was not uploaded: HTTP 502.",
    );
  });

  it("passes other refusals and network failures on unchanged", async () => {
    const handback = (service: WebClientService) =>
      createWebRecoveryCoordinator({
        backend: createConvexWebReconnectBackend(ACTOR, {
          service,
          route: stubRoute(null).route,
        }),
        ledger: createConvexLedgerReader(service),
        resumeRun: vi.fn(),
      }).handback({
        projectId: PROJECT,
        requestId: "request-1",
        browserFor: () => ({
          verifyAccount: async () => SEAT,
          captureProfile: async () => PROFILE,
        }),
      });
    const forbidden = stubService({
      listWebReconnectRequests: new WebBackendRefusal("FORBIDDEN"),
    });
    await expect(handback(forbidden.service)).rejects.toMatchObject({
      name: "WebBackendRefusal",
      code: "FORBIDDEN",
    });
    const reset = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const offline: WebClientService = {
      read: async () => Promise.reject(reset),
      apply: async () => Promise.reject(reset),
    };
    await expect(handback(offline)).rejects.toBe(reset);
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
    const { calls, service } = stubService({ findWebToolCalls: [entry] });
    const ledger = createConvexLedgerReader(service);

    expect(
      await reconcileWithLedger(ledger, {
        runId: "run-1",
        connectorIds: ["connector-1"],
        step: STEP,
      }),
    ).toEqual({ status: "reconciled", calls: [entry] });
    // Without connector ids only the step's own turn is read.
    expect(
      await reconcileWithLedger(ledger, { runId: "run-1", step: STEP }),
    ).toEqual({
      status: "reconciled",
      calls: [entry],
    });
    expect(calls.map(({ via, command }) => [via, command])).toEqual([
      [
        "read",
        {
          action: "findWebToolCalls",
          connectorId: "connector-1",
          since: STEP.startedAt,
        },
      ],
      ["read", { action: "findWebToolCalls", turnId: "turn-1" }],
      ["read", { action: "findWebToolCalls", turnId: "turn-1" }],
    ]);
  });
});
