/**
 * The local Claude tracer: one harmless prompt on claude.ai, through MCPJam's
 * forwarding endpoint, with sanitized evidence of what crossed the wire.
 *
 *   npx tsx --tsconfig server/tsconfig.json scripts/web-clients-local-tracer.ts \
 *     --tunnel-url https://<your tunnel host> [--port 6280] [--profile <dir>]
 *
 * See docs/web-clients-local-tracer.md. It never answers a human check, a
 * password, a code or a consent page: it prints one "Needs sign-in" line and
 * exits, and the person finishes that step in the browser window it opened.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Generated files the server code imports come from these build steps. */
const SETUP =
  "Set up the checkout first: from the repository root run npm ci, then in mcpjam-inspector/ run npm run sdk:build && npm run bundle:all.";

const HARMLESS_PROMPT =
  "Use the MCPJam tracer connector's echo tool with the message 'tracer check', then tell me in one sentence what it returned.";

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "tunnel-url": { type: "string" },
      port: { type: "string", default: "6280" },
      profile: { type: "string", default: join(homedir(), ".mcpjam", "web-clients", "claude-profile") },
      "sign-in": { type: "boolean", default: false },
    },
  });
  const profile = resolve(values.profile);
  if (!relative(resolve(".."), profile).startsWith("..")) {
    fail("Keep the browser profile outside the repository. Pass --profile with a folder in your home directory.");
  }
  if (values["sign-in"]) {
    // A person signs in by hand: nothing here touches the page.
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(profile, { headless: false });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://claude.ai/login");
    process.stdout.write("Sign in to claude.ai in the window that opened, then close the window.\n");
    await new Promise<void>((done) => context.on("close", () => done()));
    process.exit(0);
  }
  const tunnel = values["tunnel-url"];
  if (!tunnel || !/^https:\/\//.test(tunnel)) {
    fail("Pass your public tunnel URL with --tunnel-url https://<host>. See docs/web-clients-local-tracer.md.");
  }

  const { serve } = await import("@hono/node-server");
  const { chromium } = await import("playwright");
  const { WEB_CLIENT_SITES } = await import("../shared/web-clients");
  const { createStaticConnectorResolver } = await import("../server/services/web-clients/connectors");
  const { webClientToolCallLedger } = await import("../server/services/web-clients/tool-call-ledger");
  const { webClientTurnWindows } = await import("../server/services/web-clients/turn-windows");
  const { startFixtureUpstream } = await import("../server/test/support/web-clients/fixture-upstream");
  const { claudeWebPageModule } = await import("../server/utils/harness/real-ui/claude-web");
  const { createMemorySendJournal, driveRealUiTurn } = await import("../server/utils/harness/real-ui/drive-turn");
  const { RealUiError } = await import("../server/utils/harness/real-ui/page-module");
  const { createPlaywrightDriver } = await import("../server/utils/harness/real-ui/playwright-driver");
  const endpointFile = new URL("../server/services/web-clients/forwarding-endpoint.ts", import.meta.url);
  if (!existsSync(endpointFile)) {
    fail("This checkout has no forwarding endpoint yet. Merge the endpoint branch, then run this again.");
  }
  const endpointModule = await import("../server/services/web-clients/forwarding-endpoint").catch(
    (error: unknown) =>
      fail(
        `The tracer could not load the Inspector's server code: ${error instanceof Error ? error.message : String(error)}\n${SETUP}`,
      ),
  );

  // The upstream is a recording echo server, so the receipt shows exactly
  // what the vendor's client sent and nothing of a real server is touched.
  const upstream = await startFixtureUpstream();
  const connectorId = randomBytes(24).toString("base64url");
  const app = endpointModule.createWebConnectorEndpoint({
    resolver: createStaticConnectorResolver([
      {
        connector: { connectorId, projectId: "local-tracer", serverId: "tracer", auth: "capability", vendor: "claude" },
        upstream: { url: upstream.url, headers: {} },
      },
    ]),
    // This process is the local Inspector's endpoint with the flag on.
    isEnabled: async () => true,
  });
  const server = serve({ fetch: app.fetch, port: Number(values.port), hostname: "127.0.0.1" });
  const connectorUrl = new URL(`/mcp/${connectorId}`, tunnel).href;
  process.stdout.write(
    `Forwarding endpoint on http://127.0.0.1:${values.port}. Point your tunnel there; claude.ai will use ${new URL(tunnel).host}.\n`,
  );

  const runId = `tracer-${randomUUID()}`;
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const driver = await createPlaywrightDriver(page, { sites: WEB_CLIENT_SITES.claude });
  const window = webClientTurnWindows.open({
    connectorId,
    runId,
    // Only the tracer's own echo tool may run.
    approve: async (call) =>
      call.toolName === "echo"
        ? { allow: true }
        : { allow: false, reason: "The tracer only allows its echo tool." },
  });
  let exitCode = 0;
  try {
    const result = await driveRealUiTurn({
      module: claudeWebPageModule,
      driver,
      connectors: [{ name: "MCPJam tracer", url: connectorUrl }],
      prompt: HARMLESS_PROMPT,
      journal: createMemorySendJournal(),
      turnKey: window.turnId,
      onStep: (step) => process.stdout.write(`step: ${step}\n`),
    });
    const evidence = {
      runId,
      turnId: window.turnId,
      evidence: "live vendor",
      conversationId: result.conversation.conversationId,
      replyFinishedOn: result.finishedSignals,
      approvalsAnswered: result.approvalsAnswered,
      conversationToolCalls: result.conversation.toolCalls.map(({ toolName, toolUseId }) => ({ toolName, toolUseId })),
      ledger: webClientToolCallLedger.forTurn(window.turnId).map((entry) => ({
        id: entry.id,
        toolName: entry.toolName,
        toolUseId: entry.toolUseId,
        state: entry.state,
        upstreamStatus: entry.upstreamStatus,
        argsHash: entry.argsHash.slice(0, 12),
        forwardedAt: entry.forwardedAt,
        settledAt: entry.settledAt,
      })),
      upstreamReceipt: upstream.received.map((receipt) => ({
        method: receipt.method,
        clientInfo: receipt.method === "initialize" ? receipt.params?.clientInfo : undefined,
        tool: receipt.method === "tools/call" ? receipt.params?.name : undefined,
        argumentKeys:
          receipt.method === "tools/call"
            ? Object.keys((receipt.params?.arguments as Record<string, unknown> | undefined) ?? {})
            : undefined,
        toolUseId:
          receipt.method === "tools/call"
            ? (receipt.params?._meta as Record<string, unknown> | undefined)?.["claudecode/toolUseId"]
            : undefined,
        userAgent: receipt.headers["user-agent"],
      })),
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    if (error instanceof RealUiError && error.failure.kind === "needs_sign_in") {
      process.stdout.write(
        `Needs sign-in: ${error.failure.message} Run this command with --sign-in, finish signing in to claude.ai in the window it opens, close it, then run the tracer again.\n`,
      );
      exitCode = 2;
    } else if (error instanceof RealUiError) {
      process.stdout.write(`The tracer stopped at ${error.failure.step}: ${error.failure.message}\n`);
      exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    webClientTurnWindows.close(window.turnId);
    await context.close();
    server.close();
    await upstream.close();
  }
  process.exit(exitCode);
}

void main();
