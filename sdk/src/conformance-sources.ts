/**
 * Where each conformance check comes from: the section of the specification
 * whose requirement the check tests. UIs link a check's row to it, so a
 * failure points at the text it is graded against.
 *
 * WHY ONE LINK PER ERA: the 2026-07-28 revision restructured the spec site
 * (the lifecycle page became versioning and server/discover, transports split
 * into one page per transport, authorization into several pages), so a path
 * does not carry across revisions. Each check names the section in every era
 * it runs in, and {@link conformanceCheckSourceUrl} picks the one for the
 * revision the run negotiated.
 *
 * Browser-safe on purpose: it imports nothing at runtime but the era table,
 * which is itself dependency-free, so a saved or shared report can resolve its
 * links in the browser without the runner graph.
 *
 * Adding a check fails typecheck here, because each record is exhaustive over
 * its suite's id union. A check that tests an MCPJam heuristic rather than a
 * spec requirement says so with `null` instead of a link.
 */

import type { MCPAppsCheckId } from "./apps-conformance/types.js";
import {
  PROTOCOL_VERSION_ERAS,
  type MCPCheckEra,
  type MCPCheckId,
} from "./mcp-conformance/types.js";
import type { OAuthConformanceCheckId } from "./oauth-conformance/types.js";
import type { MCPTasksCheckId } from "./tasks-conformance/types.js";

/** The spec section a check tests, per era it runs in. At least one is set. */
export type ConformanceCheckSource =
  { legacy: string; modern?: string } | { legacy?: string; modern: string };

const LEGACY_SPEC = "https://modelcontextprotocol.io/specification/2025-11-25";
const MODERN_SPEC = "https://modelcontextprotocol.io/specification/2026-07-28";
const APPS_SPEC =
  "https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx";
const TASKS_EXTENSION_SPEC =
  "https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md";
const LEGACY_TASKS_SPEC = `${LEGACY_SPEC}/basic/utilities/tasks`;
const LEGACY_TRANSPORTS = `${LEGACY_SPEC}/basic/transports`;
const MODERN_STREAMABLE_HTTP = `${MODERN_SPEC}/basic/transports/streamable-http`;
const LEGACY_AUTHORIZATION = `${LEGACY_SPEC}/basic/authorization`;
const MODERN_AUTHORIZATION = `${MODERN_SPEC}/basic/authorization`;
const OAUTH_2_RFC = "https://www.rfc-editor.org/rfc/rfc6749";

/** The same section in both eras, where the page and heading did not move. */
function bothEras(path: string): ConformanceCheckSource {
  return { legacy: `${LEGACY_SPEC}${path}`, modern: `${MODERN_SPEC}${path}` };
}

/** A section outside the core spec, the same whatever revision ran. */
function everyEra(url: string): ConformanceCheckSource {
  return { legacy: url, modern: url };
}

