/**
 * What a web client turn needs from where it runs: the project's web account,
 * a connector per server, a browser signed in to the account, the public URL
 * the vendor's app reaches the forwarding endpoint on, and a send journal.
 *
 * Hosted, these come from the backend (web accounts, connectors, the saved
 * browser profile) and the hosted browser. On a person's laptop and in tests
 * they are local: a static connector set, a Playwright browser on a
 * persistent profile, a tunnel URL. The turn reads only this interface.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import type { WebClientVendor, WebConnectorAuth } from "@/shared/web-clients";
import { HOSTED_MODE } from "../../config.js";
import type { SendJournal } from "../../utils/harness/real-ui/drive-turn.js";
import type { PageDriver } from "../../utils/harness/real-ui/page-driver.js";
import type {
  PendingStep,
  RealUiFailure,
  RealUiPageModule,
  WebAccountIdentity,
} from "../../utils/harness/real-ui/page-module.js";

/** How a turn ended, for the account's status and for recovery. */
export type WebTurnOutcome =
  | { ok: true; webAccountId: string; account: WebAccountIdentity }
  | {
      ok: false;
      webAccountId: string;
      failure: RealUiFailure;
      pendingStep?: PendingStep;
    };

export type ResolvedWebAccount = {
  webAccountId: string;
  /** The email the project saved for the account, checked before any send. */
  accountEmail?: string;
};

/** The MCPJam person a hosted turn acts as, as the backend's service calls name them. */
export type WebRunActor = { actorExternalId: string } | { actorUserId: string };

export interface WebClientEnvironment {
  /** The public origin the vendor's app reaches `/mcp/<connectorId>` on. */
  readonly publicBaseUrl: string;
  /** Who the turn acts as where the backend keeps the accounts; recovery acts as them too. */
  readonly actor?: WebRunActor;
  readonly journal: SendJournal;
  /** Replaces the vendor's page module, for the fixture vendor in tests. */
  readonly pageModule?: RealUiPageModule;
  resolveAccount(args: {
    projectId: string;
    vendor: WebClientVendor;
  }): Promise<ResolvedWebAccount>;
  ensureConnector(args: {
    projectId: string;
    webAccountId: string;
    serverId: string;
    auth: WebConnectorAuth;
  }): Promise<{ connectorId: string }>;
  /**
   * A browser on the account's profile, kept to `sites`. Closed by the turn.
   * A wait for a profile another turn has open ends when `signal` stops the run.
   * `waitUntil` is the turn's one deadline for all its waits, so the wait
   * for a profile gets only what the wait for a connector left of it.
   */
  openBrowser(args: {
    webAccountId: string;
    sites: readonly string[];
    signal?: AbortSignal;
    waitUntil?: number;
  }): Promise<{ driver: PageDriver; close(): Promise<void> }>;
  /** Records how the turn ended on the account, after the browser closed. */
  onOutcome?(outcome: WebTurnOutcome): Promise<void>;
  /**
   * The saved profile version `openBrowser` restored for the account, so
   * recovery can tell a sign-in that lapsed from one replaced since.
   */
  restoredProfileVersion?(webAccountId: string): number | undefined;
  /**
   * The durable turn gate, for a deployment with more than one replica: a
   * call that lands on another replica still finds its turn.
   */
  turnGate?: {
    open(window: { connectorId: string; runId: string; turnId: string }): Promise<void>;
    close(turnId: string): Promise<void>;
  };
}

/** What a turn tells a per-turn environment about itself. */
export type WebTurnContext = {
  runtimeId: "claude-web" | "chatgpt-web";
  projectId: string;
  runId: string;
  iterationId?: string;
  chatSessionId?: string;
  /** The request's MCPJam bearer, when a person started the run. */
  bearer?: string;
  /** The run's owner, for a run started with nobody signed in. */
  actor?: WebRunActor;
  /** The run's frozen accounts, in the order this turn tries them. */
  runWebAccountIds?: readonly string[];
  /** How this Inspector reaches each server, for a local connector. */
  mcpClientManager?: Pick<MCPClientManager, "getServerConfig">;
};

/** Hosted runs build their environment per turn: who to act as, which chat. */
export type WebClientEnvironmentFactory = (
  turn: WebTurnContext,
) => Promise<WebClientEnvironment>;

/**
 * Whether this server's turns run hosted, on the backend's accounts, rather
 * than on this machine's profiles. The mount sets up the environment by it
 * and a swarm takes its accounts by it, so a swarm session always holds the
 * account its turns run on, whatever credentials the server also has.
 */
export function webClientTurnsRunHosted(): boolean {
  return HOSTED_MODE;
}

let configured: WebClientEnvironment | WebClientEnvironmentFactory | undefined;

/** Set once at startup (hosted, local Inspector) or by a test. */
export function setWebClientEnvironment(
  environment: WebClientEnvironment | WebClientEnvironmentFactory | undefined,
): void {
  configured = environment;
}

/** This turn's environment, or undefined when this server has none. */
export async function webClientEnvironmentFor(
  turn: WebTurnContext,
): Promise<WebClientEnvironment | undefined> {
  return typeof configured === "function" ? configured(turn) : configured;
}
