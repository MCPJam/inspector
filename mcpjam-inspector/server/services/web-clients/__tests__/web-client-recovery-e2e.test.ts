/**
 * Recovery end to end, with the real forwarding endpoint: a harness turn
 * drives the fixture vendor's page in a real browser, the vendor's own MCP
 * client dials `/mcp/<connectorId>`, and the test counts what the upstream
 * server actually received.
 *
 * Evidence: fixture (local test doubles), no live vendor.
 *
 *  - A lost result: the tool runs and the server answers, then the page asks
 *    for a password before the reply is read. The run pauses, its send record
 *    is lost, a person hands the account back, and the turn resumes. The
 *    ledger keeps it from sending the prompt again: the server got one call.
 *  - The same loss in an eval iteration, which has no stream: it waits in
 *    place, and runs on after the handback with still one call.
 *  - An ambiguous call: the server takes the call and never answers, and the
 *    reply times out. The ledger shows a call with no answer, so the step
 *    stops and says it may have run: still one call.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  startFixtureVendor,
  type FixtureVendor,
} from "../../../test/support/web-clients/fixture-vendor";
import {
  createMemorySendJournal,
  type SendJournal,
} from "../../../utils/harness/real-ui/drive-turn";
import { createFixtureWebPageModule } from "../../../utils/harness/real-ui/fixture-web";
import type { PageDriver } from "../../../utils/harness/real-ui/page-driver";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import { runHarnessTurn } from "../../../utils/harness/run-harness-turn";
import { createStaticConnectorResolver } from "../connectors";
import { createWebConnectorEndpoint } from "../forwarding-endpoint";
import { accountBrowserOver } from "../recovery/account-browser";
import { createWebRecoveryCoordinator } from "../recovery/coordinator";
import { createInMemoryWebReconnectBackend } from "../recovery/in-memory-backend";
import { resumeWebRun } from "../recovery/paused-runs";
import { setWebRecovery } from "../recovery/turn-recovery";
import { webClientToolCallLedger } from "../tool-call-ledger";
import { webClientTurnWindows } from "../turn-windows";
import {
  setWebClientEnvironment,
  type WebClientEnvironment,
} from "../web-client-environment";
import { WebClientRunError } from "../web-client-harness-turn";

const PROJECT = "project-1";
const ACCOUNT = "account-1";
const CONNECTOR_ID = "conn-recovery-0123456789abcdef";
const SEAT = { email: "runner@example.com", workspace: "Fixture workspace" };

/** An MCP server that counts what it receives, and can take a call and never answer. */
async function startCountingUpstream() {
  const received: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  const held: ServerResponse[] = [];
  const state = { holdToolCalls: false };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    received.push({ method: body.method, params: body.params });
    if (body.id === undefined) return void response.writeHead(202).end();
    // The tool ran; its answer never leaves the server.
    if (body.method === "tools/call" && state.holdToolCalls)
      return void held.push(response);
    const message = (body.params?.arguments as { message?: string } | undefined)
      ?.message;
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "counting-upstream", version: "1.0.0" },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "echo",
                  inputSchema: {
                    type: "object",
                    properties: { message: { type: "string" } },
                  },
                },
              ],
            }
          : { content: [{ type: "text", text: `echo: ${String(message)}` }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    state,
    toolCalls: () => received.filter((r) => r.method === "tools/call"),
    reset: () => {
      received.length = 0;
      state.holdToolCalls = false;
    },
    release: () => held.splice(0).forEach((response) => response.destroy()),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What the run's first browser does to the page, armed per test. */
const interruption = { passwordAfterCall: false, shortReply: false };

function interrupting(
  driver: PageDriver,
  toolCalls: () => unknown[],
): PageDriver {
  return {
    ...driver,
    // The vendor asks for the password after the tool has already run.
    async readText(selector) {
      if (
        interruption.passwordAfterCall &&
        selector === 'input[type="password"]' &&
        toolCalls().length > 0
      ) {
        return "";
      }
      return driver.readText(selector);
    },
    async waitFor(condition, options) {
      const short =
        interruption.shortReply && options.what === "the reply to finish";
      return driver.waitFor(
        condition,
        short ? { ...options, timeoutMs: 2_500 } : options,
      );
    },
  };
}

describe(
  "web client recovery through the real forwarding endpoint",
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let vendor: FixtureVendor;
    let upstream: Awaited<ReturnType<typeof startCountingUpstream>>;
    let server: ServerType;
    let journal: SendJournal;
    let environment: WebClientEnvironment;
    let backend: ReturnType<typeof createInMemoryWebReconnectBackend>;
    let opened = 0;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      vendor = await startFixtureVendor();
      upstream = await startCountingUpstream();
      const app = createWebConnectorEndpoint({
        resolver: createStaticConnectorResolver([
          {
            connector: {
              connectorId: CONNECTOR_ID,
              projectId: PROJECT,
              serverId: "orders",
              auth: "capability",
              vendor: "claude",
            },
            upstream: { url: upstream.url, headers: {} },
          },
        ]),
        turns: webClientTurnWindows,
        ledger: webClientToolCallLedger,
        isEnabled: async () => true,
        fetchUpstream: fetch,
      });
      server = await new Promise<ServerType>((resolve) => {
        const started = serve(
          { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
          () => resolve(started),
        );
      });
      environment = {
        publicBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        get journal() {
          return journal;
        },
        pageModule: createFixtureWebPageModule(vendor.url),
        async resolveAccount() {
          return { webAccountId: ACCOUNT, accountEmail: SEAT.email };
        },
        async ensureConnector() {
          return { connectorId: CONNECTOR_ID };
        },
        async openBrowser({ sites }) {
          const first = (opened += 1) === 1;
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(`${vendor.url}/sign-in?as=${SEAT.email}`);
          const driver = await createPlaywrightDriver(page, { sites });
          // A browser that can save its profile offers `captureProfile`.
          const handle = {
            driver: first ? interrupting(driver, upstream.toolCalls) : driver,
            close: () => context.close(),
            captureProfile: async () =>
              Buffer.from(JSON.stringify(await context.storageState())),
          };
          return handle;
        },
      };
      setWebClientEnvironment(environment);
    });

    beforeEach(() => {
      upstream.reset();
      vendor.sends.length = 0;
      journal = createMemorySendJournal();
      opened = 0;
      interruption.passwordAfterCall = false;
      interruption.shortReply = false;
      backend = createInMemoryWebReconnectBackend([
        {
          webAccountId: ACCOUNT,
          projectId: PROJECT,
          vendor: "claude",
          status: "ready",
          accountEmail: SEAT.email,
          workspaceName: SEAT.workspace,
          profileVersion: 1,
        },
      ]);
      setWebRecovery({
        backendFor: () => backend,
        ledger: webClientToolCallLedger,
        maxPauseMs: 60_000,
        pollMs: 200,
      });
    });

    afterAll(async () => {
      setWebRecovery(undefined);
      setWebClientEnvironment(undefined);
      upstream.release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vendor.close();
      await upstream.close();
      await browser.close();
    });

    /** A person signed the account in again: hand it back as they would. */
    async function handBack(requestId: string) {
      let handbackBrowser: ReturnType<typeof accountBrowserOver> | undefined;
      try {
        return await createWebRecoveryCoordinator({
          backend,
          ledger: webClientToolCallLedger,
          resumeRun: resumeWebRun,
        }).handback({
          projectId: PROJECT,
          requestId,
          browserFor: (account) =>
            (handbackBrowser = accountBrowserOver(environment, {
              webAccountId: account.webAccountId,
              vendor: "claude",
            })),
        });
      } finally {
        await handbackBrowser?.close();
      }
    }

    const turnOptions = (prompt: string, run: Record<string, string>) => ({
      messages: [{ role: "user" as const, content: prompt }],
      modelId: "anthropic/claude-sonnet-4.5",
      systemPrompt: "",
      tools: {},
      mcpClientManager: new MCPClientManager(),
      harness: "claude-web" as const,
      projectId: PROJECT,
      selectedServers: ["orders"],
      ...run,
    });

    it("resumes a paused Playground turn from the ledger, and the server runs the tool once", async () => {
      interruption.passwordAfterCall = true;
      const result = await runHarnessTurn(
        {
          ...turnOptions("lost reply", {
            chatSessionId: "chat-recovery-1",
            sourceType: "playground",
          }),
          heartbeatIntervalMs: 20,
        },
        "ui",
      );
      const reader = result.response!.body!.getReader();
      let streamed = "";
      const readUntil = async (pattern: RegExp) => {
        while (!pattern.test(streamed)) {
          const { done, value } = await reader.read();
          if (done) break;
          streamed += new TextDecoder().decode(value);
        }
      };

      // The surface gets a typed pause it can show: the request and the reason.
      await readUntil(/data-web-run-paused/);
      const paused = JSON.parse(
        /data: (\{"type":"data-web-run-paused".*\})/.exec(streamed)?.[1] ??
          "{}",
      ) as {
        data: {
          requestId: string;
          reason: string;
          step: string;
          clientName: string;
        };
      };
      expect(paused.data).toMatchObject({
        reason: "password",
        step: "reply",
        clientName: "Claude web",
      });
      expect(upstream.toolCalls()).toHaveLength(1);
      await readUntil(/"type":"heartbeat"/);
      expect(streamed).toContain('"type":"heartbeat"');
      const [request] = await backend.listWebReconnectRequests({
        projectId: PROJECT,
      });
      expect(request).toMatchObject({
        requestId: paused.data.requestId,
        status: "open",
      });

      // The send record does not survive the pause; only the ledger knows.
      journal = createMemorySendJournal();
      const handback = await handBack(paused.data.requestId);
      expect(handback).toMatchObject({
        status: "resumed",
        runs: [
          expect.objectContaining({
            runId: "chat-recovery-1",
            status: "resumed",
          }),
        ],
      });

      await readUntil(/echo said: echo: lost reply/);
      expect(streamed).toMatch(/echo said: echo: lost reply/);
      // What the server and the vendor actually received: one call, one prompt.
      expect(upstream.toolCalls()).toHaveLength(1);
      expect(upstream.toolCalls()[0]?.params).toMatchObject({
        arguments: { message: "lost reply" },
      });
      expect(vendor.sends).toEqual(["lost reply"]);
      expect(await backend.listWebAccounts({ projectId: PROJECT })).toEqual([
        expect.objectContaining({ status: "ready", profileVersion: 2 }),
      ]);
      await reader.cancel();
    });

    it("holds a paused eval iteration in place and runs it on after the handback, with one call", async () => {
      interruption.passwordAfterCall = true;
      const settled = runHarnessTurn(
        turnOptions("lost eval reply", {
          evalIterationId: "iteration-recovery-2",
          sourceType: "eval",
        }),
        "none",
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      // An eval iteration streams nothing: its open request shows the pause.
      const request = await vi.waitFor(
        async () => {
          const [open] = await backend.listWebReconnectRequests({
            projectId: PROJECT,
          });
          if (open?.status !== "open") throw new Error("not paused yet");
          return open;
        },
        { timeout: 60_000, interval: 100 },
      );
      expect(upstream.toolCalls()).toHaveLength(1);

      journal = createMemorySendJournal();
      expect(await handBack(request.requestId)).toMatchObject({
        status: "resumed",
        runs: [
          expect.objectContaining({
            runId: "iteration-recovery-2",
            status: "resumed",
          }),
        ],
      });

      const outcome = await settled;
      if ("error" in outcome) throw outcome.error;
      expect(outcome.result.messageHistory.at(-1)).toMatchObject({
        role: "assistant",
        content: expect.arrayContaining([
          { type: "text", text: "echo said: echo: lost eval reply" },
        ]),
      });
      expect(upstream.toolCalls()).toHaveLength(1);
      expect(vendor.sends).toEqual(["lost eval reply"]);
    });

    it("reloads instead of pausing when the account was signed in again since the run restored it", async () => {
      interruption.passwordAfterCall = true;
      // The run restored version 1; a person has signed in again since (version 2).
      environment.restoredProfileVersion = () => 1;
      await backend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion: 1,
        profile: new Uint8Array(),
      });
      // A pause would hold the iteration; fail fast instead of waiting it out.
      setWebRecovery({
        backendFor: () => backend,
        ledger: webClientToolCallLedger,
        maxPauseMs: 3_000,
        pollMs: 200,
      });
      try {
        const result = await runHarnessTurn(
          turnOptions("signed in since", {
            evalIterationId: "iteration-recovery-reload",
            sourceType: "eval",
          }),
          "none",
        );
        expect(result.messageHistory.at(-1)).toMatchObject({
          role: "assistant",
          content: expect.arrayContaining([
            { type: "text", text: "echo said: echo: signed in since" },
          ]),
        });
        // Nobody was asked to sign in, and the server still got one call.
        expect(
          await backend.listWebReconnectRequests({ projectId: PROJECT }),
        ).toEqual([]);
        expect(upstream.toolCalls()).toHaveLength(1);
        expect(vendor.sends).toEqual(["signed in since"]);
      } finally {
        delete environment.restoredProfileVersion;
      }
    });

    it("stops an eval iteration as ambiguous when the server never answered, without calling it again", async () => {
      upstream.state.holdToolCalls = true;
      interruption.shortReply = true;
      const stopped = await runHarnessTurn(
        turnOptions("held call", {
          evalIterationId: "iteration-recovery-1",
          sourceType: "eval",
        }),
        "none",
      ).catch((error: unknown) => error);

      expect(stopped).toBeInstanceOf(WebClientRunError);
      const error = stopped as WebClientRunError;
      expect(error.failure.kind).toBe("reply_timeout");
      expect(error.stop).toEqual({
        kind: "ambiguous_execution",
        calls: [expect.objectContaining({ toolName: "echo" })],
      });
      expect(error.message).toMatch(
        /A call to echo reached the server, but no answer came back, so it may have run\. MCPJam didn't send it again\./,
      );
      expect(upstream.toolCalls()).toHaveLength(1);
      expect(vendor.sends).toEqual(["held call"]);
      // A browser that failed never asks for a sign-in.
      expect(
        await backend.listWebReconnectRequests({ projectId: PROJECT }),
      ).toEqual([]);
      upstream.release();
    });
  },
);
