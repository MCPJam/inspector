/**
 * The readiness / interoperability channel — Phase 7 §15.4.
 *
 * Everything reported here is NON-MUST advice: SHOULD, RECOMMENDED, or MAY
 * strength. A readiness warning is attached to
 * `MCPConformanceResult.readiness` and is NEVER converted into a check result,
 * so it cannot change `passed`, any check status, or the category summary.
 * That separation is the point: a server that is fully conformant but awkward
 * to interoperate with should read as "conformant, with advice", never as a
 * failure — and a conformance verdict must stay a statement about MUSTs.
 *
 * Each warning carries the spec strength of the requirement it reflects, so a
 * reader can tell "the spec says you SHOULD" from "the spec says you MAY".
 */

import type { Tool } from "@modelcontextprotocol/client";
import { READINESS_CATALOG } from "../conformance-catalog.js";
import { listTools } from "../operations.js";
import {
  MCP_LOG_LEVELS,
  type MCPClientCheckContext,
  type MCPReadinessId,
  type MCPReadinessSpecStrength,
  type MCPReadinessWarning,
  type MCPServerSurfaceSnapshot,
  type RawHttpCheckContext,
} from "./types.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  legacyHeaders,
  legacyInitialize,
  logRecords,
  rawHeadersProbe,
  modernHeaders,
  modernRequestBody,
  rawRequest,
} from "./raw-http.js";

/** Capabilities whose 2025-era mechanics were replaced in the 2026 revision. */
const DEPRECATED_MODERN_CAPABILITIES: Array<{
  key: string;
  advice: string;
}> = [
  {
    key: "logging",
    advice:
      "the logging capability advertises the removed logging/setLevel handshake; modern clients carry the log level per request",
  },
];

function warning(
  id: MCPReadinessWarning["id"],
  specStrength: MCPReadinessSpecStrength,
  message: string,
  details?: Record<string, unknown>
): MCPReadinessWarning {
  return {
    id,
    // One title per advice, shared with the static catalog UIs list.
    title: READINESS_CATALOG[id].title,
    severity: "warning",
    specStrength,
    message,
    details,
  };
}

/**
 * Advice that is REPORTED but costs no points — see
 * {@link MCPReadinessWarning.informational}. Use this, not {@link warning},
 * whenever the behavior described is one the specification explicitly allows or
 * merely illustrates.
 */
function informational(
  id: MCPReadinessWarning["id"],
  specStrength: MCPReadinessSpecStrength,
  message: string,
  details?: Record<string, unknown>
): MCPReadinessWarning {
  return {
    ...warning(id, specStrength, message, details),
    informational: true,
  };
}

/** Whether the run asked for this advice: all of it, unless `readinessIds` narrows it. */
function adviceSelected(
  config: { readinessIds?: readonly MCPReadinessId[] },
  id: MCPReadinessId
): boolean {
  return config.readinessIds === undefined || config.readinessIds.includes(id);
}

function toolOrderWarning(
  first: string[],
  second: string[]
): MCPReadinessWarning | undefined {
  if (first.length === 0 || first.join("\u0000") === second.join("\u0000")) {
    return undefined;
  }

  return warning(
    "readiness-tool-order-deterministic",
    "SHOULD",
    "tools/list returned the tools in a different order on a repeated call; a stable order keeps client-side caches, diffs, and model prompts stable across calls",
    { firstListing: first, secondListing: second }
  );
}

/**
 * The core "Tool Names" SHOULDs (length, character set, uniqueness), checked
 * over every tool. They first appear in 2025-11-25, so an older negotiated
 * revision gets no advice. Informational until advice has a grading rubric.
 */
function toolNameConventionsWarning(
  ctx: MCPClientCheckContext,
  tools: Tool[]
): MCPReadinessWarning | undefined {
  if (
    ctx.config.era !== "modern" &&
    negotiatedBefore(ctx, "2025-11-25") !== false
  ) {
    return undefined;
  }

  // A server can hand back a tool whose name is not a string; advice must
  // never throw, so those are left to the checks that judge tool shape.
  const names = tools
    .map((tool) => tool.name as unknown)
    .filter((name): name is string => typeof name === "string");
  const unique = [...new Set(names)];
  const badLength = unique.filter(
    (name) => name.length < 1 || name.length > 128
  );
  // An empty name is already a length problem; the character rule is about
  // what a name contains.
  const badCharacters = unique.filter(
    (name) => name.length > 0 && !/^[A-Za-z0-9_\-.]+$/.test(name)
  );
  const duplicates = unique.filter(
    (name) => names.indexOf(name) !== names.lastIndexOf(name)
  );

  const problems = [
    badLength.length > 0
      ? `not between 1 and 128 characters: ${listNames(badLength)}`
      : null,
    badCharacters.length > 0
      ? `characters other than A-Z, a-z, 0-9, underscore, hyphen, or dot: ${listNames(badCharacters)}`
      : null,
    duplicates.length > 0
      ? `used more than once: ${listNames(duplicates)}`
      : null,
  ].filter((problem): problem is string => problem !== null);

  if (problems.length === 0) {
    return undefined;
  }

  return informational(
    "readiness-tool-name-conventions",
    "SHOULD",
    `Tool names break the spec's naming conventions: ${problems.join("; ")}`,
    { badLength, badCharacters, duplicates }
  );
}

