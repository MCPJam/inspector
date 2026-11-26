/**
 * The spec level (RFC 2119) every client-rule test is marked with.
 *
 * Most rules carry their keyword on the rules page, and `levelOf` uses it as
 * it is ("(host)" only says the rule binds an MCP Apps host). For the rest,
 * the level below was read from the spec copies in `mcpjam/specs`, with these
 * conventions:
 *
 * - REQUIRED means MUST (RFC 2119, section 1).
 * - A field the spec's JSON Schema requires is MUST.
 * - A behavior the spec states as plain fact, with no keyword ("clients send
 *   a `prompts/list` request"), is the only way the protocol defines to do
 *   that thing, so it is MUST (MUST NOT for "does not").
 * - A lowercase "must" or "should" counts as MUST or SHOULD.
 * - "All fields are optional" is MAY.
 */

import { CLIENT_RULES, type ClientRuleId } from "./rules.js";

export const SPEC_LEVELS = ["MUST", "MUST NOT", "SHOULD", "SHOULD NOT", "MAY"] as const;
export type SpecLevel = (typeof SPEC_LEVELS)[number];

/** Rules the page gives no RFC keyword, with the spec sentence that sets their level. */
export const LEVEL_FROM_SPEC: Partial<
  Record<ClientRuleId, { level: SpecLevel; spec: string }>
> = {
  C006: {
    level: "MUST",
    spec: "2025-11-25 schema: SetLevelRequestParams.level is a required LoggingLevel",
  },
  C009: {
    level: "MUST",
    spec: "2025-11-25 completion: clients send completion/complete specifying what is completed through a reference type; schema: ref is required",
  },
  C018: {
    level: "MUST",
    spec: "2025-11-25 prompts: to retrieve available prompts, clients send a prompts/list request",
  },
  C021: {
    level: "MUST",
    spec: "2025-11-25 resources: to discover available resources, clients send a resources/list request",
  },
  C034: {
    level: "SHOULD",
    spec: "2026-07-28 server/discover: the client should choose one of these [supportedVersions] for subsequent requests (lowercase)",
  },
  C050: {
    level: "SHOULD",
    spec: "2026-07-28 versioning: the client SHOULD select a mutually supported version from the supported list and retry",
  },
  C052: {
    level: "MUST",
    spec: "2026-07-28 streamable-http: clients must ensure they handle backwards compatibility correctly (lowercase)",
  },
  C053: {
    level: "SHOULD",
    spec: "2026-07-28 streamable-http backward compatibility: clients wanting to support older servers should issue the HTTP+SSE GET only when the body is not a recognized modern JSON-RPC error (lowercase)",
  },
  C054: {
    level: "MUST",
    spec: "2026-07-28: resources/subscribe was removed; subscribing is done with subscriptions/listen",
  },
  C058: {
    level: "MUST",
    spec: "2026-07-28 logging: to receive log messages for a request, include io.modelcontextprotocol/logLevel in the request's _meta (the server MUST NOT log without it)",
  },
  C060: {
    level: "MUST",
    spec: "2026-07-28 subscriptions: the client sends a subscriptions/listen request with a notifications filter; schema: notifications is required",
  },
  C061: {
    level: "MAY",
    spec: "2026-07-28 subscriptions: all filter fields are optional; omitting one is equivalent to not subscribing",
  },
  C062: {
    level: "MUST",
    spec: "2026-07-28 cancellation: on Streamable HTTP, closing the SSE stream is the cancellation signal; on stdio the client MUST send notifications/cancelled",
  },
  C071: {
    level: "MUST",
    spec: "MCP Apps 2026-01-26: clients advertise MCP Apps support in the initialize request using the extension identifier io.modelcontextprotocol/ui",
  },
  C072: {
    level: "MUST",
    spec: "MCP Apps 2026-01-26: mimeTypes, array of supported content types (REQUIRED)",
  },
  C074: {
    level: "MUST",
    spec: "MCP Apps 2026-01-26: Host MUST use resources/read to fetch the referenced resource URI",
  },
  C073: {
    level: "MAY",
    spec: "MCP Apps 2026-01-26: Host MAY prefetch and cache UI resource content",
  },
  C078: {
    level: "MUST",
    spec: "2025-11-25 tasks: to create a task, requestors send a request with the task field included in the request params",
  },
  C081: {
    level: "MUST NOT",
    spec: "Tasks extension: task creation is server-directed; the client only signals support and the server decides",
  },
  C082: {
    level: "MUST",
    spec: "Tasks extension: the client signals support by including the extension in its per-request capabilities",
  },
  C089: {
    level: "MUST",
    spec: "Tasks extension: a client that has negotiated this extension MUST be prepared to handle either CallToolResult or CreateTaskResult",
  },
  C104: {
    level: "MUST",
    spec: "Tasks extension: later tasks/get, tasks/update and tasks/cancel name the task by the taskId the server returned",
  },
  C196: {
    level: "SHOULD",
    spec: "2025-11-25 and 2026-07-28 authorization: MCP clients SHOULD use and verify state parameters in the authorization code flow",
  },
  C201: {
    level: "MUST",
    spec: "Events beta: available events are listed with an events/list request",
  },
  C203: {
    level: "MUST",
    spec: "Events beta: in the request, cursor null means start from now",
  },
  C204: {
    level: "MUST",
    spec: "Events beta: the subscribing client supplies the webhook signing secret (REQUIRED)",
  },
};

export function levelOf(id: ClientRuleId): SpecLevel {
  const fromSpec = LEVEL_FROM_SPEC[id];
  if (fromSpec) return fromSpec.level;
  const keyword = CLIENT_RULES[id].keyword.replace(/ \(host\)$/, "");
  if ((SPEC_LEVELS as readonly string[]).includes(keyword)) return keyword as SpecLevel;
  throw new Error(`${id} has page keyword "${CLIENT_RULES[id].keyword}" and no level in LEVEL_FROM_SPEC`);
}
