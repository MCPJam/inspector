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
import { createHash, randomUUID } from "node:crypto";
import {
  decideToolPolicyFromSnapshot,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
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
import {
  HARNESS_POLICY_BLOCK_TEXT_PREFIX,
  type HarnessPolicyBlockRecord,
} from "../../utils/harness/harness-proxy-policy-enforcement.js";
import { chatgptWebPageModule } from "../../utils/harness/real-ui/chatgpt-web.js";
import {
  MCPJAM_CONNECTOR_PREFIX,
  claudeWebPageModule,
} from "../../utils/harness/real-ui/claude-web.js";
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
import type { WebClientEnvironment, WebTurnOutcome } from "./web-client-environment.js";
import { matchWebToolCalls, type WebToolCall } from "./web-client-trace.js";

/** The approval this turn applies, from the turn's policy (`turnApprovalPolicy`). */
export type WebTurnApproval = {
  /** The host's switch as the turn's origin applies it (`appliedToolApproval`). */
  requireToolApproval: boolean;
  answer: TurnApprovalPolicy["answer"];
};

/** The run's sealed tool policy by server id (`harnessToolPolicy`), and where its refusals go. */
export type WebTurnToolPolicy = {
  snapshots: Readonly<Record<string, ToolPolicySnapshot>>;
  onBlock?: (block: HarnessPolicyBlockRecord) => void;
};

export type WebClientTurnInput = {
  runtimeId: WebClientRuntimeId;
  projectId: string;
  serverIds: readonly string[];
  prompt: string;
  runId: string;
  turnId?: string;
  approval: WebTurnApproval;
  toolPolicy?: WebTurnToolPolicy;
  environment: WebClientEnvironment;
  connectorAuth?: WebConnectorAuth;
  signal?: AbortSignal;
  /** Process defaults unless a test or a durable store supplies its own. */
  turnWindows?: TurnWindowStore;
  ledger?: ToolCallLedger;
  pageModule?: RealUiPageModule;
  stepTimeoutMs?: number;
  replyTimeoutMs?: number;
};

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

/** A call on a connector the turn can't place under a server has no decision. */
const NO_DECISION: ToolPolicySnapshot = { mode: "default", denied: {}, known: [], unknownTool: "deny" };

/**
 * The turn's approval gate as the forwarding endpoint calls it. The run's
 * tool policy decides first, whatever the switch says, by the lookup the
 * harness proxy makes, and a refusal reads as the proxy's does.
 */
export function webTurnApprover(
  approval: WebTurnApproval,
  policy?: WebTurnToolPolicy & { serverOf: (connectorId: string) => string | undefined },
): (call: ToolCallRequest) => Promise<ApprovalDecision> {
  return async (call) => {
    if (policy) {
      const serverId = policy.serverOf(call.connectorId);
      const snapshot =
        serverId === undefined
          ? NO_DECISION
          : Object.hasOwn(policy.snapshots, serverId)
            ? policy.snapshots[serverId]
            : undefined;
      const decided = snapshot && decideToolPolicyFromSnapshot({ snapshot, toolName: call.toolName });
      if (decided && !decided.allowed) {
        policy.onBlock?.({
          toolName: call.toolName,
          reason: decided.reason,
          classification: decided.classification,
          at: Date.now(),
          // The grade leaves a refused call out by this id. ChatGPT sends
          // none, so the refusal names the call, and the transcript's call
          // takes the same id (`matchWebToolCalls`).
          toolCallId: call.toolUseId ?? `web-blocked-${randomUUID()}`,
          ...(serverId ? { serverId } : {}),
        });
        return { allow: false, reason: `${HARNESS_POLICY_BLOCK_TEXT_PREFIX}${decided.reason}` };
      }
    }
    // An MCP server's tools sit at the `setting` floor: the switch decides.
    if (!approval.requireToolApproval) return { allow: true };
    if (approval.answer === "deny") {
      return { allow: false, reason: SYNTHETIC_SESSION_APPROVAL_DENIAL };
    }
    return {
      allow: false,
      reason: "This tool call needs a person's approval, and nobody can answer during this run.",
    };
  };
}

/**
 * MCPJam's own name for the connector it adds, so it never touches another.
 * The vendors find a connector by name, so a short hash keeps two servers
 * whose names start alike apart, and the name stays within 31 characters.
 */
export function webConnectorName(serverId: string): string {
  const hash = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
  return [MCPJAM_CONNECTOR_PREFIX, serverId.slice(0, 15).trim(), hash].filter(Boolean).join(" ");
}

/**
 * Takes the turn's connector URLs and ids out of a failure. A capability
 * connector's id is its credential, and a browser error quotes the value it
 * was typing. In place, so a caller that branches on the error's type still
 * can, and in the stack too, which loggers print.
 */
function redactConnectors(error: unknown, connectorIds: Iterable<string>, publicBaseUrl: string): void {
  if (!(error instanceof Error)) return;
  const marks: Array<[secret: string, mark: string]> = [];
  for (const id of connectorIds) {
    const path = webConnectorPath(id);
    if (URL.canParse(path, publicBaseUrl)) marks.push([new URL(path, publicBaseUrl).href, "[connector URL]"]);
    marks.push([encodeURIComponent(id), "[connector id]"], [id, "[connector id]"]);
  }
  const redact = (text: string) =>
    marks.reduce((out, [secret, mark]) => (secret ? out.split(secret).join(mark) : out), text);
  error.message = redact(error.message);
  if (typeof error.stack === "string") error.stack = redact(error.stack);
  if (error instanceof RealUiError) error.failure.message = redact(error.failure.message);
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
  const blocked: HarnessPolicyBlockRecord[] = [];
  const wireCalls = (conversation: Parameters<typeof matchWebToolCalls>[0]["conversation"]) =>
    matchWebToolCalls({
      wire: ledger.forTurn(turnId),
      conversation,
      serverOfConnector: (connectorId) => serverOfConnector.get(connectorId),
      blocked,
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
    const approve = webTurnApprover(
      input.approval,
      input.toolPolicy && {
        ...input.toolPolicy,
        serverOf: (id) => serverOfConnector.get(id),
        onBlock: (block) => {
          blocked.push(block);
          input.toolPolicy?.onBlock?.(block);
        },
      },
    );
    for (const connectorId of serverOfConnector.keys()) {
      try {
        windows.open({ connectorId, runId: input.runId, turnId, approve });
      } catch (error) {
        // One turn at a time per connector: the endpoint attributes each call
        // to the connector's open turn. Another run holding it stops this one
        // as the run's failure, never the server's.
        if (!(error instanceof TurnWindowConflictError)) throw error;
        throw new RealUiError({
          kind: "turn_running",
          step: "connector",
          message: "Another run is already using this connector.",
        });
      }
      opened.push(connectorId);
      await env.turnGate?.open({ connectorId, runId: input.runId, turnId });
    }
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
    await report({ ok: true, webAccountId: account.webAccountId, account: page.account });
    return {
      ok: true,
      turnId,
      startedAt,
      endedAt: Date.now(),
      page,
      toolCalls: wireCalls(page.conversation.toolCalls),
    };
  } catch (error) {
    redactConnectors(error, serverOfConnector.keys(), env.publicBaseUrl);
    if (!(error instanceof RealUiError)) throw error;
    logger.warn("[web-clients] turn stopped", {
      runtimeId: input.runtimeId,
      kind: error.failure.kind,
      step: error.failure.step,
    });
    try {
      await closeAll();
    } finally {
      // A durable close that fails is retried below; the account still
      // hears how the turn ended.
      if (webAccountId) {
        await report({
          ok: false,
          webAccountId,
          failure: error.failure,
          ...(error.pendingStep ? { pendingStep: error.pendingStep } : {}),
        });
      }
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
   * Closes this turn's windows and browser, whichever way it ended. A durable
   * close that fails stays pending so the next call retries it, and the
   * browser closes either way.
   */
  async function closeAll() {
    for (const connectorId of opened) {
      if (windows.active(connectorId)?.turnId === turnId) windows.close(turnId);
    }
    const open = browser;
    browser = undefined;
    try {
      if (opened.length > 0) await env.turnGate?.close(turnId);
      opened.length = 0;
    } catch (error) {
      // The turn's own result or error stands: failing a turn that already
      // ran would lose its evidence and make a caller send the prompt again,
      // and a window nobody closes lapses on the backend.
      logger.warn("[web-clients] the turn's durable window did not close", {
        runtimeId: input.runtimeId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await closeBrowser(open);
    }
  }

  /**
   * Records how the turn ended on the account. The turn's result is the
   * evidence, so a report that fails is logged and never replaces it.
   */
  async function report(outcome: WebTurnOutcome) {
    try {
      await env.onOutcome?.(outcome);
    } catch (error) {
      logger.warn("[web-clients] the turn's outcome could not be recorded on the account", {
        runtimeId: input.runtimeId,
        ok: outcome.ok,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The turn's result is the evidence, so a browser that won't close is
   * logged and never thrown in its place.
   */
  async function closeBrowser(open: typeof browser) {
    try {
      await open?.close();
    } catch (error) {
      redactConnectors(error, serverOfConnector.keys(), env.publicBaseUrl);
      logger.warn("[web-clients] the turn's browser did not close", {
        runtimeId: input.runtimeId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
