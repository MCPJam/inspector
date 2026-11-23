/**
 * The Playground's hosted browser, for a web account: a conversation browser
 * (the same durable session the Playground's hosted browser pane attaches
 * to, so a person can take over), kept to the vendor's sites, booted with the
 * account's restored profile when it has one.
 *
 * Commands go straight to the session's browser daemon through the mapper
 * the conversation browser command API uses, so the page module drives it
 * with the same verbs and the same three outcomes. The profile is exported
 * from the same session for save-profile.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  WEB_CLIENT_SITES,
  type WebClientVendor,
} from "@/shared/web-clients";
import type {
  BrowserAgentCommand,
  BrowserAgentResult,
  BrowserAgentSessionPolicy,
} from "@/shared/browser-agent-contract";
import {
  openConversationBrowser,
  provisionConversationBrowser,
} from "../../routes/v1/chat-session-browser.js";
import { createConvexClient } from "../../routes/v1/convex-client.js";
import {
  refusedResult,
  toDaemonAction,
  unknownResult,
} from "../browserd/agent-contract-mapper.js";
import type { SessionClient } from "../browserd/browser-session.js";
import type { BrowserdCommandResponse } from "../browserd/browserd-codec.js";
import { toContractResult } from "../browserd/local/agent-door.js";
import type { BrowserAction } from "../browserd/protocol.js";
import { BrowserSessionService } from "../browserd/session-service.js";
import { logger } from "../../utils/logger.js";
import {
  createHostedPageDriver,
  type BrowserCommandTransport,
} from "../../utils/harness/real-ui/hosted-driver.js";
import { urlOnSites } from "../../utils/harness/real-ui/page-driver.js";
import type { PageDriver } from "../../utils/harness/real-ui/page-driver.js";

/** The only sites a web account's hosted browser may open. */
export function webClientBrowserPolicy(vendor: WebClientVendor): BrowserAgentSessionPolicy {
  return { mode: "allowlist", originAllowlist: [...WEB_CLIENT_SITES[vendor]] };
}

