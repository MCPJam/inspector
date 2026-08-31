/**
 * Static, browser-safe catalog of every conformance check's title and
 * one-line description.
 *
 * WHY THIS EXISTS SEPARATELY: the canonical title/description strings live
 * next to the check implementations (`CORE_CHECKS`, `MODERN_CHECK_METADATA`,
 * the apps/tasks runner metadata, …), and those modules pull the whole
 * runner graph — raw HTTP probes, the MCP client, Node-only transitive deps.
 * A UI that wants to show what a suite WILL run, before it has run, cannot
 * import them. This module carries the same strings with no runtime
 * dependencies at all, so it is safe from the browser entry.
 *
 * DRIFT IS NOT ALLOWED TO PASS SILENTLY: every entry here is asserted equal
 * to its canonical source in `__tests__/conformance-catalog.test.ts`. Editing
 * a check's title or description without updating this file fails that test,
 * and vice versa. Adding a check fails typecheck here, because each record is
 * exhaustive over its suite's id union.
 */

import type { MCPCheckId } from "./mcp-conformance/types.js";
import type { MCPAppsCheckId } from "./apps-conformance/types.js";
import type { MCPTasksCheckId } from "./tasks-conformance/types.js";

export interface ConformanceCheckInfo {
  title: string;
  description: string;
}