/** Protocol suite. Keys follow `MCP_CHECK_IDS` order. */
export const PROTOCOL_CHECK_SOURCES = {
  "server-initialize": {
    legacy: `${LEGACY_SPEC}/basic/lifecycle#initialization`,
  },
  ping: { legacy: `${LEGACY_SPEC}/basic/utilities/ping` },
  "logging-set-level": { legacy: `${LEGACY_SPEC}/server/utilities/logging` },
  "completion-complete": bothEras("/server/utilities/completion"),
  "capabilities-consistent": {
    legacy: `${LEGACY_SPEC}/basic/lifecycle#capability-negotiation`,
    modern: `${MODERN_SPEC}/server/discover`,
  },
  "tools-list": bothEras("/server/tools#listing-tools"),
  "tools-input-schemas-valid": bothEras("/server/tools#tool"),
  "tools-x-mcp-header-declarations-valid": {
    modern: `${MODERN_SPEC}/server/tools#x-mcp-header`,
  },
  "prompts-list": bothEras("/server/prompts#listing-prompts"),
  "resources-list": bothEras("/server/resources#listing-resources"),
  "protocol-invalid-method-error": {
    legacy: `${LEGACY_SPEC}/basic/index#error-responses`,
    modern: `${MODERN_SPEC}/basic/index#error-codes`,
  },
  "localhost-host-rebinding-rejected": {
    legacy: `${LEGACY_TRANSPORTS}#security-warning`,
  },
  "localhost-host-valid-accepted": {
    legacy: `${LEGACY_TRANSPORTS}#security-warning`,
  },
  "server-sse-polling-session": {
    legacy: `${LEGACY_TRANSPORTS}#session-management`,
  },
  "server-accepts-multiple-post-streams": {
    legacy: `${LEGACY_TRANSPORTS}#multiple-connections`,
  },
  "server-sse-streams-functional": {
    legacy: `${LEGACY_TRANSPORTS}#listening-for-messages-from-the-server`,
  },
  "notification-post-accepted": {
    legacy: `${LEGACY_TRANSPORTS}#sending-messages-to-the-server`,
  },
  "get-stream-or-405": {
    legacy: `${LEGACY_TRANSPORTS}#listening-for-messages-from-the-server`,
  },
  "session-id-visible-ascii": {
    legacy: `${LEGACY_TRANSPORTS}#session-management`,
  },
  "post-response-content-type": {
    legacy: `${LEGACY_TRANSPORTS}#sending-messages-to-the-server`,
    modern: `${MODERN_STREAMABLE_HTTP}#sending-messages`,
  },
  "modern-client-handshake": {
    modern: `${MODERN_SPEC}/basic/versioning#protocol-version-negotiation`,
  },
  "modern-server-discover": { modern: `${MODERN_SPEC}/server/discover` },
  "modern-result-type-present": {
    modern: `${MODERN_SPEC}/basic/index#result-responses`,
  },
  "modern-cacheable-result-hints": {
    modern: `${MODERN_SPEC}/server/utilities/caching#cacheable-results`,
  },
  "modern-cache-hint-coverage": {
    modern: `${MODERN_SPEC}/server/utilities/caching#cacheable-results`,
  },
  "modern-cache-hint-values-valid": {
    modern: `${MODERN_SPEC}/server/utilities/caching#cacheable-model`,
  },
  "modern-cache-scope-stable-across-pages": {
    modern: `${MODERN_SPEC}/server/utilities/caching#interaction-with-pagination`,
  },
  "modern-protocol-version-header-mismatch": {
    modern: `${MODERN_STREAMABLE_HTTP}#server-validation`,
  },
  "modern-method-header-mismatch": {
    modern: `${MODERN_STREAMABLE_HTTP}#server-validation`,
  },
  "modern-name-header-mismatch": {
    modern: `${MODERN_STREAMABLE_HTTP}#server-validation`,
  },
  "modern-unsupported-version-error": {
    modern: `${MODERN_SPEC}/basic/versioning#protocol-version-negotiation`,
  },
  "modern-missing-method-header-rejected": {
    modern: `${MODERN_STREAMABLE_HTTP}#standard-request-headers`,
  },
  "modern-header-names-case-insensitive": {
    modern: `${MODERN_STREAMABLE_HTTP}#case-sensitivity`,
  },
  "modern-undeclared-capability-error": {
    modern: `${MODERN_SPEC}/basic/index#error-codes`,
  },
  "modern-no-session-id": {
    modern: `${MODERN_SPEC}/basic/index#statelessness`,
  },
  "modern-removed-methods-not-found": {
    modern: `${MODERN_SPEC}/deprecated#removed`,
  },
  "modern-resource-not-found-invalid-params": {
    modern: `${MODERN_SPEC}/server/resources#error-handling`,
  },
  "modern-resource-read-no-empty-contents": {
    modern: `${MODERN_SPEC}/server/resources#error-handling`,
  },
  "modern-tool-output-schema-conformant": {
    modern: `${MODERN_SPEC}/server/tools#output-schema`,
  },
  "modern-logs-require-log-level": {
    modern: `${MODERN_SPEC}/server/utilities/logging#per-request-log-level`,
  },
  "modern-subscription-ack-precedes-notifications": {
    modern: `${MODERN_SPEC}/basic/patterns/subscriptions#acknowledgment`,
  },
  "modern-subscription-filter-and-tagging": {
    modern: `${MODERN_SPEC}/basic/patterns/subscriptions#notification-filter`,
  },
  "modern-subscription-graceful-close": {
    modern: `${MODERN_SPEC}/basic/patterns/subscriptions#graceful-closure`,
  },
  "wire-schema-valid": bothEras("/schema"),
} as const satisfies Record<MCPCheckId, ConformanceCheckSource>;

