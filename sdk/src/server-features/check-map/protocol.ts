import type { ProtocolCheckFeatureMap } from "./types.js";

/**
 * Protocol suite check → core feature ids. A check maps to a feature only when
 * a pass shows the feature works; checks a pass cannot tie to one row are
 * excluded with the reason beside them.
 */
export const PROTOCOL_CHECK_FEATURES = {
  "server-initialize": [
    "lifecycle.initialize",
    "lifecycle.version-negotiation",
    "server-info.name-version",
  ],
  ping: ["request-control.ping"],
  "logging-set-level": ["request-control.logging-set-level"],
  // Sends ref/prompt when the server has prompts, else ref/resource, and only
  // grades the values array, so a pass says nothing about which reference.
  "completion-complete": ["completion.result-shape"],
  // Grades the advertised capability set against the lists; the handshake
  // that carries the capabilities is the row it reflects on.
  "capabilities-consistent": [
    "lifecycle.initialize",
    "lifecycle.server-discover",
  ],
  "tools-list": ["tools.list"],
  "tools-input-schemas-valid": ["tools.input-schema"],
  "tools-x-mcp-header-declarations-valid": ["transport-behavior.x-mcp-header"],
  "prompts-list": ["prompts.list"],
  "resources-list": ["resources.list"],
  // Method-not-found is generic JSON-RPC error handling; no catalog row owns it.
  "protocol-invalid-method-error": "excluded",
  "localhost-host-rebinding-rejected": ["transport-behavior.origin-validation"],
  "localhost-host-valid-accepted": ["transport-behavior.origin-validation"],
  "server-sse-polling-session": ["transport-behavior.session-id"],
  "server-sse-streams-functional": ["transport.streamable-http"],
  "notification-post-accepted": ["transport.streamable-http"],
  // A 405 passes too, so a pass shows a compliant endpoint, not a GET stream.
  "get-stream-or-405": ["transport.streamable-http"],
  "session-id-visible-ascii": ["transport-behavior.session-id"],
  "post-response-content-type": ["transport-behavior.response-mode"],
  "modern-client-handshake": [
    "lifecycle.era-detection",
    "server-info.name-version",
  ],
  "modern-server-discover": [
    "lifecycle.server-discover",
    "lifecycle.supported-versions",
  ],
  "modern-result-type-present": ["tool-results.result-type"],
  "modern-cacheable-result-hints": ["caching.ttl-ms", "caching.cache-scope"],
  "modern-cache-hint-coverage": ["caching.ttl-ms", "caching.cache-scope"],
  "modern-cache-hint-values-valid": ["caching.ttl-ms", "caching.cache-scope"],
  "modern-cache-scope-stable-across-pages": ["caching.cache-scope"],
  "modern-protocol-version-header-mismatch": [
    "transport-behavior.protocol-version-header",
  ],
  "modern-method-header-mismatch": ["transport-behavior.method-name-headers"],
  "modern-name-header-mismatch": ["transport-behavior.method-name-headers"],
  "modern-unsupported-version-error": ["lifecycle.unsupported-version-error"],
  "modern-missing-method-header-rejected": [
    "transport-behavior.method-name-headers",
  ],
  "modern-header-names-case-insensitive": [
    "transport-behavior.method-name-headers",
  ],
  "modern-undeclared-capability-error": [
    "lifecycle.missing-client-capability-error",
    "mrtr.declared-capabilities-only",
  ],
  "modern-no-session-id": ["transport-behavior.stateless-sessions"],
  // A pass means several removed methods are gone; no single row owns that,
  // and mapping it to a removed feature would mark the feature supported.
  "modern-removed-methods-not-found": "excluded",
  "modern-resource-not-found-invalid-params": ["resources.not-found-error"],
  "modern-resource-read-no-empty-contents": ["resources.not-found-error"],
  "modern-tool-output-schema-conformant": [
    "tool-results.output-schema-conformance",
  ],
  // Fails on logs without a requested level and needs the supplied tool to log
  // when asked, so a pass shows both the messages and the per-request level.
  "modern-logs-require-log-level": [
    "request-control.log-messages",
    "request-control.per-request-log-level",
  ],
  "modern-subscription-ack-precedes-notifications": [
    "subscriptions.listen",
    "subscriptions.acknowledged",
  ],
  "modern-subscription-filter-and-tagging": ["subscriptions.subscription-id"],
  "modern-subscription-graceful-close": ["subscriptions.stream-end"],
  // Grades every message the run saw against the revision's schema; a failure
  // can come from any method, so it is not evidence for one feature.
  "wire-schema-valid": "excluded",
} as const satisfies ProtocolCheckFeatureMap;
