/**
 * The in-sandbox bridge for the `codex app-server` transport.
 *
 * Bundled to `bridge.mjs` and spawned inside the box by the host adapter. It
 * owns one long-lived `codex app-server` child and one thread; the framework's
 * `runBridge` owns the socket, the event log, replay and the lifecycle files.
 *
 * Boot order matters and is not arbitrary:
 *
 *   1. the host-tool relay binds first, because
 *   2. the rendered `CODEX_HOME` has to name its port, because
 *   3. Codex reads that config when it starts and never re-reads it.
 *
 * A tool set that changes between turns therefore restarts the thread rather
 * than trying to update a server Codex has already connected to — there is no
 * `tools/list_changed` handling in this version, and pretending otherwise
 * would silently serve a stale catalog.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runBridge, type BridgeTurn } from "@ai-sdk/harness/bridge";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";
import type { StartMessage } from "../codex-appserver-bridge-protocol.js";
import {
  spawnAppServerClient,
  type AppServerClient,
} from "./app-server-client.js";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  JsonRpcNotification,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartResult,
} from "./app-server-protocol.js";
import { createApprovalController } from "./approval-controller.js";
import { buildHostToolCatalog } from "./host-tool-catalog.js";
import { prepareCodexHome } from "./codex-home.js";
import { startHostToolRelay, type HostToolRelay } from "./host-tool-relay.js";
import { createStreamTranslator } from "./stream-translator.js";

type Args = {
  workdir: string;
  bridgeStateDir: string;
  sessionDataDir: string;
  bootstrapDir: string;
};

function parseArgs(argv: string[]): Args {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const workdir = read("workdir") ?? process.cwd();
  return {
    workdir,
    bridgeStateDir:
      read("bridge-state-dir") ?? join(workdir, ".harness-bridge"),
    sessionDataDir: read("session-data-dir") ?? join(workdir, ".codex-session"),
    bootstrapDir: read("bootstrap-dir") ?? process.cwd(),
  };
}

/**
 * Permission mode → Codex's policy and sandbox.
 *
 * `untrusted` is what produces approval requests: Codex auto-approves the
 * commands it knows to be read-only and asks about everything else, which is
 * the closest honest mapping to "reads stay free, side effects are gated".
 * `allow-edits` maps the same way as `allow-reads` deliberately — Codex has no
 * middle policy that gates only writes, and the safe direction when the host
 * asked for approval is to ask more, not less.
 */
