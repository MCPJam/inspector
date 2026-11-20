/**
 * One turn of Claude web or ChatGPT web.
 *
 * Resolve the project's web account and a connector per server, open a turn
 * window on each connector whose `approve` hook is this turn's approval
 * policy (E3: MCPJam's gate decides every call the vendor's client sends),
 * drive the vendor's page, and close every window in a finally. The reply
 * comes from the vendor's saved conversation and the tool calls from the
 * forwarding endpoint's ledger (`webClientToolCallLedger.forTurn`).
 *
 * A page that cannot be driven is a failure of the RUN, typed by the page
 * module, and never a verdict on the project's server, which was not
 * measured. Each turn opens a new chat, so an eval iteration never inherits
 * the last one's conversation.
 */
import { randomUUID } from "node:crypto";
import {
  SYNTHETIC_SESSION_APPROVAL_DENIAL,
  type TurnApprovalPolicy,
} from "@/shared/tool-approval";
import {
  WEB_CLIENT_SITES,
  webClientVendorForRuntime,
  webConnectorPath,
  type WebClientRuntimeId,
  type WebConnectorAuth,
} from "@/shared/web-clients";
import { chatgptWebPageModule } from "../../utils/harness/real-ui/chatgpt-web.js";
import { claudeWebPageModule } from "../../utils/harness/real-ui/claude-web.js";
import {
  driveRealUiTurn,
  type RealUiTurnResult,
} from "../../utils/harness/real-ui/drive-turn.js";
import {
  RealUiError,
  type PendingStep,
  type RealUiFailure,
  type RealUiPageModule,
} from "../../utils/harness/real-ui/page-module.js";
import { logger } from "../../utils/logger.js";
import {
  webClientToolCallLedger,
  type ToolCallLedger,
} from "./tool-call-ledger.js";
import {
  TurnWindowConflictError,
  webClientTurnWindows,
  type ApprovalDecision,
  type ToolCallRequest,
  type TurnWindowStore,
} from "./turn-windows.js";
import type { WebClientEnvironment } from "./web-client-environment.js";
import { matchWebToolCalls, type WebToolCall } from "./web-client-trace.js";

/** The approval this turn applies, from the turn's policy (`turnApprovalPolicy`). */
export type WebTurnApproval = {
  /** The host's switch as the turn's origin applies it (`appliedToolApproval`). */
  requireToolApproval: boolean;
  answer: TurnApprovalPolicy["answer"];
  /** Asks the person, where the turn has one to ask. */
  askPerson?: (call: ToolCallRequest) => Promise<ApprovalDecision>;
};

export type WebClientTurnInput = {
  runtimeId: WebClientRuntimeId;
  projectId: string;
  serverIds: readonly string[];
  prompt: string;
  runId: string;
  turnId?: string;
  approval: WebTurnApproval;
  environment: WebClientEnvironment;
  connectorAuth?: WebConnectorAuth;
  signal?: AbortSignal;
  /** Process defaults unless a test or a durable store supplies its own. */
  turnWindows?: TurnWindowStore;
  ledger?: ToolCallLedger;
  pageModule?: RealUiPageModule;
  stepTimeoutMs?: number;
  replyTimeoutMs?: number;
  /** How long the turn waits for a connector another turn is using. */
  connectorWaitMs?: number;
  connectorPollMs?: number;
};

/**
 * One turn at a time per connector: the endpoint attributes each call to the
 * connector's open turn. Runs that share an account and a server (compared
 * runs, Playground panes) take turns rather than failing the later one.
 */
const CONNECTOR_WAIT_MS = 10 * 60_000;
const CONNECTOR_POLL_MS = 2_000;

