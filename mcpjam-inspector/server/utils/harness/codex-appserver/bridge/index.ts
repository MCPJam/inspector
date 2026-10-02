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
import {
  runtimeConfigFingerprint,
  turnConfigurationFingerprintInput,
} from "../shared/turn-fingerprint.js";
import type { StartMessage } from "../codex-appserver-bridge-protocol.js";
import {
  parseWorkspaceWriteSandboxPolicy,
  sandboxPolicyFingerprint,
  type CodexWorkspaceWriteSandboxPolicy,
} from "../shared/sandbox-policy.js";
import {
  spawnAppServerClient,
  type AppServerClient,
} from "./app-server-client.js";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSandboxPolicy,
  JsonRpcNotification,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartResult,
} from "./app-server-protocol.js";
import { createApprovalController } from "./approval-controller.js";
import { foreignMcpServerOverrides } from "./mcp-isolation.js";
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
 * Is this bridge supervised on a user's own machine rather than inside a cloud
 * sandbox? The local supervisor ALWAYS sets `MCPJAM_LOCAL_CONTROL_ROOT` in the
 * child environment (`session-env.ts`) and a cloud box never has it, so its
 * presence is the one signal that there is no outer boundary around Codex.
 */
export function isSupervisedLocally(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    typeof env.MCPJAM_LOCAL_CONTROL_ROOT === "string" &&
    env.MCPJAM_LOCAL_CONTROL_ROOT.length > 0
  );
}

export class CodexPermissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPermissionRefusedError";
  }
}

/**
 * Permission mode → Codex's policy and sandbox. FAIL CLOSED.
 *
 * `untrusted` is what produces approval requests. Measured on 0.149.1
 * (PROBES.md (c)): it asks about EVERY command — `pwd`, `ls` and `cat`
 * included — and about every file change (both `apply_patch` forms), so an
 * attended Codex turn prompts more than an attended Claude Code one, and the
 * product must not claim reads are free. `allow-edits` maps the same way as
 * `allow-reads` deliberately — Codex has no middle policy that gates only
 * writes, and the safe direction when the host asked for approval is to ask
 * more, not less.
 *
 * `allow-all` means nobody is there to approve. In a cloud sandbox the box is
 * the boundary, so that is `danger-full-access`. On a user's machine it is
 * legal ONLY with an explicit workspace-write `sandboxPolicy` (the unattended
 * local arm, `shared/sandbox-policy.ts`): `danger-full-access` under local
 * supervision would hand an unattended agent the OS user's whole authority,
 * so it is refused rather than silently granted.
 *
 * Anything that is not one of the three framework modes is refused too. The
 * previous mapping turned an unknown string into `danger-full-access`, which
 * meant a typo or a future mode name granted the widest access there is.
 */
export function toCodexPermissions(
  mode: string | undefined,
  options: {
    sandboxPolicy?: CodexWorkspaceWriteSandboxPolicy | undefined;
    supervisedLocally?: boolean;
  } = {},
): {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  sandboxPolicy?: CodexSandboxPolicy;
} {
  // Checked here, not trusted: the framework only `JSON.parse`s the start
  // message, so a policy of any shape (e.g. `dangerFullAccess`) would
  // otherwise reach `turn/start` as-is.
  let sandboxPolicy: CodexWorkspaceWriteSandboxPolicy | undefined;
  if (options.sandboxPolicy !== undefined) {
    const parsed = parseWorkspaceWriteSandboxPolicy(options.sandboxPolicy);
    if (parsed === null) {
      throw new CodexPermissionRefusedError(
        "Refusing a command-sandbox policy that is not MCPJam's " +
          "workspace-write policy.",
      );
    }
    if (options.supervisedLocally && parsed.networkAccess) {
      throw new CodexPermissionRefusedError(
        "Refusing command network access for a turn on a user's machine.",
      );
    }
    sandboxPolicy = parsed;
  }
  switch (mode ?? "allow-all") {
    case "allow-reads":
    case "allow-edits":
      return {
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        ...(sandboxPolicy ? { sandboxPolicy: { ...sandboxPolicy } } : {}),
      };
    case "allow-all":
      if (sandboxPolicy) {
        return {
          approvalPolicy: "never",
          sandbox: "workspace-write",
          sandboxPolicy: { ...sandboxPolicy },
        };
      }
      if (options.supervisedLocally) {
        throw new CodexPermissionRefusedError(
          "Refusing to start Codex with danger-full-access on a user's " +
            "machine: an unattended local turn must carry an explicit " +
            "workspace-write sandbox policy.",
        );
      }
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      throw new CodexPermissionRefusedError(
        `Unknown permission mode ${JSON.stringify(mode)}; refusing rather ` +
          `than guessing how much access to grant.`,
      );
  }
}

/**
 * The per-thread config layer: the host's `codexConfig`, plus a disable entry
 * for every MCP server a system or managed layer declares (`mcp-isolation.ts`)
 * so MCPJam's relay is the model's only MCP surface. The relay's own entry is
 * rendered into `CODEX_HOME` and never overridden here.
 */
function withThreadConfig(
  start: StartMessage,
): { config?: Record<string, unknown> } {
  const config = threadConfig(start);
  return Object.keys(config).length > 0 ? { config } : {};
}

function threadConfig(start: StartMessage): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(start.codexConfig ?? {}) };
  const foreign = foreignMcpServerOverrides({ keep: RELAY_MCP_SERVER_NAME });
  if (Object.keys(foreign).length > 0) {
    const existing =
      config.mcp_servers && typeof config.mcp_servers === "object"
        ? (config.mcp_servers as Record<string, unknown>)
        : {};
    config.mcp_servers = { ...foreign, ...existing };
  }
  return config;
}