/** MCP Apps suite. The extension spec is versioned apart from the core. */
export const APPS_CHECK_SOURCES = {
  "ui-tools-present": everyEra(`${APPS_SPEC}#resource-discovery`),
  "ui-tool-metadata-valid": everyEra(`${APPS_SPEC}#resource-discovery`),
  "ui-tool-input-schema-valid": everyEra(`${APPS_SPEC}#resource-discovery`),
  "ui-listed-resources-valid": everyEra(`${APPS_SPEC}#ui-resource-format`),
  "ui-resources-readable": everyEra(`${APPS_SPEC}#ui-resource-format`),
  "ui-resource-contents-valid": everyEra(`${APPS_SPEC}#ui-resource-format`),
  "ui-resource-meta-valid": everyEra(`${APPS_SPEC}#ui-resource-format`),
} as const satisfies Record<MCPAppsCheckId, ConformanceCheckSource>;

/**
 * Tasks suite. A legacy revision runs tasks on the 2025-11-25 core utility;
 * the 2026-07-28 revision moved them to the tasks extension. Checks that only
 * exist on the extension wire name only that.
 */
export const TASKS_CHECK_SOURCES = {
  "tasks-wire-resolvable": {
    legacy: `${LEGACY_TASKS_SPEC}#capabilities`,
    modern: `${TASKS_EXTENSION_SPEC}#capability-negotiation`,
  },
  "tasks-declaration-hygiene": {
    legacy: `${LEGACY_TASKS_SPEC}#tool-level-negotiation`,
    modern: `${TASKS_EXTENSION_SPEC}#capability-negotiation`,
  },
  "tasks-result-type-discipline": {
    legacy: `${LEGACY_TASKS_SPEC}#creating-tasks`,
    modern: `${TASKS_EXTENSION_SPEC}#polymorphic-results`,
  },
  "tasks-undeclared-creation-refused": {
    modern: `${TASKS_EXTENSION_SPEC}#task-creation`,
  },
  "tasks-undeclared-capability-rejected": {
    modern: `${TASKS_EXTENSION_SPEC}#capability-negotiation`,
  },
  "tasks-ttl-shape": {
    legacy: `${LEGACY_TASKS_SPEC}#ttl-and-resource-management`,
    modern: `${TASKS_EXTENSION_SPEC}#tasks`,
  },
  "tasks-inline-result": {
    legacy: `${LEGACY_TASKS_SPEC}#result-retrieval`,
    modern: `${TASKS_EXTENSION_SPEC}#task-polling`,
  },
  "tasks-mcp-name-routing": {
    modern: `${TASKS_EXTENSION_SPEC}#streamable-http-routing-headers`,
  },
  "tasks-invalid-task-id-rejected": {
    legacy: `${LEGACY_TASKS_SPEC}#protocol-errors`,
    modern: `${TASKS_EXTENSION_SPEC}#protocol-errors`,
  },
  "tasks-status-payload-shape": {
    legacy: `${LEGACY_TASKS_SPEC}#task-status`,
    modern: `${TASKS_EXTENSION_SPEC}#task-status`,
  },
  "tasks-cancel-ack-shape": {
    legacy: `${LEGACY_TASKS_SPEC}#cancelling-tasks`,
    modern: `${TASKS_EXTENSION_SPEC}#task-cancellation`,
  },
  "tasks-update-ack-shape": {
    modern: `${TASKS_EXTENSION_SPEC}#task-update-requests`,
  },
  "tasks-ttl-integer-shape": { modern: `${TASKS_EXTENSION_SPEC}#tasks` },
  "tasks-undeclared-capability-names-requirements": {
    modern: `${TASKS_EXTENSION_SPEC}#protocol-errors`,
  },
} as const satisfies Record<MCPTasksCheckId, ConformanceCheckSource>;

/**
 * OAuth suite. Where MCP defers to OAuth 2.0 itself (client authentication,
 * redirect URI matching at the token endpoint, the token response) the link
 * is the RFC section the check tests. The profile checks grade MCPJam's own
 * identity heuristics, not a spec requirement, so they have no source.
 */
