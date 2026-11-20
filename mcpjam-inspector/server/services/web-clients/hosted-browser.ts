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
import { authkitAuthorizationServers } from "./endpoint-auth.js";
import {
  refusedResult,
  toDaemonAction,
  unknownResult,
} from "../browserd/agent-contract-mapper.js";
import type { SessionClient } from "../browserd/browser-session.js";
import { toContractResult } from "../browserd/local/agent-door.js";
import { BrowserSessionService } from "../browserd/session-service.js";
import { logger } from "../../utils/logger.js";
import {
  createHostedPageDriver,
  type BrowserCommandTransport,
} from "../../utils/harness/real-ui/hosted-driver.js";
import { urlOnSites } from "../../utils/harness/real-ui/page-driver.js";
import type { PageDriver } from "../../utils/harness/real-ui/page-driver.js";

/**
 * The only sites a web account's hosted browser may open: the vendor's own,
 * and MCPJam's sign-in page, where the vendor's app sends a person to allow
 * an OAuth connector while it adds one.
 */
export function webClientBrowserPolicy(
  vendor: WebClientVendor,
  mcpjamSignIn: readonly string[] = authkitAuthorizationServers(),
): BrowserAgentSessionPolicy {
  return { mode: "allowlist", originAllowlist: [...new Set([...WEB_CLIENT_SITES[vendor], ...mcpjamSignIn])] };
}

/**
 * Whether the session's daemon reads one element's text, or `undefined` when
 * it didn't say. An older daemon answers that read with the whole page's
 * text, which a page module would take for the element's.
 */
async function daemonReadsElements(
  client: Pick<SessionClient, "status">,
): Promise<boolean | undefined> {
  try {
    const status = await client.status();
    return status.kind === "ok" ? (status.features ?? []).includes("element-text") : undefined;
  } catch (error) {
    logger.warn("[web-clients] hosted browser status unreadable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** One command to the session's daemon, answered in the public contract. */
export function sessionBrowserTransport(args: {
  handle: { client: Pick<SessionClient, "sendCommand" | "status">; bootId: string };
  sessionId: string;
  policy: BrowserAgentSessionPolicy;
}): BrowserCommandTransport {
  let readsElements: boolean | undefined;
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
    if (command.op === "observe" && command.mode === "text" && command.rootSelector !== undefined) {
      readsElements ??= await daemonReadsElements(args.handle.client);
      if (!readsElements) {
        return refusedResult({
          commandId,
          code: "unsupported_target",
          message: "This hosted browser can't read the page yet. Close its browser pane and run again in a minute.",
        });
      }
    }
    try {
      const response = await args.handle.client.sendCommand(
        {
          commandId,
          source: "agent",
          sessionId: args.sessionId,
          actor: { kind: "agent", id: "web-client-runtime" },
          action: mapped.action,
        },
        args.handle.bootId,
      );
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
};

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
  const handle = await provisionConversationBrowser({
    bearer,
    projectId: args.projectId,
    wireUuid: chatSessionId,
    // The account's own session, or a blank profile: never the person's.
    ownProfile: args.profileArchive ? { archive: args.profileArchive } : {},
    signal,
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
  };
}
