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
import { createHash } from "node:crypto";
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
import { createMemorySendJournal } from "../../utils/harness/real-ui/drive-turn.js";
import { RealUiError } from "../../utils/harness/real-ui/page-module.js";
import { createPlaywrightDriver } from "../../utils/harness/real-ui/playwright-driver.js";
import { localWebConnectors, type LocalConnectorRegistry } from "./local-connectors.js";
import type {
  WebClientEnvironment,
  WebClientEnvironmentFactory,
} from "./web-client-environment.js";

/** Where this machine keeps a vendor's signed-in profile, outside any checkout. */
export function localWebClientProfileDir(
  vendor: WebClientVendor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.MCPJAM_WEB_CLIENTS_PROFILE_DIR?.trim() || join(homedir(), ".mcpjam", "web-clients");
  return join(root, `${vendor}-profile`);
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
  const headers: Record<string, string> = {};
  new Headers(config.requestInit?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const token = await bearerOf(config);
  if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
  return { url: String(config.url), headers };
}

/** The token this Inspector currently sends the server, however it holds it. */
async function bearerOf(config: HttpServerConfig): Promise<string | undefined> {
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
      const key = createHash("sha256")
        .update(JSON.stringify([deps.vendor, serverId, upstream.url, Object.entries(upstream.headers).sort()]))
        .digest("hex");
      const kept = connectorsByUpstream.get(key);
      if (kept && registry.has(kept)) return { connectorId: kept };
      const { connectorId } = registry.register({ upstreamUrl: upstream.url, headers: upstream.headers, serverId });
      connectorsByUpstream.set(key, connectorId);
      return { connectorId };
    },

    async openBrowser({ sites }) {
      if (openProfiles.has(deps.profileDir)) {
        throw new RealUiError({
          kind: "turn_running",
          step: "connector",
          message: `Another turn is using this machine's ${name} browser.`,
        });
      }
      openProfiles.add(deps.profileDir);
      try {
        const browser = await (deps.launch ?? launchPersistent)(deps.profileDir, { headless: deps.headless });
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
        openProfiles.delete(deps.profileDir);
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