/** One command to the session's daemon, answered in the public contract. */
export function sessionBrowserTransport(args: {
  handle: { client: Pick<SessionClient, "sendCommand">; bootId: string };
  sessionId: string;
  policy: BrowserAgentSessionPolicy;
}): BrowserCommandTransport {
  const toDaemon =(commandId: string, action: BrowserAction) =>
    args.handle.client.sendCommand(
      {
        commandId,
        source: "agent",
        sessionId: args.sessionId,
        actor: { kind: "agent", id: "web-client-runtime" },
        action,
      },
      args.handle.bootId,
    );
  /**
   * Refuses a command unless the page is on the vendor's sites right now.
   * The daemon keeps no allowlist, and a page can leave the sites between
   * commands (a link, a redirect, a person in the pane), so this asks the
   * page where it is; a page it can't place counts as off them.
   */
  const unlessOnSites = async (commandId: string): Promise<BrowserAgentResult | undefined> => {
    let where: BrowserdCommandResponse | undefined;
    try {
      where = await toDaemon(randomUUID(), { kind: "observe", mode: "url" });
    } catch (error) {
      logger.warn("[web-clients] hosted browser page check lost", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // A person holding the browser stops the command as it stopped the check.
    if (where?.status === "lease_blocked") {
      return toContractResult({ response: where, commandId, policy: args.policy }).result;
    }
    const output = where?.status === "ok" && where.result.ok ? where.result.output : undefined;
    const url = (output as { url?: unknown } | undefined)?.url;
    if (typeof url === "string" && urlOnSites(url, args.policy.originAllowlist ?? [])) return undefined;
    return refusedResult({
      commandId,
      code: "origin_not_allowed",
      message: "The browser couldn't confirm the page is on the vendor's sites, so nothing was sent to it.",
    });
  };
  return async (command: BrowserAgentCommand): Promise<BrowserAgentResult> => {
    const commandId = randomUUID();
    const mapped = toDaemonAction(command);
    if (!mapped.ok) return refusedResult({ commandId, ...mapped.refusal });
    if (
      command.op === "navigate" &&
      !urlOnSites(command.url, args.policy.originAllowlist ?? [])
    ) {
      return refusedResult({
        commandId,
        code: "origin_not_allowed",
        message: "This browser may only open the vendor's own sites.",
      });
    }
    // Anything that could change the page (typing, a key, a click) waits for
    // the page to be seen on the sites. Reading goes ahead, since the result
    // withholds a page off them, and a navigate to a site is the way back.
    if (command.op !== "observe" && command.op !== "navigate") {
      const refused = await unlessOnSites(commandId);
      if (refused) return refused;
    }
    try {
      const response = await toDaemon(commandId, mapped.action);
      return toContractResult({ response, commandId, policy: args.policy }).result;
    } catch (error) {
      // The command may have reached the page: it is never retried here.
      logger.warn("[web-clients] hosted browser command lost", {
        op: command.op,
        error: error instanceof Error ? error.message : String(error),
      });
      return unknownResult({ commandId, reason: "transport" });
    }
  };
}

export type WebClientHostedBrowser = {
  /** The durable session the Playground's hosted browser pane attaches to. */
  browserSessionId: string;
  /** The chat the browser belongs to; the pane's browser token names it. */
  chatSessionId: string;
  driver: PageDriver;
  /** The browser's profile as an archive, for save-profile. */
  exportProfile(): Promise<Uint8Array>;
  /**
   * Closes the hosted session. It never throws: it runs once the outcome is
   * known, and a session that won't close is logged rather than changing it.
   */
  close(): Promise<void>;
};

async function closeHostedSession(args: { bearer: string; projectId: string; sessionId: string }): Promise<void> {
  try {
    await new BrowserSessionService().agentRequest("close", {
      bearer: args.bearer,
      projectId: args.projectId,
      body: { sessionId: args.sessionId },
    });
  } catch (error) {
    logger.warn("[web-clients] a hosted browser did not close", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A chat to own the browser when the caller has none (sign-in, an eval
 * iteration): the same shell the conversation browser API opens.
 */
async function createShellChat(args: {
  bearer: string;
  projectId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const token = args.bearer.replace(/^Bearer\s+/i, "");
  const client = createConvexClient(token);
  const idempotencyKey = `web-client:${randomUUID()}`;
  const lease = (await client.mutation(
    "chatSessions:claimTurnLease" as never,
    {
      newSession: { projectId: args.projectId },
      idempotencyKey,
      requestFingerprint: createHash("sha256").update(idempotencyKey).digest("hex"),
    } as never,
  )) as { status: string; turnId?: string; executionOwnerToken?: string };
  if (lease.status !== "claimed" || !lease.executionOwnerToken) {
    throw new Error("A browser for this account could not be started. Try again.");
  }
  try {
    const shell = await new BrowserSessionService().agentRequest<{ chatSessionId: string }>(
      "create_shell",
      {
        bearer: args.bearer,
        projectId: args.projectId,
        body: { turnId: lease.turnId, executionOwnerToken: lease.executionOwnerToken },
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
    return shell.chatSessionId;
  } finally {
    await client.mutation(
      "chatSessions:releaseTurnLease" as never,
      { turnId: lease.turnId, executionOwnerToken: lease.executionOwnerToken } as never,
    );
  }
}

/** Opens (or reattaches) the hosted browser for a web account. */
export async function openWebClientHostedBrowser(args: {
  bearer: string;
  projectId: string;
  vendor: WebClientVendor;
  /** The run's own chat, when it has one; otherwise a new one is made. */
  chatSessionId?: string;
  /** The account's restored profile archive, for a fresh boot. */
  profileArchive?: Uint8Array;
  signal?: AbortSignal;
}): Promise<WebClientHostedBrowser> {
  const bearer = /^Bearer\s/i.test(args.bearer) ? args.bearer : `Bearer ${args.bearer}`;
  const signal = args.signal ?? AbortSignal.timeout(180_000);
  const chatSessionId =
    args.chatSessionId ?? (await createShellChat({ bearer, projectId: args.projectId, signal }));
  const policy = webClientBrowserPolicy(args.vendor);
  const browser = await openConversationBrowser({
    bearer,
    projectId: args.projectId,
    wireUuid: chatSessionId,
    policy,
    signal,
  });
  const close = () => closeHostedSession({ bearer, projectId: args.projectId, sessionId: browser.browserSessionId });
  // The session exists from here: one that never boots is closed, not left
  // open with nobody to close it, and the caller hears why it didn't boot.
  const handle = await provisionConversationBrowser({
    bearer,
    projectId: args.projectId,
    wireUuid: chatSessionId,
    ...(args.profileArchive ? { profileArchive: args.profileArchive } : {}),
    signal,
  }).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  const transport = sessionBrowserTransport({
    handle,
    sessionId: browser.browserSessionId,
    policy,
  });
  return {
    browserSessionId: browser.browserSessionId,
    chatSessionId,
    driver: createHostedPageDriver(transport, { sites: WEB_CLIENT_SITES[args.vendor] }),
    async exportProfile() {
      if (!handle.client.exportProfile) {
        throw new Error("This hosted browser can't export its profile. Start a new sign-in, then save again.");
      }
      return handle.client.exportProfile();
    },
    close,
  };
}