/** Another turn holds the connector, here or on another replica. */
function connectorBusy(error: unknown): boolean {
  return (
    error instanceof TurnWindowConflictError ||
    (error instanceof RealUiError && error.failure.kind === "turn_running")
  );
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export type WebClientTurnResult =
  | {
      ok: true;
      turnId: string;
      startedAt: number;
      endedAt: number;
      page: RealUiTurnResult;
      toolCalls: WebToolCall[];
    }
  | {
      ok: false;
      turnId: string;
      startedAt: number;
      endedAt: number;
      /** Always the run's: the server was not measured. */
      infrastructure: true;
      failure: RealUiFailure;
      pendingStep?: PendingStep;
      /** What reached the server before the run stopped. */
      toolCalls: WebToolCall[];
    };

const PAGE_MODULES: Record<WebClientRuntimeId, RealUiPageModule> = {
  "claude-web": claudeWebPageModule,
  "chatgpt-web": chatgptWebPageModule,
};

/** The turn's approval gate as the forwarding endpoint calls it. */
export function webTurnApprover(
  approval: WebTurnApproval,
): (call: ToolCallRequest) => Promise<ApprovalDecision> {
  return async (call) => {
    // An MCP server's tools sit at the `setting` floor: the switch decides.
    if (!approval.requireToolApproval) return { allow: true };
    if (approval.answer === "deny") {
      return { allow: false, reason: SYNTHETIC_SESSION_APPROVAL_DENIAL };
    }
    if (approval.askPerson) return approval.askPerson(call);
    return {
      allow: false,
      reason: "This tool call needs a person's approval, and nobody can answer during this run.",
    };
  };
}

/** MCPJam's own name for the connector it adds, so it never touches another. */
export function webConnectorName(serverId: string): string {
  return `MCPJam ${serverId.slice(0, 24)}`;
}

export async function runWebClientTurn(
  input: WebClientTurnInput,
): Promise<WebClientTurnResult> {
  const vendor = webClientVendorForRuntime(input.runtimeId);
  if (!vendor) throw new Error(`Not a web client runtime: ${input.runtimeId}`);
  const windows = input.turnWindows ?? webClientTurnWindows;
  const ledger = input.ledger ?? webClientToolCallLedger;
  const env = input.environment;
  const module = input.pageModule ?? env.pageModule ?? PAGE_MODULES[input.runtimeId];
  const turnId = input.turnId ?? randomUUID();
  const startedAt = Date.now();
  const serverOfConnector = new Map<string, string>();
  const opened: string[] = [];
  let browser: Awaited<ReturnType<WebClientEnvironment["openBrowser"]>> | undefined;
  let webAccountId: string | undefined;
  const wireCalls = (conversation: Parameters<typeof matchWebToolCalls>[0]["conversation"]) =>
    matchWebToolCalls({
      wire: ledger.forTurn(turnId),
      conversation,
      serverOfConnector: (connectorId) => serverOfConnector.get(connectorId),
    });
  try {
    const account = await env.resolveAccount({ projectId: input.projectId, vendor });
    webAccountId = account.webAccountId;
    const connectors: Array<{ name: string; url: string }> = [];
    for (const serverId of input.serverIds) {
      const { connectorId } = await env.ensureConnector({
        projectId: input.projectId,
        webAccountId: account.webAccountId,
        serverId,
        auth: input.connectorAuth ?? "oauth",
      });
      serverOfConnector.set(connectorId, serverId);
      connectors.push({
        name: webConnectorName(serverId),
        url: new URL(webConnectorPath(connectorId), env.publicBaseUrl).href,
      });
    }
    await openWindows(webTurnApprover(input.approval));
    browser = await env.openBrowser({
      webAccountId: account.webAccountId,
      sites: module.sites.length ? module.sites : WEB_CLIENT_SITES[vendor],
    });
    const page = await driveRealUiTurn({
      module,
      driver: browser.driver,
      connectors,
      prompt: input.prompt,
      journal: env.journal,
      turnKey: turnId,
      ...(account.accountEmail ? { expectedEmail: account.accountEmail } : {}),
      ...(input.stepTimeoutMs ? { stepTimeoutMs: input.stepTimeoutMs } : {}),
      ...(input.replyTimeoutMs ? { replyTimeoutMs: input.replyTimeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await closeAll();
    await env.onOutcome?.({ ok: true, webAccountId: account.webAccountId, account: page.account });
    return {
      ok: true,
      turnId,
      startedAt,
      endedAt: Date.now(),
      page,
      toolCalls: wireCalls(page.conversation.toolCalls),
    };
  } catch (error) {
    if (!(error instanceof RealUiError)) throw error;
    logger.warn("[web-clients] turn stopped", {
      runtimeId: input.runtimeId,
      kind: error.failure.kind,
      step: error.failure.step,
    });
    await closeAll();
    if (webAccountId) {
      await env.onOutcome?.({
        ok: false,
        webAccountId,
        failure: error.failure,
        ...(error.pendingStep ? { pendingStep: error.pendingStep } : {}),
      });
    }
    return {
      ok: false,
      turnId,
      startedAt,
      endedAt: Date.now(),
      infrastructure: true,
      failure: error.failure,
      ...(error.pendingStep ? { pendingStep: error.pendingStep } : {}),
      toolCalls: wireCalls([]),
    };
  } finally {
    await closeAll();
  }

  /**
   * Opens the turn's window on every connector, or none: while another turn
   * holds one, this turn lets go of all it took, waits, and tries again.
   * Taking them in one order, and never holding one while waiting, means two
   * turns can't each wait on the other.
   */
  async function openWindows(approve: ReturnType<typeof webTurnApprover>) {
    const deadline = Date.now() + (input.connectorWaitMs ?? CONNECTOR_WAIT_MS);
    const connectorIds = [...serverOfConnector.keys()].sort();
    for (;;) {
      try {
        for (const connectorId of connectorIds) {
          windows.open({ connectorId, runId: input.runId, turnId, approve });
          opened.push(connectorId);
          await env.turnGate?.open({ connectorId, runId: input.runId, turnId });
        }
        return;
      } catch (error) {
        if (!connectorBusy(error)) throw error;
        await closeWindows();
        if (Date.now() >= deadline || input.signal?.aborted) {
          throw new RealUiError({
            kind: "turn_running",
            step: "connector",
            message: "Another run is still using this connector.",
          });
        }
        await pause(input.connectorPollMs ?? CONNECTOR_POLL_MS, input.signal);
      }
    }
  }

  async function closeWindows() {
    const closing = opened.splice(0);
    for (const connectorId of closing) {
      if (windows.active(connectorId)?.turnId === turnId) windows.close(turnId);
    }
    if (closing.length > 0) await env.turnGate?.close(turnId);
  }

  /** Closes this turn's windows and browser once, whichever way it ended. */
  async function closeAll() {
    await closeWindows();
    const open = browser;
    browser = undefined;
    await open?.close();
  }
}
