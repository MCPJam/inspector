/**
 * A web client on a local Inspector. The browser is Playwright on this
 * machine, on a persistent profile the person signed in to by hand. Each
 * server is reached through a capability connector in this process's local
 * registry (the forwarding endpoint reads the same one). The vendor's app
 * dials them through the person's HTTPS tunnel.
 *
 * There is no backend here: no saved profiles, no durable turn gate and no
 * account status. The profile on disk is the account.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { HttpServerConfig, MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import type { Page } from "playwright";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  webClientVendorForRuntime,
  type WebClientVendor,
} from "@/shared/web-clients";
import { configuredInspectorPublicUrl } from "../../utils/inspector-public-url.js";
import { logger } from "../../utils/logger.js";
import { mockTransportOf } from "../../utils/mock-servers.js";
import { isOutsideRepository } from "../../utils/outside-repository.js";
import { createMemorySendJournal } from "../../utils/harness/real-ui/drive-turn.js";
import { RealUiError } from "../../utils/harness/real-ui/page-module.js";
import { createPlaywrightDriver } from "../../utils/harness/real-ui/playwright-driver.js";
import { localWebConnectors, type LocalConnectorRegistry } from "./local-connectors.js";
import { pause } from "./run-web-client-turn.js";
import type {
  WebClientEnvironment,
  WebClientEnvironmentFactory,
} from "./web-client-environment.js";

/** Where this machine keeps a vendor's signed-in profile, outside this repository. */
export function localWebClientProfileDir(
  vendor: WebClientVendor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.MCPJAM_WEB_CLIENTS_PROFILE_DIR?.trim() || join(homedir(), ".mcpjam", "web-clients");
  const profileDir = join(root, `${vendor}-profile`);
  // The profile holds a signed-in session, which a commit must never pick up.
  if (!isOutsideRepository(profileDir)) {
    throw new Error(
      `The ${WEB_CLIENT_DISPLAY_NAMES[vendor]} browser profile is inside this Inspector's repository, where a commit could pick up your sign-in. Set MCPJAM_WEB_CLIENTS_PROFILE_DIR to a folder outside the repository, restart the Inspector, then run again.`,
    );
  }
  return profileDir;
}

export type LaunchLocalBrowser = (
  profileDir: string,
  options: { headless: boolean },
) => Promise<{ page: Page; close(): Promise<void> }>;

const launchPersistent: LaunchLocalBrowser = async (profileDir, options) => {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDir, { headless: options.headless });
  const page = context.pages()[0] ?? (await context.newPage());
  return { page, close: () => context.close() };
};

/** Profiles a turn in this process has open: one browser per profile at a time. */
const openProfiles = new Set<string>();
/**
 * How long a caller that brings no deadline of its own waits for another
 * turn's browser on the same profile: compared runs and panes take turns. A
 * turn brings one, shared with its wait for a busy connector.
 */
const PROFILE_WAIT_MS = 10 * 60_000;
const PROFILE_POLL_MS = 1_000;
/**
 * Chromium refusing a profile another process has open, such as another
 * Inspector's turn or the tracer's sign-in window. Playwright's launch error
 * quotes Chromium's log line for it (`profileInUseError` in its
 * `chromium.ts`), and its call log carries Chromium's profile-in-use exit
 * code when the browser exited first.
 */
const PROFILE_IN_USE =
  /Failed to create a ProcessSingleton for your profile directory|Opening in existing browser session|exitCode=21\b/;
/** Connectors this process registered, so later turns reuse the vendor's saved one. */
const connectorsByUpstream = new Map<string, string>();