/** Protocol suite. Keys follow `MCP_CHECK_IDS` order. */
export const PROTOCOL_CHECK_CATALOG = {
  "server-initialize": {
    title: "Server Initialize",
    description: "Server responds to initialize and reports capabilities.",
  },
  ping: {
    title: "Ping",
    description: "Server responds to ping requests.",
  },
  "logging-set-level": {
    title: "Logging Set Level",
    description: "Server accepts logging/setLevel requests.",
  },
  "completion-complete": {
    title: "Completion Complete",
    description: "Server responds to completion/complete requests.",
  },
  "capabilities-consistent": {
    title: "Capabilities Consistent",
    description:
      "Advertised server capabilities match the features actually exposed.",
  },
  "tools-list": {
    title: "Tools List",
    description: "Server lists tools with name, description, and input schema.",
  },
  "tools-input-schemas-valid": {
    title: "Tool Input Schemas Valid",
    description:
      'Every tool\'s inputSchema has type "object" and valid properties/required fields.',
  },
  "tools-x-mcp-header-declarations-valid": {
    title: "x-mcp-header Declarations Valid",
    description:
      "Every published tool's SEP-2243 x-mcp-header declarations satisfy the spec's constraints: statically reachable through a chain of `properties`, an RFC 9110 token name, a primitive type, and case-insensitively unique.",
  },
  "prompts-list": {
    title: "Prompts List",
    description: "Server lists prompts with name and description.",
  },
  "resources-list": {
    title: "Resources List",
    description: "Server lists resources with uri and name.",
  },
  "protocol-invalid-method-error": {
    title: "Invalid Method Error",
    description:
      "Server returns a valid JSON-RPC error for an unrecognized method name.",
  },
  "localhost-host-rebinding-rejected": {
    title: "Reject Evil Host Header",
    description:
      "Local servers reject initialize requests with a non-localhost Host/Origin header.",
  },
  "localhost-host-valid-accepted": {
    title: "Accept Valid Local Host Header",
    description:
      "Local servers accept initialize requests with a valid localhost Host/Origin header.",
  },
  "server-sse-polling-session": {
    title: "SSE Polling Session",
    description: "Server provides a streamable HTTP session id.",
  },
  "server-accepts-multiple-post-streams": {
    title: "Multiple POST Streams",
    description: "The server accepts multiple concurrent POST requests.",
  },
  "server-sse-streams-functional": {
    title: "Functional SSE Streams",
    description: "Concurrent SSE streams remain readable.",
  },
  "notification-post-accepted": {
    title: "Notification POST Accepted",
    description:
      "A POST carrying only a JSON-RPC notification is answered with HTTP 202 Accepted and no body.",
  },
  "get-stream-or-405": {
    title: "GET Opens SSE Or Returns 405",
    description:
      "A GET to the MCP endpoint either opens a text/event-stream response or returns HTTP 405 Method Not Allowed.",
  },
  "session-id-visible-ascii": {
    title: "Session Id Visible ASCII",
    description:
      "A minted session id contains only visible ASCII characters (0x21 to 0x7E).",
  },
  "post-response-content-type": {
    title: "POST Response Content-Type",
    description:
      "The response to a JSON-RPC request carries Content-Type application/json or text/event-stream.",
  },
  "modern-client-handshake": {
    title: "Modern Client Handshake",
    description:
      "The official client negotiates the modern revision and receives the server identity and capabilities.",
  },
  "modern-server-discover": {
    title: "Modern Server Discovery",
    description:
      "server/discover returns the supported protocol versions, capabilities, and server identity.",
  },
  "modern-result-type-present": {
    title: "Modern Result Type",
    description: "Every modern result carries the wire member resultType.",
  },
  "modern-cacheable-result-hints": {
    title: "Cacheable Result Hints",
    description: "Cacheable modern results carry ttlMs and cacheScope.",
  },
  "modern-cache-hint-coverage": {
    title: "Cache Hints On Every Cacheable Operation",
    description:
      "All six operations the caching utility names — server/discover, tools/list, prompts/list, resources/list, resources/templates/list, resources/read — carry ttlMs and cacheScope on a complete result.",
  },
  "modern-cache-hint-values-valid": {
    title: "Cache Hint Values Valid",
    description:
      'ttlMs is an integer >= 0 and cacheScope is exactly "public" or "private".',
  },
  "modern-cache-scope-stable-across-pages": {
    title: "Cache Scope Stable Across Pages",
    description:
      "Every page of a paginated list response carries the same cacheScope as the first.",
  },
  "modern-protocol-version-header-mismatch": {
    title: "Protocol Version Header Mismatch",
    description:
      "A MCP-Protocol-Version header disagreeing with the request envelope is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-method-header-mismatch": {
    title: "Mcp-Method Header Mismatch",
    description:
      "An Mcp-Method header disagreeing with the body method is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-name-header-mismatch": {
    title: "Mcp-Name Header Mismatch",
    description:
      "An Mcp-Name header disagreeing with the body target is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-unsupported-version-error": {
    title: "Unsupported Envelope Version",
    description:
      "An unsupported envelope protocol version is rejected with JSON-RPC -32022 naming the supported versions.",
  },
  "modern-missing-method-header-rejected": {
    title: "Missing Mcp-Method Header Rejected",
    description:
      "A request that omits the required Mcp-Method header is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-header-names-case-insensitive": {
    title: "Header Names Are Case-Insensitive",
    description:
      "The SEP-2243 standard headers are accepted under any case, as RFC 9110 field names require.",
  },
  "modern-undeclared-capability-error": {
    title: "Undeclared Client Capability",
    description:
      "A server that needs an undeclared client capability for input_required answers JSON-RPC -32021.",
  },
  "modern-no-session-id": {
    title: "No Session Id Minted",
    description: "A modern server never mints an Mcp-Session-Id.",
  },
  "modern-removed-methods-not-found": {
    title: "Removed Methods Rejected",
    description:
      "Methods removed by the 2026 revision answer JSON-RPC -32601 with HTTP 404.",
  },
  "modern-resource-not-found-invalid-params": {
    title: "Resource Not Found",
    description:
      "Reading an unknown resource answers in-band JSON-RPC -32602 on HTTP 200.",
  },
  "modern-resource-read-no-empty-contents": {
    title: "No Empty Contents For A Missing Resource",
    description:
      "Reading a non-existent resource never answers with an empty contents array, which cannot be told apart from an existing but empty resource.",
  },
  "modern-tool-output-schema-conformant": {
    title: "Tool Output Schema Honored",
    description:
      "For every operator-supplied fixture call whose tool declares an outputSchema, the result's structuredContent validates against that schema.",
  },
  "modern-logs-require-log-level": {
    title: "Logs Require A Log Level",
    description:
      "No log notifications are emitted for a request that carried no modern log level.",
  },
  "modern-subscription-ack-precedes-notifications": {
    title: "Subscription Acknowledgement Ordering",
    description:
      "A subscriptions/listen stream acknowledges before it emits any notification.",
  },
  "modern-subscription-filter-and-tagging": {
    title: "Subscription Filtering And Tagging",
    description:
      "A subscription emits only the requested notification types and tags every message with the subscription id.",
  },
  "modern-subscription-graceful-close": {
    title: "Subscription Graceful Close",
    description:
      "Closing a subscription gracefully returns the subscriptions/listen completion result.",
  },
  "wire-schema-valid": {
    title: "Wire Schema Valid",
    description:
      "Every JSON-RPC message the run observed validates against the protocol revision's published JSON Schema, with responses graded against their method's result definition.",
  },
} as const satisfies Record<MCPCheckId, ConformanceCheckInfo>;

/** MCP Apps suite. Keys follow `MCP_APPS_CHECK_IDS` order. */
export const APPS_CHECK_CATALOG = {
  "ui-tools-present": {
    title: "UI Tools Present",
    description:
      "At least one tool advertises MCP Apps UI metadata through _meta.ui.resourceUri or the deprecated ui/resourceUri field.",
  },
  "ui-tool-metadata-valid": {
    title: "UI Tool Metadata Valid",
    description:
      "Tools with UI metadata use a ui:// resource URI and valid visibility values.",
  },
  "ui-tool-input-schema-valid": {
    title: "UI Tool Input Schema Valid",
    description:
      "UI tools provide a non-null JSON Schema object as their inputSchema.",
  },
  "ui-listed-resources-valid": {
    title: "Listed UI Resources Valid",
    description:
      "UI resources returned by resources/list use ui:// URIs; declaring the MCP Apps HTML MIME type there is a SHOULD, so a different value warns rather than fails.",
  },
  "ui-resources-readable": {
    title: "UI Resources Readable",
    description:
      "Every UI resource referenced by a tool or listed by the server can be fetched with resources/read.",
  },
  "ui-resource-contents-valid": {
    title: "UI Resource Contents Valid",
    description:
      "resources/read returns at least one content entry, and every entry uses the MCP Apps HTML MIME type and carries an HTML document via text or blob.",
  },
  "ui-resource-meta-valid": {
    title: "UI Resource Metadata Valid",
    description:
      "UI resource metadata uses valid csp, permissions, domain, and prefersBorder shapes.",
  },
} as const satisfies Record<MCPAppsCheckId, ConformanceCheckInfo>;

/** Tasks suite. Keys follow `MCP_TASKS_CHECK_IDS` order. */
export const TASKS_CHECK_CATALOG = {
  "tasks-wire-resolvable": {
    title: "Tasks Wire Resolvable",
    description:
      "The negotiated protocol version and advertised capabilities resolve to exactly one tasks wire, and the server does not advertise capabilities for the other era.",
  },
  "tasks-declaration-hygiene": {
    title: "Per-Version Declaration Hygiene",
    description:
      "Outgoing requests carry `params.task` only on the legacy wire and the tasks extension declaration only on the extension wire; a connection with no tasks wire sends neither.",
  },
  "tasks-result-type-discipline": {
    title: "Result Type Discipline",
    description:
      'A task-eligible tools/call returns either a normal tool result or a flat CreateTaskResult with resultType "task" and a server-generated taskId.',
  },
  "tasks-undeclared-creation-refused": {
    title: "Undeclared Task Creation Refused",
    description:
      "On the extension wire, a tools/call that did not carry the extension declaration must not come back as a CreateTaskResult: the server either answers normally or rejects with -32021.",
  },
  "tasks-undeclared-capability-rejected": {
    title: "Undeclared Capability Rejected",
    description:
      "tasks/get, tasks/update, tasks/cancel and a task-filtered subscriptions/listen sent WITHOUT the extension declaration must each be rejected with -32021 (Missing Required Client Capability).",
  },
  "tasks-ttl-shape": {
    title: "TTL And Poll Interval Shapes",
    description:
      "Task TTL and poll interval use the era-native shapes: `ttlMs: number|null` / `pollIntervalMs` on the extension, `ttl` / `pollInterval` on the legacy wire.",
  },
  "tasks-inline-result": {
    title: "Completed Task Carries Its Result",
    description:
      "A completed task exposes its result the era-native way: inline on the extension's tasks/get, via tasks/result on the legacy wire.",
  },
  "tasks-mcp-name-routing": {
    title: "Mcp-Name Task Routing",
    description:
      "Over HTTP, tasks/get is sent with Mcp-Name set to the task id (captured off the fetch seam) and accepted by the server.",
  },
  "tasks-invalid-task-id-rejected": {
    title: "Invalid Task Id Rejected",
    description:
      "tasks/get for a task id the server never issued is rejected with -32602 (Invalid params); the same rejection on tasks/update and tasks/cancel is a SHOULD and only warns.",
  },
  "tasks-status-payload-shape": {
    title: "Status Payload Shape",
    description:
      "Each observed task status carries the payload its status requires: `result` on completed, `error` on failed, `inputRequests` on input_required.",
  },
  "tasks-cancel-ack-shape": {
    title: "Cancel Acknowledged With An Empty Result",
    description:
      "tasks/cancel is acknowledged with an empty result rather than a task state, and the task's observable status is allowed to remain non-terminal afterwards.",
  },
  "tasks-input-required-update-completes": {
    title: "Input Required Round Trip Completes",
    description:
      "A task that reports input_required advances past it once tasks/update supplies the requested inputResponses, and reaches a terminal status.",
  },
  "tasks-ttl-integer-shape": {
    title: "TTL And Poll Interval Are Integers",
    description:
      "ttlMs and pollIntervalMs are integer milliseconds, as the extension's Task interface states.",
  },
  "tasks-undeclared-capability-names-requirements": {
    title: "Undeclared Capability Error Names What Is Missing",
    description:
      "A -32021 rejection carries error.data.requiredCapabilities naming the capability the client failed to declare.",
  },
} as const satisfies Record<MCPTasksCheckId, ConformanceCheckInfo>;
