/**
 * Claude web and ChatGPT web: MCPJam drives the vendor's own website in a
 * browser, and the vendor's own MCP client reaches the project's server
 * through MCPJam's forwarding endpoint. These are separate clients from the
 * Claude and ChatGPT clients that run on Claude Code and Codex.
 */

/** One flag gates the whole effort, in the backend and the app alike. */
export const WEB_CLIENTS_FEATURE_FLAG = "web-clients-enabled" as const;

export const WEB_CLIENT_VENDORS = ["claude", "chatgpt"] as const;
export type WebClientVendor = (typeof WEB_CLIENT_VENDORS)[number];

/** Harness runtime ids. */
export const WEB_CLIENT_RUNTIME_IDS = {
  claude: "claude-web",
  chatgpt: "chatgpt-web",
} as const satisfies Record<WebClientVendor, string>;
export type WebClientRuntimeId =
  (typeof WEB_CLIENT_RUNTIME_IDS)[WebClientVendor];

/** Client template ids. Kept out of the Claude Code and Codex pairings. */
export const WEB_CLIENT_TEMPLATE_IDS = {
  claude: "web-claude",
  chatgpt: "web-chatgpt",
} as const satisfies Record<WebClientVendor, string>;

export const WEB_CLIENT_DISPLAY_NAMES = {
  claude: "Claude web",
  chatgpt: "ChatGPT web",
} as const satisfies Record<WebClientVendor, string>;

/**
 * The only sites the signed-in browser may open for each vendor, besides
 * MCPJam's own sign-in page while a connector is added.
 */
export const WEB_CLIENT_SITES: Record<WebClientVendor, readonly string[]> = {
  claude: ["https://claude.ai"],
  chatgpt: ["https://chatgpt.com", "https://auth.openai.com"],
};

export function webClientVendorForRuntime(
  runtimeId: string | null | undefined,
): WebClientVendor | undefined {
  return WEB_CLIENT_VENDORS.find(
    (vendor) => WEB_CLIENT_RUNTIME_IDS[vendor] === runtimeId,
  );
}

/**
 * Whether a runtime is Claude web or ChatGPT web. Its model access is
 * external-account, like Cursor's, but on a project's web account (a
 * signed-in browser profile), so no organization key or key check applies.
 */
export function isWebClientRuntimeId(
  runtimeId: string | null | undefined,
): runtimeId is WebClientRuntimeId {
  return webClientVendorForRuntime(runtimeId) !== undefined;
}

/**
 * The page module each runtime pins, by the date its selectors were last
 * checked against the live site. MCPJam does not pin the vendor's website, so
 * this is the version a run can be compared by: a run on a newer page module
 * is a different client even when the site did not change.
 */
export const WEB_CLIENT_PAGE_MODULE_VERSIONS = {
  claude: "page-2026-11-20",
  chatgpt: "page-2026-11-20",
} as const satisfies Record<WebClientVendor, string>;

/**
 * The forwarding endpoint lives on a short path. A long path with a key in it
 * never connected from claude.ai in the November spike; a short one did.
 */
export const WEB_CONNECTOR_PATH_PREFIX = "/mcp";

export function webConnectorPath(connectorId: string): string {
  return `${WEB_CONNECTOR_PATH_PREFIX}/${encodeURIComponent(connectorId)}`;
}

/**
 * How the vendor's MCP client proves it may use a connector. `oauth` is the
 * product path, with MCPJam as the authorization server. `capability` treats
 * the unguessable connector id as the credential and exists for internal tests
 * only.
 */
export type WebConnectorAuth = "oauth" | "capability";

/** Status of a project's web account, as the UI shows it. */
export type WebAccountStatus = "ready" | "needs_sign_in" | "checking";