/** The server's URL and headers as this Inspector connects to it. */
async function upstreamOf(
  serverId: string,
  config: MCPServerConfig | undefined,
): Promise<{ url: string; headers: Record<string, string> }> {
  if (!config || !("url" in config) || !config.url) {
    throw new Error(
      `${serverId} isn't a server with a URL, so the vendor's app can't reach it. Connect it over HTTP, then run again.`,
    );
  }
  // A mock has no address the vendor's app could reach; this Inspector serves
  // it in process, and the forwarder would dial the placeholder instead.
  if (mockTransportOf(config)) {
    throw new Error(
      `${serverId} is a mock server, which only MCPJam can reach, so the vendor's app can't use it. Run it from Playground, or point the vendor's app at the server the mock is based on.`,
    );
  }
  const headers: Record<string, string> = {};
  new Headers(config.requestInit?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const token = await bearerOf(serverId, config);
  if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
  return { url: String(config.url), headers };
}

/** The token this Inspector currently sends the server, however it holds it. */
async function bearerOf(
  serverId: string,
  config: HttpServerConfig,
): Promise<string | undefined> {
  // The client manager exchanges a refresh token inside its own connection
  // and keeps the access token there. Exchanging it again here would spend a
  // single-use refresh token under that connection, so the server is refused
  // rather than forwarded without its credential.
  if (config.refreshToken?.trim()) {
    throw new Error(
      `${serverId} signs in with a refresh token, so the vendor's app can't use its sign-in. Connect it with an access token, then run again.`,
    );
  }
  if (config.accessToken) return config.accessToken;
  const provider = config.authProvider;
  if (!provider) return undefined;
  if ("token" in provider) return provider.token();
  return (await provider.tokens())?.access_token;
}

export function createLocalWebClientEnvironment(deps: {
  vendor: WebClientVendor;
  publicBaseUrl: string;
  servers?: Pick<MCPClientManager, "getServerConfig">;
  profileDir: string;
  headless: boolean;
  registry?: LocalConnectorRegistry;
  launch?: LaunchLocalBrowser;
  profileWaitMs?: number;
  profilePollMs?: number;
}): WebClientEnvironment {
  const registry = deps.registry ?? localWebConnectors;
  const name = WEB_CLIENT_DISPLAY_NAMES[deps.vendor];
  return {
    publicBaseUrl: deps.publicBaseUrl,
    journal: createMemorySendJournal(),

    async resolveAccount() {
      return { webAccountId: `local:${deps.vendor}` };
    },

    async ensureConnector({ serverId }) {
      const upstream = await upstreamOf(serverId, deps.servers?.getServerConfig(serverId));
      // Not keyed on the headers: a refreshed token updates the connector the
      // vendor's app saved, rather than adding one while the old one keeps
      // forwarding with the old token.
      const key = JSON.stringify([deps.vendor, serverId, upstream.url]);
      const kept = connectorsByUpstream.get(key);
      if (kept && registry.setHeaders(kept, upstream.headers))
        return { connectorId: kept };
      const { connectorId } = registry.register({ upstreamUrl: upstream.url, headers: upstream.headers, serverId });
      connectorsByUpstream.set(key, connectorId);
      return { connectorId };
    },

    async openBrowser({ sites, signal, waitUntil }) {
      const deadline =
        waitUntil ?? Date.now() + (deps.profileWaitMs ?? PROFILE_WAIT_MS);
      const poll = deps.profilePollMs ?? PROFILE_POLL_MS;
      for (let waited = false; ; waited = true) {
        // A stopped run launches nothing, even once the profile frees.
        signal?.throwIfAborted();
        const expired = Date.now() >= deadline;
        // A profile free at the first look is taken whatever the budget; one
        // that frees while the turn waits, only within it.
        if (!openProfiles.has(deps.profileDir) && !(waited && expired)) break;
        if (expired) {
          throw new RealUiError({
            kind: "turn_running",
            step: "connector",
            message: `Another turn is using this machine's ${name} browser.`,
          });
        }
        // A pause never runs past the deadline.
        await pause(Math.min(poll, Math.max(0, deadline - Date.now())), signal);
      }
      openProfiles.add(deps.profileDir);
      let launched: Awaited<ReturnType<LaunchLocalBrowser>> | undefined;
      try {
        const browser = await (deps.launch ?? launchPersistent)(deps.profileDir, { headless: deps.headless });
        launched = browser;
        return {
          driver: await createPlaywrightDriver(browser.page, { sites }),
          async close() {
            try {
              await browser.close();
            } finally {
              openProfiles.delete(deps.profileDir);
            }
          },
        };
      } catch (error) {
        // A browser that launched but couldn't be driven still has the profile
        // open, so it closes before another turn may open the profile.
        await launched?.close().catch((closeError: unknown) => {
          logger.warn("[web-clients] a local browser that failed to start did not close", {
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        });
        openProfiles.delete(deps.profileDir);
        if (
          !launched &&
          error instanceof Error &&
          PROFILE_IN_USE.test(error.message)
        ) {
          throw new RealUiError({
            kind: "turn_running",
            step: "connector",
            message: `Another Inspector or a sign-in window has this machine's ${name} browser open.`,
          });
        }
        throw error;
      }
    },
  };
}

/**
 * The local Inspector's per-turn environment. The vendor's app reaches the
 * connectors only over public HTTPS, so a turn without a tunnel URL stops
 * before it opens a browser.
 */
export function createLocalWebClientEnvironmentFactory(
  options: { env?: NodeJS.ProcessEnv; registry?: LocalConnectorRegistry; launch?: LaunchLocalBrowser } = {},
): WebClientEnvironmentFactory {
  const env = options.env ?? process.env;
  return async (turn) => {
    const vendor = webClientVendorForRuntime(turn.runtimeId);
    if (!vendor) throw new Error(`Not a web client runtime: ${turn.runtimeId}`);
    const publicBaseUrl = configuredInspectorPublicUrl(env);
    if (!publicBaseUrl?.startsWith("https://")) {
      throw new Error(
        "The vendor's app can't reach this Inspector: it has no public HTTPS address. Start a tunnel to this Inspector's port, set MCPJAM_INSPECTOR_PUBLIC_URL to the tunnel's HTTPS URL, restart the Inspector, then run again.",
      );
    }
    return createLocalWebClientEnvironment({
      vendor,
      publicBaseUrl,
      ...(turn.mcpClientManager ? { servers: turn.mcpClientManager } : {}),
      profileDir: localWebClientProfileDir(vendor, env),
      headless: env.MCPJAM_WEB_CLIENTS_HEADLESS?.trim() === "true",
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.launch ? { launch: options.launch } : {}),
    });
  };
}