/** Names the user has to rename, quoted, with a count for any beyond three. */
function listNames(names: string[]): string {
  const shown = names
    .slice(0, 3)
    .map((name) => JSON.stringify(name))
    .join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/**
 * Whether the negotiated revision is older than `revision`, or undefined when
 * there is no date-shaped revision to compare (a draft label, or none at all).
 * Revisions are ISO dates, so string order is date order once the shape is
 * known.
 */
function negotiatedBefore(
  ctx: MCPClientCheckContext,
  revision: string
): boolean | undefined {
  const negotiated = ctx.initializationInfo?.protocolVersion;
  if (negotiated === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(negotiated)) {
    return undefined;
  }
  return negotiated < revision;
}

function deprecatedFeatureWarning(
  ctx: MCPClientCheckContext,
  capabilities: Record<string, unknown>
): MCPReadinessWarning | undefined {
  const findings: string[] = [];

  if (ctx.config.era === "modern") {
    for (const { key, advice } of DEPRECATED_MODERN_CAPABILITIES) {
      if (capabilities[key] !== undefined) {
        findings.push(advice);
      }
    }
    const resources = capabilities.resources;
    if (
      resources !== null &&
      typeof resources === "object" &&
      (resources as Record<string, unknown>).subscribe === true
    ) {
      findings.push(
        "resources.subscribe advertises the removed resources/subscribe flow; modern clients subscribe through subscriptions/listen"
      );
    }
  } else if (negotiatedBefore(ctx, "2025-11-25") === true) {
    findings.push(
      `the negotiated revision ${ctx.initializationInfo?.protocolVersion} is superseded; newer clients negotiate a later revision`
    );
  }

  if (findings.length === 0) {
    return undefined;
  }

  return warning(
    "readiness-deprecated-feature-use",
    "SHOULD",
    `Server advertises superseded functionality: ${findings.join("; ")}`,
    { findings }
  );
}

/**
 * Readiness advice observable from the client session, collected while the
 * connection is still open. Any failure here is swallowed: readiness is
 * advisory, so a probe that cannot run must never disturb the run.
 */
export async function collectClientReadiness(
  ctx: MCPClientCheckContext,
  surface: MCPServerSurfaceSnapshot
): Promise<MCPReadinessWarning[]> {
  const warnings: MCPReadinessWarning[] = [];

  if (adviceSelected(ctx.config, "readiness-tool-order-deterministic")) {
    try {
      const secondListing = await listTools(ctx.manager, {
        serverId: ctx.serverId,
      });
      const orderWarning = toolOrderWarning(
        surface.toolNames,
        secondListing.tools.map((tool) => tool.name)
      );
      if (orderWarning) {
        warnings.push(orderWarning);
      }
    } catch {
      // A server without tools (or one that failed the repeat listing) simply
      // yields no ordering advice.
    }
  }

  if (adviceSelected(ctx.config, "readiness-tool-name-conventions")) {
    const toolNameWarning = toolNameConventionsWarning(ctx, surface.tools);
    if (toolNameWarning) {
      warnings.push(toolNameWarning);
    }
  }

  if (adviceSelected(ctx.config, "readiness-deprecated-feature-use")) {
    const deprecated = deprecatedFeatureWarning(
      ctx,
      surface.serverCapabilities ?? {}
    );
    if (deprecated) {
      warnings.push(deprecated);
    }
  }

  return warnings;
}

/**
 * Explicit session termination is advice on both sides of the era line: the
 * 2025 revisions say clients SHOULD send a DELETE when abandoning a session
 * and servers MAY answer 405, so no server response can violate a MUST; the
 * 2026 revision says stray GET/DELETE traffic from older clients SHOULD get
 * 405 Method Not Allowed.
 */
async function sessionTerminationWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era === "modern") {
    // The obligation is about "traffic from an older client", so the probes
    // have to LOOK like one: a 2025 protocol pin and a session id, which the
    // same clause tells a modern server to ignore. A bare request would be
    // neither era's traffic, and a header-validating server could answer 400
    // for the missing version — which the advice would then misattribute to
    // the 405 obligation.
    const staleClientHeaders = legacyHeaders({
      protocolVersion: DEFAULT_LEGACY_PROTOCOL_VERSION,
      sessionId: "mcpjam-conformance-legacy-probe",
    });
    const timeoutMs = Math.min(ctx.config.checkTimeout, 3_000);
    // The clause names GET *and* DELETE, so both are probed: a server that
    // still opens a stream on GET is exactly the backward-compat trap this
    // advice exists to name, and DELETE alone would never see it. The GET
    // reads headers only — a stream it wrongly opens would never end.
    // Settled per probe, not `Promise.all`: the two are independent
    // observations, and one that times out must not discard what the other
    // saw. A GET that hangs would otherwise bury a real DELETE violation.
    const [getProbe, deleteProbe] = await Promise.allSettled([
      rawHeadersProbe(ctx, {
        method: "GET",
        headers: { ...staleClientHeaders, Accept: "text/event-stream" },
        timeoutMs,
      }),
      rawRequest(ctx, {
        method: "DELETE",
        headers: staleClientHeaders,
        timeoutMs,
      }),
    ]);
    const get = getProbe.status === "fulfilled" ? getProbe.value : undefined;
    const del =
      deleteProbe.status === "fulfilled" ? deleteProbe.value : undefined;
    const offenders = [
      ...(get && get.status !== 405 ? [`GET got HTTP ${get.status}`] : []),
      ...(del && del.status !== 405 ? [`DELETE got HTTP ${del.status}`] : []),
    ];
    if (offenders.length === 0) {
      return undefined;
    }
    return warning(
      "readiness-session-termination",
      "SHOULD",
      `A 2026-07-28 server SHOULD answer stray GET/DELETE traffic from older clients with HTTP 405 Method Not Allowed; ${offenders.join(
        ", "
      )}`,
      // A probe that never completed is reported as such rather than as a
      // status, so the advice cannot read as though both were observed.
      {
        getStatus: get?.status ?? "not observed",
        deleteStatus: del?.status ?? "not observed",
      }
    );
  }

  const { result, sessionId } = await legacyInitialize(ctx);
  if (result.status < 200 || result.status >= 300 || !sessionId) {
    // No session to terminate — nothing to advise on.
    return undefined;
  }
  const deleteResult = await rawRequest(ctx, {
    method: "DELETE",
    headers: legacyHeaders({
      protocolVersion:
        ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION,
      sessionId,
    }),
    timeoutMs: Math.min(ctx.config.checkTimeout, 3_000),
  });
  // The spec names exactly two answers: terminating the session, and 405 to
  // decline termination (MAY). It names no success code, so any 2xx counts as
  // terminated; every other answer is one the spec never offers.
  if (
    (deleteResult.status >= 200 && deleteResult.status < 300) ||
    deleteResult.status === 405
  ) {
    return undefined;
  }

  return warning(
    "readiness-session-termination",
    "SHOULD",
    `DELETE with the session id got HTTP ${deleteResult.status}. Clients SHOULD send this DELETE when abandoning a session; the server should terminate it (2xx) or decline with 405 Method Not Allowed (MAY)`,
    { status: deleteResult.status }
  );
}

