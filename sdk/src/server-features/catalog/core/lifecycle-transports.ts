/**
 * Families 2 and 3: Lifecycle and Discovery, and Transports.
 */

import type { DeclaredSurface, FeatureDefinition } from "../../types.js";
import { protocolEra } from "../../context.js";
import { coreSpec } from "../spec-refs.js";
import {
  hasKeys,
  isComplete,
  isRecord,
  lifecycle,
  listDetail,
  notApplicable,
  notApplicableWhenComplete,
  present,
  probeAbsent,
  probeBoolean,
  probeRule,
  probeString,
  surfaceEra,
  unknown,
  type DeclaredRule,
} from "./rules.js";

const VERSIONING = "basic/versioning";
const BACKWARD_COMPATIBILITY =
  "backward-compatibility-with-initialization-based-versions";

/** Legacy revisions negotiate with initialize; the version proves it ran. */
const negotiatedLegacy: DeclaredRule = (surface) => {
  const era = surfaceEra(surface);
  if (era === "legacy") {
    return present("advertised", {
      detail: `Negotiated ${surface.protocolVersion}.`,
    });
  }
  if (era === "unknown" && surface.protocolVersion) {
    return unknown("MCPJam does not know this protocol version yet.");
  }
  return null;
};

const supportedVersions = (surface: DeclaredSurface) =>
  (surface.supportedVersions ?? []).filter(
    (version) => typeof version === "string" && version.length > 0
  );

const notStdio = "This server is configured for stdio.";

export const LIFECYCLE_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "lifecycle.initialize",
    family: "lifecycle-discovery",
    name: "initialize handshake",
    summary:
      "Client and server exchange versions, capabilities and identity before any other request.",
    howTo:
      "MCP SDKs answer initialize for you on 2025 revisions. Use Run checks to test the handshake.",
    owner: "server",
    spec: coreSpec("2025-11-25", "basic/lifecycle", "initialization"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: false,
    assessment: { primary: "declared", declared: negotiatedLegacy },
  },
  {
    id: "lifecycle.version-negotiation",
    family: "lifecycle-discovery",
    name: "Protocol version negotiation",
    summary:
      "The server answers with the version the client asked for, or the newest one it supports.",
    howTo:
      "Pin a protocol version in the server's connection settings and reconnect to test each one.",
    owner: "server",
    spec: coreSpec("2025-11-25", "basic/lifecycle", "version-negotiation"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: false,
    assessment: { primary: "declared", declared: negotiatedLegacy },
  },
  {
    id: "lifecycle.server-discover",
    family: "lifecycle-discovery",
    name: "server/discover",
    summary:
      "Lets a client read supported versions, capabilities and identity in one stateless request.",
    howTo:
      "Implement server/discover. SDKs that support 2026-07-28 add it when you enable that revision.",
    owner: "server",
    spec: coreSpec("2026-07-28", "server/discover"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        if (surfaceEra(surface) !== "modern") return null;
        const captured =
          surface.supportedVersions !== undefined ||
          (isRecord(surface.capabilities) &&
            isComplete(surface, ["capabilities"]));
        return captured
          ? present("advertised")
          : unknown(
              "The discovery result was not captured. Reconnect to capture it."
            );
      },
    },
  },
  {
    id: "lifecycle.supported-versions",
    family: "lifecycle-discovery",
    name: "supportedVersions",
    summary:
      "Lists every revision the server speaks, so a client can pick one without trial and error.",
    howTo:
      "Return supportedVersions from server/discover with each revision you support.",
    owner: "server",
    spec: coreSpec("2026-07-28", "server/discover"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const versions = supportedVersions(surface);
        if (versions.length > 0) {
          return present("advertised", {
            count: versions.length,
            detail: listDetail(versions),
          });
        }
        return surfaceEra(surface) === "modern"
          ? unknown("The saved discovery result has no supportedVersions list.")
          : null;
      },
    },
  },
  {
    id: "lifecycle.extensions",
    family: "lifecycle-discovery",
    name: "Extension negotiation",
    summary:
      "Declares the official or vendor extensions the server supports, keyed by extension id.",
    howTo:
      "Declare each extension you support under capabilities.extensions, for example io.modelcontextprotocol/ui.",
    owner: "server",
    spec: coreSpec("2026-07-28", VERSIONING, "extension-negotiation"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const extensions = surface.capabilities?.extensions;
        if (isRecord(extensions) && hasKeys(extensions)) {
          const ids = Object.keys(extensions);
          return present("advertised", {
            count: ids.length,
            detail: listDetail(ids),
          });
        }
        const era = surfaceEra(surface);
        // 2025 schemas have no extensions key, so leaving it out there proves nothing.
        if (era === "legacy") {
          return unknown(
            "Servers on 2025 revisions are not required to list extensions, so a missing list proves nothing."
          );
        }
        if (era === "unknown") {
          return surface.protocolVersion
            ? unknown("MCPJam does not know this protocol version yet.")
            : null;
        }
        return notApplicableWhenComplete(
          surface,
          ["capabilities"],
          "The server declares no extensions."
        );
      },
    },
  },
  {
    id: "lifecycle.unsupported-version-error",
    family: "lifecycle-discovery",
    name: "Unsupported protocol version error (-32022)",
    summary:
      "A request on a revision the server does not speak gets -32022 with the versions it does speak.",
    howTo:
      "Return -32022 with data.supported for unknown protocol versions. Use Run checks to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "error-codes"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "lifecycle.era-detection",
    family: "lifecycle-discovery",
    name: "Era detection",
    summary:
      "Lets a client tell a 2026-07-28 server from an initialize-based one by how it answers the first request.",
    howTo:
      "Answer a request for a revision you do not speak with an error the client can read. Use Run checks to test the handshake.",
    owner: "server",
    spec: coreSpec("2026-07-28", VERSIONING, BACKWARD_COMPATIBILITY),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "lifecycle.dual-era",
    family: "lifecycle-discovery",
    name: "Dual-era support",
    summary:
      "One server answers both initialize and 2026-07-28 requests, so old and new clients can connect.",
    howTo:
      "Keep initialize next to server/discover while your clients migrate.",
    owner: "server",
    spec: coreSpec("2026-07-28", VERSIONING, BACKWARD_COMPATIBILITY),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "lifecycle.modern-only-version-error",
    family: "lifecycle-discovery",
    name: "Supported versions in the initialize error",
    summary:
      "A server without initialize names the revisions it speaks when an older client tries to initialize.",
    howTo:
      "Answer initialize with an error that lists the protocol versions you support.",
    owner: "server",
    spec: coreSpec("2026-07-28", VERSIONING, BACKWARD_COMPATIBILITY),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "lifecycle.missing-client-capability-error",
    family: "lifecycle-discovery",
    name: "Missing client capability error (-32021)",
    summary:
      "A server that needs a capability the client did not declare says so up front with -32021.",
    howTo:
      "Return -32021 naming the missing capability when a request needs one the client did not send.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "error-codes"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "lifecycle.no-capability-inference",
    family: "lifecycle-discovery",
    name: "Per-request client capabilities",
    summary:
      "The server reads client capabilities from each request instead of remembering earlier ones.",
    howTo:
      "Read io.modelcontextprotocol/clientCapabilities from each request's _meta and never carry it across requests.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "requestmetaobject"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: false,
    assessment: { primary: "observed" },
  },
];