export function toCodexPermissions(mode: string | undefined): {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
} {
  switch (mode) {
    case "allow-reads":
    case "allow-edits":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

/** Configuration whose change cannot be applied to a live thread. */
function turnConfigurationFingerprint(start: StartMessage): string {
  return JSON.stringify({
    tools: (start.tools ?? []).map((tool) => tool.name).sort(),
    instructions: start.instructions ?? "",
    permissionMode: start.permissionMode ?? "allow-all",
    webSearch: start.webSearch ?? false,
    model: start.model ?? "",
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.sessionDataDir, { recursive: true });

  let client: AppServerClient | undefined;
  let relay: HostToolRelay | undefined;
  let threadId: string | undefined;
  let lastFingerprint: string | undefined;
  /** Set by the current turn so the relay can reach its tool channel. */
  let activeTurn:
    | {
        turn: BridgeTurn;
        aliasToCanonical: Map<string, string>;
        toolCallSeq: number;
      }
    | undefined;
  let catalog = buildHostToolCatalog([]);

  const ensureRuntime = async (start: StartMessage): Promise<void> => {
    if (client) return;

    relay = await startHostToolRelay({
      listTools: () => catalog.descriptors,
      callTool: async ({ toolName, input }) => {
        const active = activeTurn;
        if (!active) throw new Error("no active turn for a host tool call");
        const canonical = active.aliasToCanonical.get(toolName) ?? toolName;
        const toolCallId = `mcpjam-host-${++active.toolCallSeq}`;
        // `providerExecuted: false` is the signal that MCPJam runs this one.
        // The framework's approval gate (HarnessAgent `toolApproval`) fires on
        // the host side before `execute`, which is why the bridge must not
        // prompt for it as well.
        active.turn.emit({
          type: "tool-call",
          toolCallId,
          toolName: canonical,
          input: JSON.stringify(input ?? {}),
          providerExecuted: false,
        });
        const result = await active.turn.requestToolResult(toolCallId);
        active.turn.emit({
          type: "tool-result",
          toolCallId,
          toolName: canonical,
          result,
        });
        return result;
      },
    });

    const codexHome = prepareCodexHome({
      codexHome: join(args.sessionDataDir, "codex-home"),
      // Delivered per session as the adapter's credential environment. The
      // real lease is injected outside the VM; this is the placeholder that
      // satisfies Codex's own auth check.
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKeyEnvVar: "CODEX_API_KEY",
      hostToolsEntrypoint: join(args.bootstrapDir, "host-tools-mcp.mjs"),
      relayUrl: relay.url,
      relayCredential: relay.credential,
      webSearch: start.webSearch ?? false,
    });

    client = spawnAppServerClient({
      command: process.execPath,
      args: [
        join(
          args.bootstrapDir,
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        ),
        "app-server",
      ],
      cwd: args.workdir,
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    await client.request("initialize", {
      clientInfo: {
        name: "mcpjam-inspector",
        title: "MCPJam Inspector",
        version: "1.0.0",
      },
    });
    client.notify("initialized", {});
  };

  await runBridge<StartMessage>({
    // Kept as `codex`: `bridge-meta.json`'s type is matched by the framework's
    // `waitForBridgeReady`, and both Codex transports are the same harness id.
    bridgeType: "codex",
    bridgeStateDir: args.bridgeStateDir,
    onStop: () => ({ threadId }),
    onDestroy: async () => {
      await client?.kill();
      await relay?.close();
    },
    async onStart(start, turn) {
      // The catalog has to exist BEFORE Codex starts: it reads the MCP server's
      // tools once, at startup.
      catalog = buildHostToolCatalog(start.tools ?? []);
      await ensureRuntime(start);
      const runtime = client;
      if (!runtime) throw new Error("codex app-server failed to start");

      activeTurn = {
        turn,
        aliasToCanonical: catalog.aliasToCanonical,
        toolCallSeq: 0,
      };

      const translator = createStreamTranslator({
        emit: (event) => turn.emit(event),
        emitWarning: (input) => turn.emitWarning(input),
        emitError: (input) => turn.emitError(input),
        relayServerName: RELAY_MCP_SERVER_NAME,
      });
      const approvals = createApprovalController({ turn, translator });

      runtime.onNotification((notification: JsonRpcNotification) => {
        translator.handleNotification(notification);
      });
      runtime.onServerRequest((request) => approvals.handle(request));

      const { approvalPolicy, sandbox } = toCodexPermissions(
        start.permissionMode,
      );
      const fingerprint = turnConfigurationFingerprint(start);
      const mustRestart =
        start.restartThread === true ||
        (lastFingerprint !== undefined && lastFingerprint !== fingerprint);
      if (mustRestart) threadId = undefined;
      lastFingerprint = fingerprint;

      const threadParams: ThreadStartParams = {
        cwd: args.workdir,
        approvalPolicy,
        sandbox,
        // Only meaningful when the policy asks anyone at all; harmless
        // otherwise, and explicit beats relying on a default.
        approvalsReviewer: "user",
        ...(start.model ? { model: start.model } : {}),
        ...(start.instructions
          ? { developerInstructions: start.instructions }
          : {}),
        ...(start.codexConfig ? { config: start.codexConfig } : {}),
        serviceName: "mcpjam-inspector",
      };

      // `mustRestart` means the turn configuration changed under a live
      // thread, so the thread must be rebuilt. `threadId` is already cleared
      // above, but the host's `resumeThreadId` (sent on every rerun start)
      // would otherwise resume the very thread we just decided to abandon,
      // carrying the stale tools, instructions and permissions with it.
      const resumeId = mustRestart ? undefined : (threadId ?? start.resumeThreadId);
      const thread = resumeId
        ? await runtime.request<ThreadStartResult>("thread/resume", {
            ...threadParams,
            threadId: resumeId,
          })
        : await runtime.request<ThreadStartResult>(
            "thread/start",
            threadParams,
          );
      threadId = thread.thread?.id ?? resumeId;
      if (threadId) turn.emit({ type: "bridge-thread", threadId });
      turn.emit({
        type: "stream-start",
        ...(thread.model ? { modelId: thread.model } : {}),
      });

      const started = await runtime.request<TurnStartResult>("turn/start", {
        threadId,
        input: [{ type: "text", text: start.prompt }],
        ...(start.model ? { model: start.model } : {}),
        ...(start.reasoningEffort ? { effort: start.reasoningEffort } : {}),
        summary: "detailed",
        ...(start.responseFormat?.type === "json" && start.responseFormat.schema
          ? { outputSchema: start.responseFormat.schema }
          : {}),
      });
      const turnId = started.turn?.id;

      const onAbort = () => {
        // Order matters: cancel the pauses FIRST so nothing is still waiting on
        // a human, then ask Codex to stop. Interrupting while an approval is
        // outstanding would leave the child blocked on a request nobody is
        // going to answer.
        approvals.cancelAll();
        relay?.cancelAll("turn aborted");
        if (turnId) {
          void runtime
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => {});
        }
      };
      if (turn.abortSignal.aborted) onAbort();
      else turn.abortSignal.addEventListener("abort", onAbort, { once: true });

      // Whichever comes first. A child that dies mid-turn must settle the turn
      // rather than leave `onStart` pending until the teardown grace expires.
      await Promise.race([
        translator.waitForTurn(),
        runtime.exited.then((error) => {
          if (error) {
            turn.emitError({ error });
            translator.finishTurn({ status: "failed" });
          }
        }),
      ]);
      activeTurn = undefined;
    },
  });
}

/*
 * AUTOSTART IS OPT-IN.
 *
 * The bundle script appends the `main()` call to the built `bridge.mjs`, so the
 * shipped artifact starts on its own. The SOURCE must not: this module also
 * exports `toCodexPermissions`, and importing it from a unit test would
 * otherwise bind a WebSocket server and spawn Codex. That is not hypothetical —
 * it happened, and the test suite printed a `bridge-ready` line.
 */
if (process.env.MCPJAM_CODEX_APPSERVER_BRIDGE_AUTOSTART === "true") {
  void main();
}
