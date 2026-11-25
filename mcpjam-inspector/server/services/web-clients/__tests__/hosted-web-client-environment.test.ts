/**
 * The hosted environment against a recorded backend: which account a run
 * uses, the connector it asks for, the profile it restores, and what it
 * reports when the run verified the account or stopped for sign-in.
 *
 * Evidence: fixture. The backend is a recording fake of `webClientService`
 * and `profile-for-run`; the browser is the fixture vendor in Chromium.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureUpstream } from "../../../test/support/web-clients/fixture-upstream";
import { startFixtureVendor } from "../../../test/support/web-clients/fixture-vendor";
import { startStandInEndpoint } from "../../../test/support/web-clients/stand-in-endpoint";
import { createFixtureWebPageModule } from "../../../utils/harness/real-ui/fixture-web";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import type { PageDriver } from "../../../utils/harness/real-ui/page-driver";
import type { WebClientService } from "../backend-connector-resolver";
import {
  createHostedWebClientEnvironment,
  createProfileForRunClient,
  type ProfileForRun,
} from "../hosted-web-client-environment";
import { runWebClientTurn } from "../run-web-client-turn";
import { createInMemoryToolCallLedger } from "../tool-call-ledger";
import { createInMemoryTurnWindowStore } from "../turn-windows";

const PROFILE: ProfileForRun = {
  webAccountId: "acct-default",
  profileVersion: 3,
  downloadUrl: "https://storage.example/profile",
  dataKey: "data-key",
  sizeBytes: 10,
  sha256: "a".repeat(64),
  savedAt: 1,
};
const ACCOUNTS = [
  { webAccountId: "acct-other", vendor: "claude", isDefault: false },
  { webAccountId: "acct-default", vendor: "claude", isDefault: true, accountEmail: "runner@example.com" },
  { webAccountId: "acct-gpt", vendor: "chatgpt", isDefault: true },
];

function recordedService(accounts = ACCOUNTS) {
  const calls: Array<{ kind: string; command: Record<string, unknown> }> = [];
  const answer = async (kind: string, command: Record<string, unknown>) => {
    calls.push({ kind, command });
    if (command.action === "listWebAccounts") return accounts;
    if (command.action === "ensureWebConnector") return { connectorId: `conn-${String(command.serverId)}` };
    if (command.action === "openWebTurnWindow") return { ok: true, window: {} };
    return null;
  };
  const service: WebClientService = {
    read: (command) => answer("read", command),
    apply: (command) => answer("apply", command),
  };
  return { service, calls };
}

function environment(
  service: WebClientService,
  overrides: Partial<Parameters<typeof createHostedWebClientEnvironment>[0]> = {},
) {
  return createHostedWebClientEnvironment({
    service,
    actor: { actorExternalId: "user_workos_1" },
    publicBaseUrl: "https://inspector.example",
    runId: "run-1",
    iterationId: "iteration-1",
    profileForRun: async () => PROFILE,
    openHostedBrowser: async () => {
      throw new Error("no browser in this test");
    },
    ...overrides,
  });
}

describe("the hosted environment's backend calls", () => {
  it("uses the run's frozen accounts, else the vendor's default, else its only one", async () => {
    const { service } = recordedService();
    expect(
      await environment(service, { runWebAccountIds: ["acct-removed", "acct-other"] }).resolveAccount({
        projectId: "p",
        vendor: "claude",
      }),
    ).toEqual({ webAccountId: "acct-other" });
    // A run whose frozen accounts are all gone, or are another vendor's, stops; it never moves to the default.
    for (const id of ["acct-removed", "acct-gpt"]) {
      await expect(
        environment(service, { runWebAccountIds: [id] }).resolveAccount({ projectId: "p", vendor: "claude" }),
      ).rejects.toThrow(
        "The Claude web accounts this run uses were removed from the project. Choose an account for the suite, then run again.",
      );
    }
    // A swarm's turn names no eval iteration, and a swarm has no suite.
    await expect(
      environment(service, {
        runWebAccountIds: ["acct-removed"],
        iterationId: undefined,
      }).resolveAccount({ projectId: "p", vendor: "claude" }),
    ).rejects.toThrow(
      "The Claude web accounts this run uses were removed from the project. Ask an admin to sign one in from the client's Browser settings, then run again.",
    );
    expect(await environment(service).resolveAccount({ projectId: "p", vendor: "claude" })).toEqual({
      webAccountId: "acct-default",
      accountEmail: "runner@example.com",
    });
    const only = recordedService([{ webAccountId: "acct-gpt", vendor: "chatgpt", isDefault: false }]);
    expect(await environment(only.service).resolveAccount({ projectId: "p", vendor: "chatgpt" })).toEqual({
      webAccountId: "acct-gpt",
    });
  });

  it("stops as needs_sign_in when the project has no account for the vendor", async () => {
    const { service } = recordedService([]);
    await expect(environment(service).resolveAccount({ projectId: "p", vendor: "chatgpt" })).rejects.toMatchObject({
      failure: { kind: "needs_sign_in", reason: "signed_out", message: expect.stringContaining("No ChatGPT web account") },
    });
  });

  it("asks for an OAuth connector as the run's person", async () => {
    const { service, calls } = recordedService();
    expect(
      await environment(service).ensureConnector({ projectId: "p", webAccountId: "a", serverId: "orders", auth: "capability" }),
    ).toEqual({ connectorId: "conn-orders" });
    expect(calls.at(-1)).toEqual({
      kind: "apply",
      command: {
        action: "ensureWebConnector",
        projectId: "p",
        webAccountId: "a",
        serverId: "orders",
        auth: "oauth",
        actorExternalId: "user_workos_1",
      },
    });
  });

  it("fetches the run's profile with the service token and refuses quietly when it can't", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-inspector-service-token")).toBe("service-token");
      return new Response(JSON.stringify(PROFILE));
    });
    const client = createProfileForRunClient({ convexHttpUrl: "https://backend.example", serviceToken: "service-token", fetchImpl });
    expect(await client({ actor: { actorUserId: "u1" }, webAccountId: "acct-default", runId: "run-1", venue: "hosted" })).toEqual(PROFILE);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      actorUserId: "u1",
      webAccountId: "acct-default",
      runId: "run-1",
      venue: "hosted",
    });
    const refusing = createProfileForRunClient({
      convexHttpUrl: "https://backend.example",
      serviceToken: "service-token",
      fetchImpl: async () => Response.json({ error: { code: "WEB_ACCOUNT_NEEDS_SIGN_IN" } }, { status: 409 }),
    });
    await expect(
      refusing({ actor: { actorUserId: "u1" }, webAccountId: "a", runId: "r", venue: "hosted" }),
    ).rejects.toMatchObject({ failure: { kind: "needs_sign_in" } });
  });

  it("fails the run and leaves the account alone when the profile service fails", async () => {
    const answers: Array<[number, string]> = [
      [503, "Service Unavailable"],
      [500, JSON.stringify({ error: { code: "ERROR" } })],
      [401, JSON.stringify({ error: { code: "UNAUTHORIZED" } })],
      [403, JSON.stringify({ error: { code: "FORBIDDEN" } })],
    ];
    for (const [status, body] of answers) {
      const { service, calls } = recordedService();
      const result = await runWebClientTurn({
        runtimeId: "claude-web",
        projectId: "project-1",
        serverIds: ["orders"],
        prompt: "say hello",
        runId: "run-1",
        approval: { requireToolApproval: false, answer: "deny" },
        environment: environment(service, {
          profileForRun: createProfileForRunClient({
            convexHttpUrl: "https://backend.example",
            serviceToken: "service-token",
            fetchImpl: async () => new Response(body, { status }),
          }),
        }),
        turnWindows: createInMemoryTurnWindowStore(),
        ledger: createInMemoryToolCallLedger(),
      });
      expect(result).toMatchObject({ ok: false, infrastructure: true, failure: { kind: "driver", step: "sign_in_check" } });
      // Nothing marks the account as needing sign-in.
      expect(calls.map((call) => call.command.action)).toEqual([
        "listWebAccounts",
        "ensureWebConnector",
        "openWebTurnWindow",
        "closeWebTurnWindow",
      ]);
    }
  });
});

describe("a hosted turn's outcome on the account", { timeout: 90_000 }, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  async function hostedTurn(challenge: boolean) {
    const vendor = await startFixtureVendor();
    const upstream = await startFixtureUpstream();
    const windows = createInMemoryTurnWindowStore();
    const ledger = createInMemoryToolCallLedger();
    const endpoint = await startStandInEndpoint({ upstreamOf: () => upstream.url, windows, ledger });
    const { service, calls } = recordedService();
    const restored: ProfileForRun[] = [];
    vendor.challenge = challenge;
    try {
      const result = await runWebClientTurn({
        runtimeId: "claude-web",
        projectId: "project-1",
        serverIds: ["orders"],
        prompt: "say hello",
        runId: "run-1",
        approval: { requireToolApproval: false, answer: "deny" },
        environment: {
          ...environment(service, {
            publicBaseUrl: endpoint.url,
            openHostedBrowser: async ({ profile, sites }) => {
              restored.push(profile);
              const context = await browser.newContext();
              const page = await context.newPage();
              await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
              return { driver: await createPlaywrightDriver(page, { sites }), close: () => context.close() };
            },
          }),
          pageModule: createFixtureWebPageModule(vendor.url),
        },
        turnWindows: windows,
        ledger,
        stepTimeoutMs: 10_000,
        replyTimeoutMs: 20_000,
      });
      return { result, calls, restored, upstream };
    } finally {
      await endpoint.close();
      await vendor.close();
      await upstream.close();
    }
  }

  it("restores the saved profile and marks the account verified after a run", async () => {
    const { result, calls, restored } = await hostedTurn(false);
    expect(result.ok).toBe(true);
    expect(restored).toEqual([PROFILE]);
    expect(calls.map((call) => call.command.action)).toEqual([
      "listWebAccounts",
      "ensureWebConnector",
      "openWebTurnWindow",
      "closeWebTurnWindow",
      "markWebAccountVerified",
    ]);
    const opened = calls.find((call) => call.command.action === "openWebTurnWindow")!.command;
    expect(opened).toMatchObject({ connectorId: "conn-orders", runId: "run-1", turnId: result.turnId });
    expect(calls.at(-1)!.command).toMatchObject({
      webAccountId: "acct-default",
      accountEmail: "runner@example.com",
      workspaceName: "Fixture workspace",
    });
  });

  it("tells recovery which profile version the account's browser restored", async () => {
    const { service } = recordedService();
    const env = environment(service, {
      openHostedBrowser: async () => ({ driver: {} as PageDriver, close: async () => {} }),
    });
    expect(env.restoredProfileVersion?.("acct-default")).toBeUndefined();
    await env.openBrowser({ webAccountId: "acct-default", sites: [] });
    expect(env.restoredProfileVersion?.("acct-default")).toBe(3);
  });

  it("marks the account as needing sign-in and reports the pending step", async () => {
    const { result, calls } = await hostedTurn(true);
    expect(result).toMatchObject({ ok: false, failure: { kind: "needs_sign_in", reason: "human_check" } });
    expect(calls.map((call) => call.command.action)).toEqual([
      "listWebAccounts",
      "ensureWebConnector",
      "openWebTurnWindow",
      "closeWebTurnWindow",
      "markWebAccountNeedsSignIn",
      "reportWebSignInRequired",
    ]);
    const report = calls.at(-1)!.command;
    expect(report).toMatchObject({ webAccountId: "acct-default", runId: "run-1", iterationId: "iteration-1", reason: "human_check" });
    expect(JSON.parse(String(report.pendingStep))).toMatchObject({ stepId: "sign_in_check" });
    // Both name the profile the run restored, so an account signed in again since stays as it is.
    expect(calls.slice(-2).map((call) => call.command.restoredProfileVersion)).toEqual([3, 3]);
  });
});