export const OAUTH_CHECK_SOURCES = {
  verify_profile_shape: null,
  verify_profile_stable: null,
  verify_profile_id_opaque: null,
  verify_profile_identity_stable_across_flows: null,
  verify_profile_stable_after_refresh: null,
  oauth_dcr_http_redirect_uri: {
    legacy: `${LEGACY_AUTHORIZATION}#communication-security`,
    modern: `${MODERN_AUTHORIZATION}/client-registration#application-type-and-redirect-uri-constraints`,
  },
  oauth_invalid_client: everyEra(`${OAUTH_2_RFC}#section-5.2`),
  oauth_invalid_authorize_redirect: {
    legacy: `${LEGACY_AUTHORIZATION}#open-redirection`,
    modern: `${MODERN_AUTHORIZATION}/security-considerations#open-redirection`,
  },
  oauth_invalid_token: {
    legacy: `${LEGACY_AUTHORIZATION}#token-handling`,
    modern: `${MODERN_AUTHORIZATION}#token-handling`,
  },
  oauth_invalid_redirect: everyEra(`${OAUTH_2_RFC}#section-4.1.3`),
  oauth_token_format: everyEra(`${OAUTH_2_RFC}#section-5.1`),
  oauth_unauthenticated_challenge: {
    legacy: `${LEGACY_AUTHORIZATION}#protected-resource-metadata-discovery-requirements`,
    modern: `${MODERN_AUTHORIZATION}/authorization-server-discovery#protected-resource-metadata-discovery-requirements`,
  },
  oauth_resource_metadata_challenge: {
    legacy: `${LEGACY_AUTHORIZATION}#protected-resource-metadata-discovery-requirements`,
    modern: `${MODERN_AUTHORIZATION}/authorization-server-discovery#protected-resource-metadata-discovery-requirements`,
  },
  oauth_stale_session_rejection: {
    legacy: `${LEGACY_TRANSPORTS}#session-management`,
  },
} as const satisfies Record<
  OAuthConformanceCheckId,
  ConformanceCheckSource | null
>;

/** Every check id that has a source entry, across all four suites. */
export type ConformanceSourcedCheckId =
  MCPCheckId | MCPAppsCheckId | MCPTasksCheckId | OAuthConformanceCheckId;

/**
 * One table for all suites: check ids do not collide across suites (each
 * suite has its own naming), which `tests/conformance-sources.test.ts`
 * asserts, so a row can resolve its link from its id alone.
 */
export const CONFORMANCE_CHECK_SOURCES: Readonly<
  Record<ConformanceSourcedCheckId, ConformanceCheckSource | null>
> = {
  ...PROTOCOL_CHECK_SOURCES,
  ...APPS_CHECK_SOURCES,
  ...TASKS_CHECK_SOURCES,
  ...OAUTH_CHECK_SOURCES,
};

function eraOf(
  protocolVersion: string | null | undefined
): MCPCheckEra | undefined {
  if (!protocolVersion) return undefined;
  return Object.prototype.hasOwnProperty.call(
    PROTOCOL_VERSION_ERAS,
    protocolVersion
  )
    ? PROTOCOL_VERSION_ERAS[
        protocolVersion as keyof typeof PROTOCOL_VERSION_ERAS
      ]
    : undefined;
}

/**
 * The spec link for a check, or `undefined` when it has none (an unknown id,
 * a step discovered during an OAuth flow, or an MCPJam heuristic).
 *
 * Picks the section for the era `protocolVersion` belongs to. With no version
 * (an "auto" run saved before the version was recorded) or one the SDK does
 * not classify, it prefers the current revision, since that is the text a
 * reader is most likely to be fixing against. A check that only runs in one
 * era links there whatever the version says.
 */
export function conformanceCheckSourceUrl(
  checkId: string,
  protocolVersion?: string | null
): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(CONFORMANCE_CHECK_SOURCES, checkId)
  ) {
    return undefined;
  }
  const source =
    CONFORMANCE_CHECK_SOURCES[checkId as ConformanceSourcedCheckId];
  if (!source) return undefined;
  const era = eraOf(protocolVersion);
  if (era === "legacy") return source.legacy ?? source.modern;
  return source.modern ?? source.legacy;
}
