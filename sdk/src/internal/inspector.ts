/**
 * Node-only engine that finds, starts, attaches to and stops a local MCPJam
 * Inspector: health and frontend probes, the session token read from the
 * owner-only `~/.mcpjam/inspector/<port>.json` discovery file, and the
 * detached start. Shared by the CLI and `@mcpjam/inspector`. Published as
 * `@mcpjam/sdk/internal/inspector` with no public API promise.
 */
export {
  ensureInspector,
  ensureInspectorBackend,
  stopInspector,
  type EnsureInspectorBackendOptions,
  type EnsureInspectorBackendResult,
  type EnsureInspectorOptions,
  type EnsureInspectorResult,
  type InspectorStartOptions,
} from "./inspector/ensure.js";
export { InspectorError, isInspectorError } from "./inspector/errors.js";
export { resolveInspectorBrowserBaseUrl } from "./inspector/frontend.js";
export { delay, getNpxExecutable } from "./inspector/launch.js";
export {
  clearInspectorSessionTokenCache,
  fetchInspectorSessionToken,
  isAuthFailure,
} from "./inspector/session-token.js";
export {
  buildInspectorAccessUrl,
  buildInspectorBrowserUrl,
  normalizeInspectorBaseUrl,
  normalizeInspectorFrontendUrl,
} from "./inspector/urls.js";
