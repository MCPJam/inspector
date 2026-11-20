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
import type { WebClientVendor, WebConnectorAuth } from "@/shared/web-clients";
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

export interface WebClientEnvironment {
  /** The public origin the vendor's app reaches `/mcp/<connectorId>` on. */
  readonly publicBaseUrl: string;
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
  /** A browser on the account's profile, kept to `sites`. Closed by the turn. */
  openBrowser(args: {
    webAccountId: string;
    sites: readonly string[];
  }): Promise<{ driver: PageDriver; close(): Promise<void> }>;
  /** Records how the turn ended on the account, after the browser closed. */
  onOutcome?(outcome: WebTurnOutcome): Promise<void>;
  /**
   * The durable turn gate, for a deployment with more than one replica: a
   * call that lands on another replica still finds its turn.
   */
  turnGate?: {
    open(window: { connectorId: string; runId: string; turnId: string }): Promise<void>;
    close(turnId: string): Promise<void>;
  };
}

let configured: WebClientEnvironment | undefined;

/** Set once at startup (hosted, local Inspector) or by a test. */
export function setWebClientEnvironment(
  environment: WebClientEnvironment | undefined,
): void {
  configured = environment;
}

export function webClientEnvironment(): WebClientEnvironment | undefined {
  return configured;
}
