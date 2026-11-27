/**
 * Recovery's hosted setup: it acts as the run's person on the backend, reads
 * the ledger there, and hands an account back only from the sign-in browser
 * that same person opened for that same account. A hosted Inspector turns it
 * on at startup only when it has the backend service.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { PageDriver } from "../../../../utils/harness/real-ui/page-driver.js";
import type { WebClientService } from "../../backend-connector-resolver.js";
import type { WebClientHostedBrowser } from "../../hosted-browser.js";
import {
  forgetSignInBrowsers,
  keepSignInBrowser,
} from "../../sign-in-browsers.js";
import { mountWebClientRuntime } from "../../runtime-mount.js";
import { setWebClientEnvironment } from "../../web-client-environment.js";
import { createHostedWebRecovery } from "../hosted-recovery.js";
import {
  setWebRecovery,
  SignInBrowserAccountMismatchError,
  SignInBrowserNotNamedError,
  webRecovery,
} from "../turn-recovery.js";

const ADMIN = { actorExternalId: "user_admin" };
const OTHER = { actorExternalId: "user_other" };

function recordingService() {
  const commands: Array<Record<string, unknown>> = [];
  const answer = async (command: Record<string, unknown>) => {
    commands.push(command);
    return [];
  };
  const service: WebClientService = { read: answer, apply: answer };
  return { service, commands };
}

function signInBrowser(id: string): WebClientHostedBrowser {
  return {
    browserSessionId: id,
    chatSessionId: `chat-${id}`,
    driver: { kind: "hosted" } as unknown as PageDriver,
    exportProfile: async () => new TextEncoder().encode(`profile-${id}`),
    close: async () => {},
  };
}

afterEach(() => forgetSignInBrowsers());

describe("hosted recovery", () => {
  it("acts as the run's person, and runs without recovery when the turn names nobody", async () => {
    const { service, commands } = recordingService();
    const recovery = createHostedWebRecovery(service);
    expect(
      recovery.backendFor({ projectId: "project-1", runId: "run-1" }),
    ).toBeUndefined();
    const backend = recovery.backendFor({
      projectId: "project-1",
      runId: "run-1",
      actor: ADMIN,
    });
    await backend?.listWebReconnectRequests({ projectId: "project-1" });
    expect(commands).toEqual([
      { action: "listWebReconnectRequests", projectId: "project-1", ...ADMIN },
    ]);
  });

  it("reads the backend's ledger before anything is sent again", async () => {
    const { service, commands } = recordingService();
    await createHostedWebRecovery(service).ledger.forTurn("turn-1");
    expect(commands).toEqual([
      { action: "findWebToolCalls", turnId: "turn-1" },
    ]);
  });

  it("hands back from the person's own sign-in browser for the account", async () => {
    const { service } = recordingService();
    const recovery = createHostedWebRecovery(service);
    keepSignInBrowser({
      browser: signInBrowser("browser-1"),
      actor: ADMIN,
      projectId: "project-1",
      webAccountId: "web-account-1",
      close: async () => {},
    });
    const source = await recovery.handbackEnvironment?.({
      actor: ADMIN,
      projectId: "project-1",
      browserSessionId: "browser-1",
    });
    const opened = (await source?.openBrowser({
      webAccountId: "web-account-1",
      sites: ["https://claude.ai"],
    })) as unknown as {
      captureProfile(): Promise<Uint8Array>;
      close(): Promise<void>;
    };
    expect(new TextDecoder().decode(await opened.captureProfile())).toBe(
      "profile-browser-1",
    );
    await expect(
      source?.openBrowser({
        webAccountId: "web-account-2",
        sites: ["https://claude.ai"],
      }),
    ).rejects.toBeInstanceOf(SignInBrowserAccountMismatchError);
  });

  it("asks a hosted handback to name the sign-in browser it used", async () => {
    const { service } = recordingService();
    const recovery = createHostedWebRecovery(service);

    await expect(
      recovery.handbackEnvironment?.({ actor: ADMIN, projectId: "project-1" }),
    ).rejects.toBeInstanceOf(SignInBrowserNotNamedError);
  });

  it("finds no browser for another person, in another project, or under another id", async () => {
    const { service } = recordingService();
    const recovery = createHostedWebRecovery(service);
    keepSignInBrowser({
      browser: signInBrowser("browser-1"),
      actor: ADMIN,
      projectId: "project-1",
      webAccountId: "web-account-1",
      close: async () => {},
    });
    for (const handback of [
      { actor: OTHER, projectId: "project-1", browserSessionId: "browser-1" },
      {
        actor: { actorUserId: "user_admin" },
        projectId: "project-1",
        browserSessionId: "browser-1",
      },
      { actor: ADMIN, projectId: "project-2", browserSessionId: "browser-1" },
      { actor: ADMIN, projectId: "project-1", browserSessionId: "browser-9" },
    ]) {
      expect(
        await recovery.handbackEnvironment?.(handback),
        JSON.stringify(handback),
      ).toBeUndefined();
    }
  });
});

describe("a hosted Inspector's startup", () => {
  afterEach(() => {
    setWebRecovery(undefined);
    setWebClientEnvironment(undefined);
    vi.unstubAllEnvs();
  });

  it("turns recovery on with the backend service", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "fixture-service-token");
    vi.stubEnv("CONVEX_URL", "https://fixture-deployment-123.convex.cloud");
    mountWebClientRuntime(new Hono(), { hosted: true });
    expect(webRecovery()?.handbackEnvironment).toBeTypeOf("function");
  });

  it("leaves recovery off without the backend service", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    vi.stubEnv("CONVEX_URL", "");
    mountWebClientRuntime(new Hono(), { hosted: true });
    expect(webRecovery()).toBeUndefined();
  });
});