/** Configuration whose change cannot be applied to a live thread. */
function turnConfigurationFingerprint(start: StartMessage): string {
  return JSON.stringify({
    // Shared with the host so the two cannot disagree about what a "changed
    // tool" is — and over the whole descriptor, not just the name: a tool whose
    // schema changed under a fixed name is invisible to a live thread.
    turn: turnConfigurationFingerprintInput({
      instructions: start.instructions,
      tools: start.tools ?? [],
    }),
    permissionMode: start.permissionMode ?? "allow-all",
    // A changed command sandbox is a changed configuration: a resumed thread
    // would otherwise keep running under the previous one.
    sandboxPolicy: sandboxPolicyFingerprint(start.sandboxPolicy),
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
  /**
   * The config that is baked into `CODEX_HOME` when the runtime starts, and
   * therefore CANNOT be changed on a running one.
   *
   * Two things live here, and both are invisible to a restarted THREAD:
   *
   *  - `web_search`, written by `prepareCodexHome()` and not a `thread/start`
   *    parameter, so a reused process runs the new turn under the FIRST turn's
   *    setting.
   *  - the HOST-TOOL CATALOG. Codex reads its MCP server's tool list once, when
   *    the process starts, and this adapter wires no `tools/list_changed`. A
   *    reused process therefore keeps the tool set it booted with: a newly
   *    selected server is uncallable, and a removed one stays callable. The
   *    turn fingerprint restarts the thread on the same change, which is not
   *    enough — the thread is not what holds the catalog.
   */
  let runtimeConfig: string | undefined;
  const runtimeConfigOf = (start: StartMessage): string =>
    runtimeConfigFingerprint(start);

  const ensureRuntime = async (start: StartMessage): Promise<void> => {
    const wanted = runtimeConfigOf(start);
    if (client && runtimeConfig !== undefined && runtimeConfig !== wanted) {
      // Tear the old one down before rebuilding: the relay holds a port and the
      // child holds the stale CODEX_HOME.
      await client.kill();
      await relay?.close();
      client = undefined;
      relay = undefined;
      threadId = undefined;
    }
    runtimeConfig = wanted;
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
      // Delivered per session as the adapter's credential environment: the
      // hosted proxy's `…/openai/v1`, or the local gateway's bare origin. The
      // real lease is injected outside the process; `CODEX_API_KEY` is the
      // placeholder (or local capability) that satisfies Codex's auth check.
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
      // Codex's own diagnostics, forwarded to the bridge's stderr — which the
      // host already tails into a bridge startup error and its logs. Without
      // this a Codex that failed to start (a sandbox it could not initialise,
      // a config it rejected) surfaced only as an opaque exit code.
      onStderrLine: (line) => {
        process.stderr.write(`[codex] ${line}\n`);
      },
    });

    /*
     * A DEAD CLIENT MUST NOT BE REUSED.
     *
     * `AppServerClient` rejects every request once its child is gone, but
     * nothing here noticed: `ensureRuntime` returns early on `if (client)`, so
     * after Codex crashed, every later turn with the same fingerprint failed
     * instantly on `thread/start` — permanently, since nothing ever rebuilt it.
     * The turn that witnessed the crash reports it (see the `exited` race in
     * `onStart`); this is about every turn after.
     *
     * Guarded on identity because `ensureRuntime`'s own teardown also resolves
     * `exited`: by then it has already installed a replacement, and clearing
     * `client` there would drop the runtime that was just built.
     */
    const spawned = client;
    void spawned.exited.then(() => {
      if (client !== spawned) return;
      client = undefined;
      // The parked thread lived in the process that just died.
      threadId = undefined;
      // The relay was reachable only by that Codex, and its credential was
      // rendered into that CODEX_HOME. Nothing can call it now.
      const orphaned = relay;
      relay = undefined;
      void orphaned?.close();
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
      // Decided FIRST, before anything starts: a turn whose permissions are
      // refused must not spawn a Codex process at all.
      const { approvalPolicy, sandbox, sandboxPolicy } = toCodexPermissions(
        start.permissionMode,
        {
          sandboxPolicy: start.sandboxPolicy,
          supervisedLocally: isSupervisedLocally(),
        },
      );

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
        ...withThreadConfig(start),
        serviceName: "mcpjam-inspector",
      };

      // `mustRestart` means the turn configuration changed under a live
      // thread, so the thread must be rebuilt. `threadId` is already cleared
      // above, but the host's `resumeThreadId` (sent on every rerun start)
      // would otherwise resume the very thread we just decided to abandon,
      // carrying the stale tools, instructions and permissions with it.
      const resumeId = mustRestart
        ? undefined
        : (threadId ?? start.resumeThreadId);
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
        // Explicit, every turn it applies to. The schema's own workspace-write
        // default leaves /tmp writable; see `shared/sandbox-policy.ts`.
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
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

      /*
       * Whichever comes first. A child that dies mid-turn must settle the turn
       * rather than leave `onStart` pending until the teardown grace expires.
       *
       * `settled` is what keeps the LOSER quiet. `Promise.race` does not cancel
       * anything, so the `exited` handler outlives the turn that installed it
       * — and it fires on the next runtime exit whenever that happens: a crash
       * during somebody else's turn, or the ordinary `client.kill()` at
       * teardown. Both emitted an error on this turn's handle long after it
       * finished, which the host reads as a frame belonging to whatever turn is
       * open now. Found by killing Codex between two live turns; the second
       * turn inherited the first one's failure.
       */
      let settled = false;
      await Promise.race([
        translator.waitForTurn().then(() => {
          settled = true;
        }),
        runtime.exited.then((error) => {
          if (settled || !error) return;
          settled = true;
          turn.emitError({ error });
          translator.finishTurn({ status: "failed" });
        }),
      ]);
      settled = true;
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
