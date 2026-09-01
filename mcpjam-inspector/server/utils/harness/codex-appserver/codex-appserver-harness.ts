/**
 * `createCodexAppServer` — MCPJam's own `HarnessV1` adapter for the interactive
 * `codex app-server` transport.
 *
 * WHY THIS EXISTS. The published `@ai-sdk/harness-codex` drives `codex exec`
 * through the Codex SDK, which hardcodes `approvalPolicy: 'never'` and
 * `sandboxMode: 'danger-full-access'`, and whose `doStart` rejects any
 * permission mode but `allow-all`. That is not a mode we failed to select: exec
 * is a batch transport with no channel to interrupt and no way to ask. Every
 * capability gap in MCPJam's Codex host traces back to it — no approvals, two
 * attributable tools, MCP through a shell shim.
 *
 * `codex app-server` is the long-lived JSON-RPC transport the editor
 * integrations use, and it carries all of it: real approval requests, typed
 * items for every action, per-turn token usage with a cache breakdown,
 * interrupt, and native MCP configuration.
 *
 * The SHAPE of this adapter deliberately mirrors the published one — the same
 * bridge asset, the same three-rung resume ladder, the same lifecycle payloads
 * — because the inspector's session machinery reaches into those shapes (see
 * `harness-session-state.ts` reading `data.bridge.sandboxId`). Only the
 * protocol underneath is ours.
 */
import {
  HarnessCapabilityUnsupportedError,
  harnessV1DiagnosticFromBridgeFrame,
  type HarnessV1,
  type HarnessV1ContinueTurnState,
  type HarnessV1DebugConfig,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PermissionMode,
  type HarnessV1PortEndpoint,
  type HarnessV1Prompt,
  type HarnessV1PromptControl,
  type HarnessV1ResumeSessionState,
  type HarnessV1Session,
  type HarnessV1Skill,
  type HarnessV1StreamPart,
} from "@ai-sdk/harness";
import {
  classifyDiskLog,
  createBridgeErrorHandler,
  createBridgeStartupError,
  createBridgeToken,
  drainBridgeProcessStream,
  forwardBridgeProcessStream,
  getRestrictedSandboxSession,
  markBridgeStarting,
  resolveSandboxDefaultWorkingDirectory,
  resolveSandboxHomeDir,
  SandboxChannel,
  shellQuote,
  waitForBridgeReady,
  withBridgeToken,
  writeSkills as writeHarnessSkills,
} from "@ai-sdk/harness/utils";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { CODEX_APPSERVER_BUILTIN_TOOLS } from "./codex-appserver-builtin-tools.js";
import {
  CODEX_APPSERVER_BOOTSTRAP_DIR,
  getCodexAppServerBootstrap,
} from "./codex-appserver-bootstrap.js";
import {
  codexAppServerResumeStateSchema,
  type CodexAppServerResumeState,
} from "./codex-appserver-lifecycle-state.js";
import {
  outboundMessageSchema,
  type InboundMessage,
  type OutboundMessage,
  type StartMessage,
} from "./codex-appserver-bridge-protocol.js";

export const CODEX_APPSERVER_HARNESS_ID = "codex";

/** Skills live where Codex reads them, the same root the exec transport uses. */
const CODEX_SKILLS_SUBDIR = ".agents/skills";

export type CodexAppServerSettings = {
  /** Native model id. Omitted ⇒ Codex's own default. */
  model?: string;
  /** Placeholder credential env (`CODEX_API_KEY`, `OPENAI_BASE_URL`). The real
   *  lease is injected outside the VM by E2B. */
  auth?: Readonly<Record<string, string>>;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Codex's own web search. Off unless the host asks. */
  webSearch?: boolean;
  /** Extra `config.toml` values, layered per thread. */
  codexConfig?: Record<string, unknown>;
  startupTimeoutMs?: number;
};

type Channel = SandboxChannel<OutboundMessage, InboundMessage>;

/**
 * The sandbox session types, structurally.
 *
 * The published adapter imports `Experimental_SandboxSession` from
 * `@ai-sdk/provider-utils`, but the inspector resolves its own copy of that
 * package, which does not re-export them. Deriving them from the framework's
 * own signatures keeps this adapter on ONE copy of the type — the one
 * `HarnessV1` itself is written against — instead of whichever version npm
 * happens to hoist.
 */