export const TRANSPORT_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "transport.stdio",
    family: "transports",
    name: "stdio",
    summary:
      "The client starts the server as a subprocess and talks over standard input and output.",
    howTo:
      "Read JSON-RPC messages from stdin and write them to stdout, one per line. Add the command to MCPJam to connect.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/transports/stdio"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        if (surface.transport === "stdio") {
          return present("detected", { detail: "Connected over stdio." });
        }
        return surface.transport === "unknown"
          ? null
          : notApplicable("This server is configured for HTTP.");
      },
    },
  },
  {
    id: "transport.streamable-http",
    family: "transports",
    name: "Streamable HTTP (2025)",
    summary:
      "One HTTP endpoint for POST and GET, with optional sessions and server-sent event streams.",
    howTo: "Serve the MCP endpoint with your SDK's Streamable HTTP transport.",
    owner: "server",
    spec: coreSpec("2025-11-25", "basic/transports", "streamable-http"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        if (surface.transport === "stdio") return notApplicable(notStdio);
        return surface.transport === "streamable-http" &&
          surfaceEra(surface) === "legacy"
          ? present("detected", { detail: "Connected over Streamable HTTP." })
          : null;
      },
      probed: probeRule("http-transport", (summary) => {
        const streamable = probeBoolean(summary.values.streamableHttp);
        if (streamable === false) return probeAbsent(summary);
        const era = protocolEra(probeString(summary.values.protocolVersion));
        return streamable === true && era === "legacy"
          ? present("probed")
          : null;
      }),
    },
  },
  {
    id: "transport.streamable-http-stateless",
    family: "transports",
    name: "Streamable HTTP (stateless)",
    summary:
      "Each POST carries its own version and capabilities, with no sessions and no standalone GET stream.",
    howTo:
      "Serve 2026-07-28 with an SDK that supports it. Stateless requests can land on any instance behind a load balancer.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/transports/streamable-http"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: (surface) => {
        if (surface.transport === "stdio") return notApplicable(notStdio);
        return surface.transport === "streamable-http" &&
          surfaceEra(surface) === "modern"
          ? present("detected", { detail: "Connected on 2026-07-28." })
          : null;
      },
      probed: probeRule("http-transport", (summary) => {
        const era = protocolEra(probeString(summary.values.protocolVersion));
        return probeBoolean(summary.values.streamableHttp) === true &&
          era === "modern"
          ? present("probed")
          : null;
      }),
    },
  },
  {
    id: "transport.http-sse",
    family: "transports",
    name: "HTTP+SSE (deprecated)",
    summary:
      "The 2024-11-05 transport: a GET event stream plus a separate POST endpoint.",
    howTo:
      "Move to Streamable HTTP. Keep the old endpoints only for clients that still need them.",
    owner: "server",
    spec: coreSpec("2026-07-28", "deprecated"),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: (surface) => {
        if (surface.transport === "stdio") return notApplicable(notStdio);
        return surface.transport === "sse"
          ? present("detected", { detail: "Connected over HTTP+SSE." })
          : null;
      },
      probed: probeRule("http-transport", (summary) => {
        const legacySse = probeBoolean(summary.values.legacySse);
        if (legacySse === true) return present("probed");
        return legacySse === false ? probeAbsent(summary) : null;
      }),
    },
  },
  {
    id: "transport.custom",
    family: "transports",
    name: "Custom transports",
    summary:
      "Any other channel that carries MCP's JSON-RPC messages and keeps its lifecycle.",
    howTo:
      "MCPJam connects over stdio and HTTP. Test a custom transport with a client built for it.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/transports", "custom-transports"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) =>
        surface.transport === "unknown"
          ? null
          : notApplicable("MCPJam connects over stdio and HTTP only."),
    },
  },
];