/**
 * Readiness advice that only the raw wire can show. Each probe is independently guarded: readiness is
 * advisory, so a probe that throws contributes nothing and never fails a run.
 */
/**
 * SEP-2243 makes `MCP-Protocol-Version` REQUIRED on every POST and lists a
 * missing standard header among the conditions a server "**MUST** reject …
 * with `400 Bad Request`". It is nonetheless ADVICE and not a check, because
 * the same section grants an explicit escape hatch:
 *
 *   "A server that supports clients implementing protocol versions earlier
 *    than 2025-06-18 … MAY treat a request that omits the header as protocol
 *    version 2025-03-26. A server that does not support such clients MUST
 *    reject a request without the header."
 *
 * Nothing on the wire says which kind of server this is, so a check that
 * demanded rejection would fail conforming legacy-tolerant servers — including
 * the official server SDK, which answers such a request normally. That is
 * exactly the over-strict false positive this program exists to remove, so the
 * observation is reported and never scored.
 *
 * The sibling `modern-missing-method-header-rejected` IS a check: `Mcp-Method`
 * has no carve-out, and the reference implementation rejects without it.
 */
async function protocolVersionHeaderWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    // The header does not exist before 2026-07-28; advising about its absence
    // on a 2025 wire would invent a requirement.
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const result = await rawRequest(ctx, {
    // Deliberately NO `MCP-Protocol-Version`, everything else well-formed —
    // `server/discover` is read-only, so a server that processes it anyway has
    // executed nothing.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": "server/discover",
    },
    body: modernRequestBody({
      id: 9401,
      method: "server/discover",
      protocolVersion: version,
    }),
    timeoutMs: Math.min(ctx.config.checkTimeout, 5_000),
  });

  if (result.status >= 400 || jsonRpcError(result)) {
    // Rejected: the strict reading, and unobjectionable.
    return undefined;
  }

  return informational(
    "readiness-protocol-version-header-required",
    "SHOULD",
    `The server answered a POST carrying no MCP-Protocol-Version header with HTTP ${result.status} and no error. SEP-2243 makes the header REQUIRED on every POST; tolerating its absence is permitted only for servers that still support pre-2025-06-18 clients, and it denies intermediaries the routing signal the header exists to provide`,
    { status: result.status }
  );
}