type SandboxSession = Parameters<typeof getRestrictedSandboxSession>[0];
type SandboxProcess = Awaited<ReturnType<SandboxSession["spawn"]>>;

/** Resolve the ws endpoint for a bound bridge port. */
async function resolveBridgeEndpoint(
  sandboxSession: SandboxSession | HarnessV1NetworkSandboxSession,
  port: number,
): Promise<HarnessV1PortEndpoint> {
  if ("getPortEndpoint" in sandboxSession) {
    return sandboxSession.getPortEndpoint({ port, protocol: "ws" });
  }
  throw new HarnessCapabilityUnsupportedError({
    harnessId: CODEX_APPSERVER_HARNESS_ID,
    message:
      "The codex app-server harness needs a sandbox session that can expose a port.",
  });
}

/** Connect, and resolve only once the socket is actually open — a channel that
 *  resolves on construction would send its first frame into a dead socket. */
function openWebSocket({
  url,
  headers,
}: HarnessV1PortEndpoint): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: headers == null ? undefined : { ...headers },
    });
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

/** Configuration a running thread cannot absorb; a change forces a new one. */
function fingerprintTurnConfiguration(input: {
  instructions: string | undefined;
  tools: ReadonlyArray<{ name: string }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        instructions: input.instructions ?? "",
        tools: input.tools.map((tool) => tool.name).sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function extractUserText(prompt: HarnessV1Prompt | undefined): string {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  const content = prompt.content;
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n\n");
}

export function createCodexAppServer(
  settings: CodexAppServerSettings = {},
): HarnessV1<typeof CODEX_APPSERVER_BUILTIN_TOOLS> {
  return {
    specificationVersion: "harness-v1",
    harnessId: CODEX_APPSERVER_HARNESS_ID,
    builtinTools: CODEX_APPSERVER_BUILTIN_TOOLS,
    /**
     * TRUE, and this is the whole point of the transport. `HarnessAgent`
     * refuses to construct with a non-`allow-all` permission mode unless the
     * harness declares this, so the exec adapter's `false` is what makes an
     * approval-gated Codex host unrepresentable today.
     */
    supportsBuiltinToolApprovals: true,
    /** Codex offers no way to remove a builtin from the model's tool set. */
    supportsBuiltinToolFiltering: false,
    lifecycleStateSchema: codexAppServerResumeStateSchema,
    getBootstrap: async () => getCodexAppServerBootstrap(),

    doStart: async (startOpts) => {
      if (startOpts.builtinToolFiltering != null) {
        throw new HarnessCapabilityUnsupportedError({
          message:
            "Harness 'codex' (app-server) does not support built-in tool filtering controls.",
          harnessId: CODEX_APPSERVER_HARNESS_ID,
        });
      }

      const sandboxSession = startOpts.sandboxSession;
      const toolSafeSandboxSession =
        getRestrictedSandboxSession(sandboxSession);
      const sandboxId = "id" in sandboxSession ? sandboxSession.id : undefined;
      const workDir =
        startOpts.sessionWorkDir ??
        (await resolveSandboxDefaultWorkingDirectory({ sandboxSession }));
      const sandboxHomeDir = await resolveSandboxHomeDir({
        sandbox: toolSafeSandboxSession,
      });
      const bootstrapDir = `${workDir}/${CODEX_APPSERVER_BOOTSTRAP_DIR}`;
      const sessionDataDir = `${workDir}/.harness-session/codex-appserver`;
      const bridgeStateDir = `${sessionDataDir}/bridge`;
      const timeoutMs = settings.startupTimeoutMs ?? 120_000;

      const lifecycle = startOpts.continueFrom ?? startOpts.resumeFrom;
      const isContinue = startOpts.continueFrom != null;
      const isResume = lifecycle != null;
      const parsed: CodexAppServerResumeState =
        lifecycle?.data == null
          ? {}
          : (codexAppServerResumeStateSchema.safeParse(lifecycle.data).data ??
            {});
      const coords = parsed.bridge;

      const report = startOpts.observability?.report;
      const onDiagnostic = report
        ? (frame: Parameters<typeof harnessV1DiagnosticFromBridgeFrame>[0]) =>
            report(
              harnessV1DiagnosticFromBridgeFrame(frame, {
                sessionId: startOpts.sessionId,
                timestamp: Date.now(),
              }),
            )
        : undefined;
      const onBridgeError = createBridgeErrorHandler({
        harnessId: CODEX_APPSERVER_HARNESS_ID,
        sessionId: startOpts.sessionId,
      });

      /*
       * Rung 1 — ATTACH. Live coordinates mean a bridge is still running in the
       * box; reopen a socket to it rather than spawning a second one. A parked
       * between-turn session just attaches; a suspended in-flight turn asks for
       * replay from its persisted cursor. If the bridge is gone the open throws
       * and we fall through to a respawn.
       */
      if (coords) {
        try {
          const endpoint = withBridgeToken({
            endpoint: await resolveBridgeEndpoint(sandboxSession, coords.port),
            token: coords.token,
          });
          const attachChannel: Channel = new SandboxChannel({
            connect: () => openWebSocket(endpoint),
            outboundSchema: outboundMessageSchema,
            initialLastSeenEventId: coords.lastSeenEventId,
            onDiagnostic,
            onBridgeError,
          });
          await attachChannel.open(isContinue ? { resume: true } : undefined);
          return createCodexAppServerSession({
            sessionId: startOpts.sessionId,
            channel: attachChannel,
            proc: undefined,
            settings,
            isResume: true,
            // An attached bridge already holds its thread in memory and keeps
            // going; seeding a resume id would make it start a second one.
            seedResumeThreadOnFirstPrompt: false,
            rerunContinue: false,
            bridgePort: coords.port,
            bridgeToken: coords.token,
            sandboxId,
            resumeThreadId: parsed.threadId,
            turnConfigurationFingerprint: parsed.turnConfigurationFingerprint,
            sandboxCredentialEnvironment: parsed.sandboxCredentialEnvironment,
            permissionMode: startOpts.permissionMode,
            debug: startOpts.observability?.debug,
            sandbox: toolSafeSandboxSession,
            sandboxHomeDir,
          });
        } catch {
          // Unreachable bridge — respawn below.
        }
      }

      /*
       * Rungs 2/3 — REPLAY vs RERUN.
       *
       * REPLAY is only sound for `continueFrom`: those coordinates carry the
       * cursor the on-disk log is replayed FROM. A `resumeFrom` is a
       * between-turn resume, and replaying the previous turn there would
       * re-deliver stale events into the next one.
       */
      let respawnStrategy: "replay" | "rerun" | undefined = isResume
        ? "rerun"
        : undefined;
      if (coords && isContinue) {
        const logRaw = await Promise.resolve(
          toolSafeSandboxSession.readTextFile({
            path: `${bridgeStateDir}/event-log.ndjson`,
            abortSignal: startOpts.abortSignal,
          }),
        ).catch(() => null);
        if ((await classifyDiskLog(logRaw)) === "replay") {
          respawnStrategy = "replay";
        }
      }

      const token = createBridgeToken();
      const env: Record<string, string> = {
        ...(settings.auth ?? {}),
        BRIDGE_CHANNEL_TOKEN: token,
        BRIDGE_WS_PORT: "0",
        ...(respawnStrategy === "replay"
          ? { BRIDGE_REPLAY_FROM_DISK: "1" }
          : {}),
      };

      if (respawnStrategy === undefined) {
        await toolSafeSandboxSession.run({
          command: `mkdir -p ${shellQuote(workDir)} ${shellQuote(bridgeStateDir)} ${shellQuote(sessionDataDir)}`,
          abortSignal: startOpts.abortSignal,
        });
      }

      await markBridgeStarting({
        sandbox: toolSafeSandboxSession,
        bridgeStateDir,
        bridgeType: CODEX_APPSERVER_HARNESS_ID,
        abortSignal: startOpts.abortSignal,
      });

      const proc = await toolSafeSandboxSession.spawn({
        command:
          `node ${shellQuote(`${bootstrapDir}/bridge.mjs`)}` +
          ` --workdir ${shellQuote(workDir)}` +
          ` --bridge-state-dir ${shellQuote(bridgeStateDir)}` +
          ` --session-data-dir ${shellQuote(sessionDataDir)}` +
          ` --bootstrap-dir ${shellQuote(bootstrapDir)}`,
        env,
        abortSignal: startOpts.abortSignal,
      });
      const stderrTail: string[] = [];
      const bridgeStderrDone = forwardBridgeProcessStream({
        stream: proc.stderr,
        streamName: "stderr",
        source: CODEX_APPSERVER_HARNESS_ID,
        collectTail: stderrTail,
      });

      const { port: boundPort } = await waitForBridgeReady({
        proc,
        sandbox: toolSafeSandboxSession,
        bridgeStateDir,
        bridgeType: CODEX_APPSERVER_HARNESS_ID,
        timeoutMs,
        abortSignal: startOpts.abortSignal,
        createTimeoutError: ({ proc: p, stdoutTail }) =>
          createBridgeStartupError({
            message: "codex app-server bridge did not become ready in time.",
            proc: p,
            stdoutTail,
            stderrTail,
            stderrDone: bridgeStderrDone,
          }),
        createExitError: ({ proc: p, stdoutTail }) =>
          createBridgeStartupError({
            message: "codex app-server bridge exited before becoming ready.",
            proc: p,
            stdoutTail,
            stderrTail,
            stderrDone: bridgeStderrDone,
          }),
      });
      void drainBridgeProcessStream(proc.stdout);

      const endpoint = withBridgeToken({
        endpoint: await resolveBridgeEndpoint(sandboxSession, boundPort),
        token,
      });
      const channel: Channel = new SandboxChannel({
        connect: () => openWebSocket(endpoint),
        outboundSchema: outboundMessageSchema,
        onDiagnostic,
        onBridgeError,
        // In replay mode the respawned bridge reloaded the finished turn from
        // disk; seed the cursor so it streams only the tail.
        ...(respawnStrategy === "replay"
          ? { initialLastSeenEventId: coords?.lastSeenEventId ?? 0 }
          : {}),
      });
      await channel.open(
        respawnStrategy === "replay" ? { resume: true } : undefined,
      );

      return createCodexAppServerSession({
        sessionId: startOpts.sessionId,
        channel,
        proc,
        settings,
        isResume: respawnStrategy !== undefined,
        seedResumeThreadOnFirstPrompt: respawnStrategy !== undefined,
        rerunContinue: respawnStrategy === "rerun",
        bridgePort: boundPort,
        bridgeToken: token,
        sandboxId,
        resumeThreadId: parsed.threadId,
        turnConfigurationFingerprint: parsed.turnConfigurationFingerprint,
        sandboxCredentialEnvironment: settings.auth
          ? { ...settings.auth }
          : parsed.sandboxCredentialEnvironment,
        permissionMode: startOpts.permissionMode,
        debug: startOpts.observability?.debug,
        sandbox: toolSafeSandboxSession,
        sandboxHomeDir,
      });
    },
  };
}

function createCodexAppServerSession(input: {
  sessionId: string;
  channel: Channel;
  /** Undefined on ATTACH — another process spawned the live bridge. */
  proc: SandboxProcess | undefined;
  settings: CodexAppServerSettings;
  isResume: boolean;
  seedResumeThreadOnFirstPrompt: boolean;
  rerunContinue: boolean;
  bridgePort: number;
  bridgeToken: string;
  sandboxId: string | undefined;
  resumeThreadId: string | undefined;
  turnConfigurationFingerprint: string | undefined;
  sandboxCredentialEnvironment: Record<string, string> | undefined;
  permissionMode: HarnessV1PermissionMode | undefined;
  debug: HarnessV1DebugConfig | undefined;
  sandbox: SandboxSession;
  sandboxHomeDir: string;
}): HarnessV1Session {
  const { channel, sessionId } = input;
  let stopped = false;
  let latestThreadId = input.resumeThreadId;
  let latestFingerprint = input.turnConfigurationFingerprint;
  let pendingResumeThreadId = input.seedResumeThreadOnFirstPrompt
    ? input.resumeThreadId
    : undefined;

  channel.on("bridge-thread", (message) => {
    latestThreadId = message.threadId;
  });

  /**
   * Wait for the bridge process to exit, then make sure it is gone.
   *
   * BOUNDED, because teardown must not be able to hang the turn runner: a
   * bridge that ignores `stop` gets five seconds and then a kill. An unbounded
   * wait here would hold the session's lease until it TTL'd out.
   */
  const settleProcess = async (): Promise<void> => {
    const proc = input.proc;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (proc) {
        await Promise.race([
          proc.wait(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          }),
        ]);
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await proc?.kill();
      } catch {
        // Already gone.
      }
    }
  };

  /**
   * Write the turn's skills and decide whether the thread has to restart.
   *
   * Skills are REPLACED before each fresh turn — that is the framework's
   * contract, and `writeSkills` is idempotent so an unchanged set is a no-op.
   */
  const synchronizeTurnConfiguration = async (turnInput: {
    skills: ReadonlyArray<HarnessV1Skill>;
    instructions: string | undefined;
    tools: ReadonlyArray<{ name: string }>;
    abortSignal?: AbortSignal;
  }): Promise<{ restartThread: boolean }> => {
    await writeHarnessSkills({
      sandbox: input.sandbox,
      rootDir: `${input.sandboxHomeDir}/${CODEX_SKILLS_SUBDIR}`,
      skills: turnInput.skills,
      abortSignal: turnInput.abortSignal,
    });
    const fingerprint = fingerprintTurnConfiguration({
      instructions: turnInput.instructions,
      tools: turnInput.tools,
    });
    // Codex reads its MCP server's tool list ONCE, when it starts. A changed
    // tool set therefore cannot be applied to a live thread — there is no
    // `tools/list_changed` handling here — so the thread restarts instead of
    // silently serving a stale catalog.
    const restartThread =
      latestFingerprint !== undefined && latestFingerprint !== fingerprint;
    latestFingerprint = fingerprint;
    return { restartThread };
  };

  /** Wire one turn's stream, and settle when it finishes, errors or aborts. */
  const wireTurn = (turnOpts: {
    emit: (event: HarnessV1StreamPart) => void;
    abortSignal?: AbortSignal;
  }): {
    control: HarnessV1PromptControl;
    sendStart(send: () => void): void;
  } => {
    let resolveDone: (() => void) | undefined;
    let rejectDone: ((error: unknown) => void) | undefined;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const unsubscribes: Array<() => void> = [];
    let settled = false;
    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      for (const off of unsubscribes) off();
      resolveDone?.();
    };
    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      for (const off of unsubscribes) off();
      rejectDone?.(error);
    };

    const forward = (event: OutboundMessage) => {
      try {
        turnOpts.emit(event as HarnessV1StreamPart);
      } catch {
        // A consumer that throws must not take the turn down with it.
      }
    };
    for (const type of [
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-call",
      "tool-approval-request",
      "tool-result",
      "file-change",
      "compaction",
      "finish-step",
      "raw",
    ] as const) {
      unsubscribes.push(
        channel.on(type, forward as (message: OutboundMessage) => void),
      );
    }
    unsubscribes.push(
      channel.on("finish", (message) => {
        forward(message);
        settleSuccess();
      }),
    );
    unsubscribes.push(
      channel.on("error", (message) => {
        forward(message);
        settleError(message.error);
      }),
    );

    // A `'suspended'` close is the host's own slice boundary (`doSuspendTurn`):
    // the turn keeps running in the bridge and its tail is replayed to the next
    // process, so wind down cleanly rather than failing the turn. Any other
    // mid-turn close is a real drop.
    channel.onClose((_code?: number, reason?: string) => {
      if (settled) return;
      if (reason === "suspended") settleSuccess();
      else
        settleError(
          new Error("codex app-server bridge closed before the turn finished."),
        );
    });

    const onAbort = () => {
      if (settled) return;
      try {
        channel.send({ type: "abort" } as InboundMessage);
      } catch {
        // The socket may already be gone; the abort below still settles.
      }
      settleError(
        turnOpts.abortSignal?.reason ??
          new DOMException("Aborted", "AbortError"),
      );
    };
    if (turnOpts.abortSignal?.aborted) onAbort();
    else
      turnOpts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    return {
      control: {
        submitToolResult: async (result) => {
          channel.send({
            type: "tool-result",
            toolCallId: result.toolCallId,
            output: result.output,
            isError: result.isError,
          } as InboundMessage);
        },
        submitToolApproval: async (approval) => {
          channel.send({
            type: "tool-approval-response",
            approvalId: approval.approvalId,
            approved: approval.approved,
            reason: approval.reason,
          } as InboundMessage);
        },
        done,
      },
      sendStart: (send) => {
        // Deferred by one event-loop turn so the runner finishes wiring the
        // prompt control before a short turn can settle underneath it.
        const timer = setTimeout(() => {
          if (settled) return;
          try {
            send();
          } catch (error) {
            settleError(error);
          }
        }, 0);
        timer.unref?.();
      },
    };
  };

  const buildStart = (
    turnInput: {
      prompt: HarnessV1Prompt;
      instructions?: string;
      model?: string;
      tools: ReadonlyArray<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
      responseFormat?: unknown;
    },
    restartThread: boolean,
  ): StartMessage => {
    const message = {
      type: "start" as const,
      prompt: extractUserText(turnInput.prompt),
      tools: turnInput.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      ...(turnInput.model || input.settings.model
        ? { model: turnInput.model ?? input.settings.model }
        : {}),
      ...(turnInput.instructions
        ? { instructions: turnInput.instructions }
        : {}),
      ...(turnInput.responseFormat
        ? { responseFormat: turnInput.responseFormat }
        : {}),
      ...(input.settings.reasoningEffort
        ? { reasoningEffort: input.settings.reasoningEffort }
        : {}),
      ...(input.settings.webSearch ? { webSearch: true } : {}),
      ...(input.settings.codexConfig
        ? { codexConfig: input.settings.codexConfig }
        : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(pendingResumeThreadId
        ? { resumeThreadId: pendingResumeThreadId }
        : {}),
      ...(restartThread ? { restartThread: true } : {}),
      ...(input.debug ? { debug: input.debug } : {}),
    } as StartMessage;
    pendingResumeThreadId = undefined;
    return message;
  };

  const lifecycleData = (
    includeBridge: {
      port: number;
      token: string;
      lastSeenEventId: number;
    } | null,
  ) => ({
    ...(latestThreadId ? { threadId: latestThreadId } : {}),
    ...(latestFingerprint
      ? { turnConfigurationFingerprint: latestFingerprint }
      : {}),
    ...(input.sandboxCredentialEnvironment
      ? { sandboxCredentialEnvironment: input.sandboxCredentialEnvironment }
      : {}),
    ...(includeBridge
      ? {
          bridge: {
            ...includeBridge,
            ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
          },
        }
      : {}),
  });

  return {
    sessionId,
    isResume: input.isResume,

    doPromptTurn: async (promptOpts) => {
      const { restartThread } = await synchronizeTurnConfiguration({
        skills: promptOpts.skills,
        instructions: promptOpts.instructions,
        tools: promptOpts.tools ?? [],
        abortSignal: promptOpts.abortSignal,
      });
      const turn = wireTurn({
        emit: promptOpts.emit,
        abortSignal: promptOpts.abortSignal,
      });
      const start = buildStart(
        {
          prompt: promptOpts.prompt,
          instructions: promptOpts.instructions,
          model: promptOpts.model,
          tools: promptOpts.tools ?? [],
          responseFormat: promptOpts.responseFormat,
        },
        restartThread,
      );
      turn.sendStart(() => channel.send(start));
      return turn.control;
    },

    doContinueTurn: async (continueOpts) => {
      const { restartThread } = await synchronizeTurnConfiguration({
        skills: continueOpts.skills,
        instructions: continueOpts.instructions,
        tools: continueOpts.tools ?? [],
        abortSignal: continueOpts.abortSignal,
      });
      const turn = wireTurn({
        emit: continueOpts.emit,
        abortSignal: continueOpts.abortSignal,
      });

      /*
       * ATTACH / REPLAY: the still-running (or disk-replayed) turn streams into
       * the listeners just wired — `doStart` opened the channel with
       * `{ resume: true }`, so the bridge replays everything past the cursor,
       * including a `finish` if the turn ended during the gap. Sending a
       * `start` here would clear that log and begin a NEW turn, losing the work
       * the user is waiting on.
       *
       * RERUN is the bridge-died fallback: there is nothing to attach to, so
       * the thread is re-driven from its id. Lossy by nature, and the reason a
       * pending approval does not survive a bridge death.
       */
      if (input.rerunContinue) {
        const start = buildStart(
          {
            // A continuation NUDGE, not an empty prompt. `resumeThreadId`
            // rehydrates the prior thread and this is the user turn that drives
            // it forward; an empty user message is a shape some runtimes
            // reject outright.
            prompt: "Continue.",
            instructions: continueOpts.instructions,
            model: continueOpts.model,
            tools: continueOpts.tools ?? [],
            responseFormat: continueOpts.responseFormat,
          },
          restartThread,
        );
        turn.sendStart(() =>
          channel.send({
            ...start,
            ...(latestThreadId ? { resumeThreadId: latestThreadId } : {}),
          }),
        );
      }
      return turn.control;
    },

    doCompact: async () => {
      /*
       * `codex app-server` DOES expose manual compaction
       * (`thread/compact/start`), so this is a framework limit rather than a
       * Codex one: the shared bridge runtime routes inbound frames through a
       * fixed switch with no default branch, so a custom `compact` command is
       * silently DROPPED. A frame that looks like it worked and does nothing is
       * worse than an honest refusal.
       *
       * Codex's automatic compaction is unaffected, and the bridge reports it
       * as a `compaction` stream part.
       */
      throw new HarnessCapabilityUnsupportedError({
        message:
          "Harness 'codex' (app-server) cannot trigger manual compaction: the " +
          "bridge protocol has no command for it. Codex auto-compacts its own context.",
        harnessId: CODEX_APPSERVER_HARNESS_ID,
      });
    },

    doSuspendTurn: async () => {
      if (stopped) {
        throw new Error(
          `codex app-server session ${sessionId} is stopped; cannot suspend.`,
        );
      }
      stopped = true;
      // Freeze the host at a precise cursor WITHOUT stopping the model turn:
      // the bridge keeps running and accumulates events for the next slice.
      // This is what lets a turn pause on a human approval for as long as the
      // human takes.
      const lastSeenEventId = await channel.suspend();
      const payload: HarnessV1ContinueTurnState = {
        type: "continue-turn",
        harnessId: CODEX_APPSERVER_HARNESS_ID,
        specificationVersion: "harness-v1",
        data: lifecycleData({
          port: input.bridgePort,
          token: input.bridgeToken,
          lastSeenEventId,
        }) as HarnessV1ContinueTurnState["data"],
      };
      return payload;
    },

    doDetach: async () => {
      if (stopped) {
        throw new Error(
          `codex app-server session ${sessionId} is already stopped; cannot detach.`,
        );
      }
      stopped = true;
      const lastSeenEventId = await channel.suspend();
      const payload: HarnessV1ResumeSessionState = {
        type: "resume-session",
        harnessId: CODEX_APPSERVER_HARNESS_ID,
        specificationVersion: "harness-v1",
        data: lifecycleData({
          port: input.bridgePort,
          token: input.bridgeToken,
          lastSeenEventId,
        }) as HarnessV1ResumeSessionState["data"],
      };
      return payload;
    },

    doStop: async () => {
      if (stopped) {
        throw new Error(
          `codex app-server session ${sessionId} is already stopped; cannot stop.`,
        );
      }
      stopped = true;
      // Tell the channel we are tearing down, so the bridge's post-stop socket
      // close finalises instead of looking like a drop worth reconnecting to.
      channel.beginClose();
      /*
       * A closed channel has nobody to acknowledge `stop`. Synthesizing an
       * empty payload loses `threadId` — the next turn starts a fresh Codex
       * thread on the preserved workdir rather than resuming the conversation
       * inside Codex — but being able to continue at all beats throwing here.
       */
      const data: unknown = channel.isClosed()
        ? {}
        : await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              unsubscribe();
              reject(
                new Error(
                  `codex app-server session ${sessionId} did not reply to stop within 5s.`,
                ),
              );
            }, 5_000);
            timer.unref?.();
            const unsubscribe = channel.on("bridge-stop", (message) => {
              clearTimeout(timer);
              unsubscribe();
              resolve(message.data);
            });
            try {
              channel.send({ type: "stop" } as InboundMessage);
            } catch (error) {
              clearTimeout(timer);
              unsubscribe();
              reject(error);
            }
          });
      await settleProcess();
      channel.close();
      const merged =
        data != null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      const payload: HarnessV1ResumeSessionState = {
        type: "resume-session",
        harnessId: CODEX_APPSERVER_HARNESS_ID,
        specificationVersion: "harness-v1",
        data: {
          ...merged,
          ...lifecycleData(null),
        } as HarnessV1ResumeSessionState["data"],
      };
      return payload;
    },

    doDestroy: async () => {
      if (stopped) return;
      stopped = true;
      channel.beginClose();
      try {
        if (!channel.isClosed()) {
          channel.send({ type: "destroy" } as InboundMessage);
        }
      } catch {
        // Best-effort: the box is torn down after this either way.
      }
      await settleProcess();
      channel.close();
    },
  };
}
