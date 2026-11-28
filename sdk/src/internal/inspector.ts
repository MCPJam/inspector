/**
 * Node-only engine that finds, starts, attaches to and stops a local MCPJam
 * Inspector: health and frontend probes, the session token read from the
 * owner-only `~/.mcpjam/inspector/<port>.json` discovery file, and the
 * detached start, plus the embed path (`embedInspector`) behind
 * `launchInspector()`: port choice, holder files for shared ownership, and
 * attaching a server to an open tab. Shared by the CLI and `@mcpjam/inspector`. Published as
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
export {
  delay,
  getNpxExecutable,
  npxInvocation,
  type NpxInvocation,
} from "./inspector/launch.js";
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
export {
  embedInspector,
  type EmbedInspectorOptions,
  type EmbeddedInspector,
} from "./inspector/embed.js";
export {
  inspectorAttachId,
  releaseInspectorAttach,
  requestInspectorAttach,
  type InspectorAttachServer,
  type InspectorAttachState,
} from "./inspector/attach-client.js";
export {
  holdInspector,
  inspectorHoldersDir,
  otherInspectorHolders,
} from "./inspector/holders.js";
export {
  DEFAULT_INSPECTOR_PORT,
  PORT_SCAN_WINDOW,
  choosePort,
  isPortFree,
} from "./inspector/ports.js";
