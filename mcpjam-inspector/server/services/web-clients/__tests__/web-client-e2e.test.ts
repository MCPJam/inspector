/**
 * End to end, with the real forwarding endpoint: a harness turn drives the
 * fixture vendor's page, the vendor's own backend (an MCP client, as
 * claude.ai's is) dials `/mcp/<connectorId>` on the endpoint, and the test
 * asserts what the fixture upstream server actually received.
 *
 * Evidence: fixture (local test doubles), no live vendor.
 *
 * Skipped only in a checkout without `forwarding-endpoint.ts`. Set
 * MCPJAM_WEB_E2E_EVIDENCE to a file path to keep what the server received.
 */
import { existsSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { MCPClientManager } from "@mcpjam/sdk";
import { startFixtureUpstream, type FixtureUpstream } from "../../../test/support/web-clients/fixture-upstream";
import { startFixtureVendor, type FixtureVendor } from "../../../test/support/web-clients/fixture-vendor";
import { createMemorySendJournal } from "../../../utils/harness/real-ui/drive-turn";
import { createFixtureWebPageModule } from "../../../utils/harness/real-ui/fixture-web";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import { runHarnessTurn } from "../../../utils/harness/run-harness-turn";
import { createStaticConnectorResolver } from "../connectors";
import { webClientToolCallLedger } from "../tool-call-ledger";
import { webClientTurnWindows } from "../turn-windows";
import { setWebClientEnvironment } from "../web-client-environment";

const ENDPOINT_MERGED = existsSync(new URL("../forwarding-endpoint.ts", import.meta.url));
const CONNECTOR_ID = "conn-e2e-orders-0123456789abcdef";
const UPSTREAM_CREDENTIAL = "Bearer upstream-credential";

describe.skipIf(!ENDPOINT_MERGED)(
  "a web client turn through the real forwarding endpoint (skipped until forwarding-endpoint.ts is merged)",
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let vendor: FixtureVendor;
    let upstream: FixtureUpstream;
    let server: ServerType;
    let endpointUrl: string;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      vendor = await startFixtureVendor();
      upstream = await startFixtureUpstream();
      const { createWebConnectorEndpoint } = await import("../forwarding-endpoint");
      const app = createWebConnectorEndpoint({
        resolver: createStaticConnectorResolver([
          {
            connector: {
              connectorId: CONNECTOR_ID,
              projectId: "project-1",
              serverId: "orders",
              auth: "capability",
              vendor: "claude",
            },
            upstream: { url: upstream.url, headers: { authorization: UPSTREAM_CREDENTIAL } },
          },
        ]),
        turns: webClientTurnWindows,
        ledger: webClientToolCallLedger,
        isEnabled: async () => true,
        fetchUpstream: fetch,
      });
      server = await new Promise<ServerType>((resolve) => {
        const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
          resolve(started),
        );
      });
      endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      setWebClientEnvironment({
        publicBaseUrl: endpointUrl,
        journal: createMemorySendJournal(),
        pageModule: createFixtureWebPageModule(vendor.url),
        async resolveAccount() {
          return { webAccountId: "account-1", accountEmail: "runner@example.com" };
        },
        async ensureConnector() {
          return { connectorId: CONNECTOR_ID };
        },
        async openBrowser({ sites }) {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
          return { driver: await createPlaywrightDriver(page, { sites }), close: () => context.close() };
        },
      });
    });

    afterAll(async () => {
      setWebClientEnvironment(undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vendor.close();
      await upstream.close();
      await browser.close();
    });

    it("forwards the vendor's own call to the server, with its tool use id and the project's credential", async () => {
      const result = await runHarnessTurn(
        {
          messages: [{ role: "user", content: "say hello" }],
          modelId: "anthropic/claude-sonnet-4.5",
          systemPrompt: "",
          tools: {},
          mcpClientManager: new MCPClientManager(),
          harness: "claude-web",
          projectId: "project-1",
          selectedServers: ["orders"],
          sourceType: "eval",
          evalIterationId: "iteration-e2e",
        },
        "none",
      );

      // What the server received is the vendor's own client, passed through.
      const initialize = upstream.received.find((r) => r.method === "initialize");
      expect(initialize?.params?.clientInfo).toMatchObject({ name: "fixture-vendor" });
      const calls = upstream.received.filter((r) => r.method === "tools/call");
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call!.params).toMatchObject({ name: "echo", arguments: { message: "say hello" } });
      const toolUseId = (call!.params?._meta as Record<string, unknown>)["claudecode/toolUseId"];
      expect(toolUseId).toMatch(/^toolu_fixture_/);
      expect(call!.headers.authorization).toBe(UPSTREAM_CREDENTIAL);

      // The trace pairs that call with the vendor's conversation by its id,
      // and the ledger saw it forwarded and answered.
      const toolSpan = result.turnTrace?.spans.find((span) => span.category === "tool");
      expect(toolSpan).toMatchObject({ toolCallId: toolUseId, outputSource: "evidence", wireCorroborated: true });
      const [entry] = webClientToolCallLedger.find({ connectorId: CONNECTOR_ID, toolUseId: String(toolUseId) });
      expect(entry).toMatchObject({ state: "result", toolName: "echo" });
      expect(toolSpan?.evidenceRequestId).toBe(entry!.id);
      expect(webClientTurnWindows.active(CONNECTOR_ID)).toBeUndefined();

      // Opt-in evidence for a reviewer: what the server received, written to a
      // file outside the repository. Fixture values only.
      const evidencePath = process.env.MCPJAM_WEB_E2E_EVIDENCE;
      if (evidencePath) {
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              evidence: "fixture",
              runId: "iteration-e2e",
              turnId: result.turnTrace?.turnId,
              ledger: webClientToolCallLedger.forTurn(result.turnTrace?.turnId ?? ""),
              upstreamReceived: upstream.received.map(({ method, params, headers }) => ({
                method,
                params,
                headers,
              })),
            },
            null,
            2,
          ),
        );
      }
    });

    it("refuses a tool call outside a turn, so nothing reaches the server", async () => {
      const before = upstream.received.filter((r) => r.method === "tools/call").length;
      const response = await fetch(`${endpointUrl}/mcp/${CONNECTOR_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "echo", arguments: { message: "late" } },
        }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      expect(body.error?.message).toMatch(/No MCPJam run is using this connector/);
      expect(upstream.received.filter((r) => r.method === "tools/call")).toHaveLength(before);
    });
  },
);
