/**
 * Family 4: Transport behavior. Sessions, headers, streams and response modes
 * on Streamable HTTP, plus the stdio discovery rules. HTTP behavior is not
 * applicable on stdio servers.
 */

import type { FeatureDefinition } from "../../types.js";
import { protocolEra } from "../../context.js";
import { coreSpec } from "../spec-refs.js";
import {
  countItems,
  httpOnly,
  lifecycle,
  notApplicable,
  present,
  probeAbsent,
  probeBoolean,
  probeRule,
  probeString,
  someJsonNode,
  surfaceEra,
} from "./rules.js";

const LEGACY_TRANSPORTS = "basic/transports";
const STREAMABLE_HTTP = "basic/transports/streamable-http";
const EARLIER_REVISIONS = "earlier-streamable-http-revisions";

function responseModeDetail(contentType: string | undefined) {
  if (contentType === "application/json") return "Answers with a JSON body.";
  if (contentType === "text/event-stream")
    return "Answers with an event stream.";
  return undefined;
}

export const TRANSPORT_BEHAVIOR_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "transport-behavior.session-id",
    family: "transport-behavior",
    name: "Session ID (Mcp-Session-Id)",
    summary:
      "The server assigns a session at initialize so later requests and streams belong together.",
    howTo:
      "Return an Mcp-Session-Id header on the initialize response. Use visible ASCII and a value no one can guess.",
    owner: "server",
    spec: coreSpec("2025-11-25", LEGACY_TRANSPORTS, "session-management"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: httpOnly,
      probed: probeRule("http-transport", (summary) => {
        const issued = probeBoolean(summary.values.sessionIdIssued);
        if (issued === true) return present("probed");
        const era = protocolEra(probeString(summary.values.protocolVersion));
        return issued === false && era === "legacy"
          ? probeAbsent(summary)
          : null;
      }),
    },
  },
  {
    id: "transport-behavior.session-delete",
    family: "transport-behavior",
    name: "Session termination (DELETE)",
    summary:
      "A client ends its session with an HTTP DELETE, and the server frees it or refuses the method.",
    howTo:
      "Handle DELETE on the MCP endpoint by ending the session named in its header, or answer 405.",
    owner: "server",
    spec: coreSpec("2025-11-25", LEGACY_TRANSPORTS, "session-management"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.session-expiry",
    family: "transport-behavior",
    name: "Expired session handling",
    summary:
      "A request on an expired or unknown session is refused, so the client starts a new session.",
    howTo:
      "Answer requests with an unknown Mcp-Session-Id with 404 so clients initialize again. Run the OAuth checks to test it.",
    owner: "server",
    spec: coreSpec("2025-11-25", LEGACY_TRANSPORTS, "session-management"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.get-stream",
    family: "transport-behavior",
    name: "Standalone GET stream",
    summary:
      "A GET opens an event stream the server uses for messages outside any request.",
    howTo:
      "Answer GET on the MCP endpoint with text/event-stream, or with 405 if you do not offer the stream.",
    owner: "server",
    spec: coreSpec(
      "2025-11-25",
      LEGACY_TRANSPORTS,
      "listening-for-messages-from-the-server"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.resumability",
    family: "transport-behavior",
    name: "Resumable streams (Last-Event-ID)",
    summary:
      "Event IDs let a client reconnect and replay messages it missed after a dropped stream.",
    howTo:
      "Put an id on each SSE event and replay from Last-Event-ID when a client reconnects.",
    owner: "server",
    spec: coreSpec(
      "2025-11-25",
      LEGACY_TRANSPORTS,
      "resumability-and-redelivery"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", declared: httpOnly },
  },
  {
    id: "transport-behavior.sse-polling",
    family: "transport-behavior",
    name: "SSE polling",
    summary:
      "The server can close a stream when it wants to and sets retry, so the client reconnects to collect the rest.",
    howTo:
      "Close long streams when you need to and send a retry value so clients come back.",
    owner: "server",
    spec: coreSpec(
      "2025-11-25",
      LEGACY_TRANSPORTS,
      "resumability-and-redelivery"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", declared: httpOnly },
  },
  {
    id: "transport-behavior.server-requests-on-sse",
    family: "transport-behavior",
    name: "Server requests on event streams",
    summary:
      "The server sends sampling, elicitation or roots requests to the client over an open stream.",
    howTo:
      "Send server requests on the request's event stream or the GET stream. Use the server in Playground to see them.",
    owner: "server",
    spec: coreSpec("2025-11-25", LEGACY_TRANSPORTS, "streamable-http"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", observable: true, declared: httpOnly },
  },
  {
    id: "transport-behavior.batching",
    family: "transport-behavior",
    name: "JSON-RPC batching",
    summary: "Several requests or notifications travel in one JSON array.",
    howTo:
      "Accept JSON arrays of messages on 2025-03-26 only. Later revisions removed batching.",
    owner: "server",
    spec: coreSpec("2025-03-26", "basic/index", "batching"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2025-06-18" }),
    optional: true,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.protocol-version-header",
    family: "transport-behavior",
    name: "MCP-Protocol-Version header",
    summary:
      "Every HTTP request names its protocol version in a header the server checks.",
    howTo:
      "Read MCP-Protocol-Version on each request and answer 400 when it is invalid or disagrees with the request.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "protocol-version-header"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: false,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.origin-validation",
    family: "transport-behavior",
    name: "Origin validation",
    summary:
      "The server refuses requests from untrusted origins, which blocks DNS rebinding attacks on local servers.",
    howTo:
      "Check the Origin header and answer 403 when you do not trust it. Bind local servers to localhost.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: false,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.response-mode",
    family: "transport-behavior",
    name: "Response mode (JSON or SSE)",
    summary:
      "The server answers each POST with one JSON body or an event stream, whichever suits the request.",
    howTo:
      "Return application/json for quick answers and text/event-stream when you send progress or logs first.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "sending-messages"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: false,
    assessment: {
      primary: "probed",
      declared: httpOnly,
      probed: probeRule("http-transport", (summary) => {
        const detail = responseModeDetail(
          probeString(summary.values.responseContentType)
        );
        return detail ? present("probed", { detail }) : null;
      }),
    },
  },
  {
    id: "transport-behavior.method-name-headers",
    family: "transport-behavior",
    name: "Mcp-Method and Mcp-Name headers",
    summary:
      "Each request names its method and target in headers, so gateways can route without reading the body.",
    howTo:
      "Require Mcp-Method and Mcp-Name, and answer 400 with -32020 when they are missing or disagree with the body.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "standard-request-headers"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.base64-headers",
    family: "transport-behavior",
    name: "Base64 header values",
    summary:
      "Header values that are not plain ASCII travel base64 encoded behind a sentinel prefix.",
    howTo:
      "Decode Mcp-Name and Mcp-Param values that carry the base64 sentinel before you compare them.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "value-encoding"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.x-mcp-header",
    family: "transport-behavior",
    name: "x-mcp-header parameters",
    summary:
      "A tool marks input properties that the client copies into Mcp-Param headers for routing.",
    howTo:
      "Add x-mcp-header to a tool input property to expose it as an Mcp-Param header.",
    owner: "server",
    spec: coreSpec("2026-07-28", "server/tools", "x-mcp-header"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) =>
        httpOnly(surface) ??
        countItems(
          "tools",
          (tool) =>
            someJsonNode(
              tool.inputSchema,
              (node) => node["x-mcp-header"] !== undefined
            ),
          ["tools", "toolSchemas"]
        )(surface),
    },
  },
  {
    id: "transport-behavior.get-delete-405",
    family: "transport-behavior",
    name: "GET and DELETE refused",
    summary:
      "A stateless server refuses the old GET stream and DELETE calls, so older clients fall back cleanly.",
    howTo:
      "Answer GET and DELETE on the MCP endpoint with 405 Method Not Allowed.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, EARLIER_REVISIONS),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked", declared: httpOnly },
  },
  {
    id: "transport-behavior.stateless-sessions",
    family: "transport-behavior",
    name: "No sessions",
    summary:
      "The server never mints Mcp-Session-Id and ignores session and Last-Event-ID headers.",
    howTo:
      "Drop session handling on 2026-07-28 and keep any state in requestState or your own storage.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, EARLIER_REVISIONS),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: {
      primary: "probed",
      declared: httpOnly,
      probed: probeRule("http-transport", (summary) => {
        const era = protocolEra(probeString(summary.values.protocolVersion));
        if (era !== "modern") return null;
        const issued = probeBoolean(summary.values.sessionIdIssued);
        if (issued === false) return present("probed");
        return issued === true
          ? probeAbsent(summary, "The server minted a session id.")
          : null;
      }),
    },
  },
  {
    id: "transport-behavior.stream-close-cancellation",
    family: "transport-behavior",
    name: "Cancel by closing the stream",
    summary:
      "Closing a request's response stream cancels that request on the server.",
    howTo: "Stop the work when the client closes a request's response stream.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "cancellation"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "observed", declared: httpOnly },
  },
  {
    id: "transport-behavior.request-scoped-sse",
    family: "transport-behavior",
    name: "Request-scoped event streams",
    summary:
      "A request's event stream carries its progress and log notifications, then the response.",
    howTo:
      "Send progress and log notifications on the request's own stream before the final response.",
    owner: "server",
    spec: coreSpec("2026-07-28", STREAMABLE_HTTP, "sending-messages"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", declared: httpOnly },
  },
  {
    id: "transport-behavior.stdio-discover-shutdown",
    family: "transport-behavior",
    name: "stdio discovery and shutdown",
    summary:
      "A stdio server answers the client's discover probe and exits cleanly when its input closes.",
    howTo:
      "Answer server/discover over stdio, and exit when stdin closes or the process gets SIGTERM.",
    owner: "server",
    spec: coreSpec(
      "2026-07-28",
      "basic/transports/stdio",
      "backward-compatibility"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        if (surface.transport === "stdio") {
          return surfaceEra(surface) === "modern"
            ? present("detected", {
                detail: "Answered on 2026-07-28 over stdio.",
              })
            : null;
        }
        return surface.transport === "unknown"
          ? null
          : notApplicable(
              "Applies to stdio servers. This server runs over HTTP."
            );
      },
    },
  },
];
