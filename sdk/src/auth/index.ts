/**
 * `@mcpjam/sdk/auth` — shared auth primitives for the CLI and (eventually)
 * the MCPJam MCP server. The browser-loopback API-key login path lives only
 * in `login.ts`; everything else here is credential-model agnostic so the
 * MCP server can add an OAuth flow without touching these files.
 */

export {
  AuthError,
  type ApiKeyCredentials,
  type Credentials,
  type LoginOptions,
  type LoginResult,
  type OAuthCredentials,
  type UserInfo,
  type AuthErrorCode,
} from "./types.js";

export {
  clearConfig,
  configExists,
  getProfile,
  readConfig,
  removeProfile,
  resolveConfigDir,
  resolveConfigPath,
  setProfile,
  writeConfig,
  type ConfigFile,
} from "./config-store.js";

export { getCredentials, requireCredentials } from "./credentials.js";

export {
  BackendClient,
  DEFAULT_BACKEND_BASE_URL,
  type BackendClientOptions,
} from "./backend-client.js";

export { loginWithBrowser } from "./login.js";
export { logout } from "./logout.js";