/**
 * Log level filtering: call the operator's logging tool asking for logs at
 * `logProbe.level` (default `warning`) and look at what comes back.
 *
 * The 2026-07-28 logging page says the server "MAY send" log notifications at
 * or above the requested level. Sending none is allowed, and nothing states
 * lower-level logs as a violation, so both findings are informational. They
 * are still worth showing: the operator told us this tool logs, so silence or
 * lower-level logs usually mean the server's filtering is off.
 *
 * A call that does not complete cleanly proves nothing about filtering, so it
 * yields no advice. Modern era only, and only when a `logProbe` is supplied:
 * no metadata says which tool logs, and advice never calls a tool on a guess.
 */
async function logLevelFilteringWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  const probe = ctx.config.logProbe;
  if (ctx.config.era !== "modern" || !probe) {
    return undefined;
  }
  const level = probe.level ?? "warning";
  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const response = await rawRequest(ctx, {
    headers: {
      ...modernHeaders({
        protocolVersion: version,
        method: "tools/call",
        name: probe.toolName,
      }),
    },
    body: modernRequestBody({
      id: 9403,
      method: "tools/call",
      params: { name: probe.toolName, arguments: probe.arguments ?? {} },
      protocolVersion: version,
      logLevel: level,
    }),
    timeoutMs: ctx.config.checkTimeout,
  });

  const result = jsonRpcResult(response);
  if (
    response.bodyError ||
    response.status < 200 ||
    response.status >= 300 ||
    jsonRpcError(response) ||
    result?.resultType !== "complete" ||
    result.isError === true
  ) {
    return undefined;
  }

  const levels = logRecords(response).map(
    (record) => (record.params as Record<string, unknown> | undefined)?.level
  );
  const details = { probedTool: probe.toolName, requestedLogLevel: level };
  if (levels.length === 0) {
    return informational(
      "readiness-log-level-filtering",
      "MAY",
      `No logs came back when ${JSON.stringify(probe.toolName)} was called asking for "${level}" logs. The spec lets a server send none, but if this tool logs at "${level}" or above, the server may be dropping those logs, or the tool did not log on this call`,
      { ...details, logNotificationCount: 0 }
    );
  }

  const known = MCP_LOG_LEVELS as readonly unknown[];
  const invalidOrLowerLevels = levels.filter(
    (found) =>
      !known.includes(found) || known.indexOf(found) < known.indexOf(level)
  );
  if (invalidOrLowerLevels.length === 0) {
    return undefined;
  }
  return informational(
    "readiness-log-level-filtering",
    "MAY",
    `The server sent logs below the requested "${level}" level, or with an unknown level: ${invalidOrLowerLevels
      .map((found) => JSON.stringify(found) ?? "undefined")
      .join(
        ", "
      )}. The spec only has the server send logs at or above the requested level`,
    { ...details, logNotificationCount: levels.length, invalidOrLowerLevels }
  );
}

export async function collectRawReadiness(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning[]> {
  const probes: Array<
    [MCPReadinessId, () => Promise<MCPReadinessWarning | undefined>]
  > = [
    ["readiness-session-termination", () => sessionTerminationWarning(ctx)],
    [
      "readiness-protocol-version-header-required",
      () => protocolVersionHeaderWarning(ctx),
    ],
    ["readiness-log-level-filtering", () => logLevelFilteringWarning(ctx)],
  ];
  // An advice left out never sends its probe, not just its result.
  const settled = await Promise.allSettled(
    probes
      .filter(([id]) => adviceSelected(ctx.config, id))
      .map(([, probe]) => probe())
  );
  return settled.flatMap((outcome) =>
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
  );
}
