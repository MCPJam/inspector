/**
 * What decides the Connection and Discovery stages, as the settings page shows it.
 *
 * THE PROBLEM THIS SOLVES. Those two stages have no grader — no predicate kind
 * in `sdk/src/contract/grader-stage.ts` files there — so the settings page said
 * "nothing to configure". That is false in the way that matters to somebody
 * debugging a failed connection: nothing to GRADE, but a great deal to
 * configure, and all of it on the client (host) and server rows rather than the
 * suite. This module answers "which client, which server, over what transport,
 * with which auth, protocol and timeout" so the card can say it.
 *
 * CONFIG STATE, NOT RUN STATE. Every string here describes what a run WOULD
 * connect with. Nothing observed a run, so the run-state vocabulary
 * ("not measured", "passed") never appears — see `stageFactStrings`, which
 * exists so a test can walk every string this module can emit.
 *
 * PURE. No hooks, no I/O. The caller resolves the host and the project's server
 * rows; this decides what they mean. Total and non-throwing: a missing host or
 * server renders a line saying so, because a settings page that blanks out is a
 * worse failure than one showing an unfamiliar row.
 *
 * THE `note` FIELD IS THE POINT. A hosted eval run connects with a single
 * uniform timeout and the host's capabilities; a server row's own `timeout` and
 * `clientCapabilities` are simply not applied on that path. Showing the stored
 * value with no note would be a lie, and hiding it would leave a reader staring
 * at a server page that disagrees with the run. So both are shown, with the
 * note naming which one the run uses.
 */

import { WEB_CALL_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import { extractHostExecutionPolicy } from "@mcpjam/sdk/host-config/internal";
import { protocolVersionLabel } from "@mcpjam/sdk/browser";
import {
  resolveEffectiveMcpProtocolVersion,
  type HostConfigDtoV2,
} from "@/lib/client-config-v2";
import { resolveServerConnectionSettings } from "@/lib/client-connection-resolve";
import { resolveEffectiveClientCapabilities } from "@/lib/effective-client";
import type { RemoteServer } from "@/hooks/useProjects";

export type StageFactLink =
  | { kind: "host"; hostId: string }
  | { kind: "server"; serverId: string | null }
  | { kind: "environment"; environmentId: string };

export type StageFactLine = {
  /** Stable within a render; a React key, not persisted. */
  id: string;
  label: string;
  value: string;
  tone: "set" | "empty" | "attention";
  /** What a stored value says, when a run does not use it. */
  note?: string;
};

export type StageServerFacts = {
  serverId: string;
  name: string;
  /** True when the target lists this id but the project has no such row. */
  missing: boolean;
  lines: StageFactLine[];
  link: StageFactLink;
};

export type StageFacts =
  | { state: "loading"; message: string }
  | { state: "unavailable"; message: string; link?: StageFactLink }
  | {
      state: "ready";
      hostLines: StageFactLine[];
      hostLink: StageFactLink;
      servers: StageServerFacts[];
    };

export type SuiteStageFacts = {
  connection: StageFacts;
  discovery: StageFacts;
};

export type StageFactsTargetInput = {
  hostId: string;
  hostName?: string;
  host: HostConfigDtoV2 | undefined;
  hostState: "loading" | "ready" | "missing";
  /** Server ids this target connects, already resolved by the caller. */
  serverIds: string[];
  /** The project's server rows; `undefined` while the query is in flight. */
  servers: RemoteServer[] | undefined;
  attachment?: { id: string; name: string } | null;
  /** `HOSTED_MODE`. Hosted runs pin one timeout; local runs resolve per server. */
  isHosted: boolean;
};

/** Milliseconds as a person reads them. */
export function formatTimeoutMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Not set";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds} s` : `${seconds.toFixed(1)} s`;
}

/** Every string a facts block can render — the vocabulary test walks this. */
export function stageFactStrings(facts: StageFacts): string[] {
  if (facts.state !== "ready") return [facts.message];
  const fromLines = (lines: StageFactLine[]) =>
    lines.flatMap((line) => [
      line.label,
      line.value,
      ...(line.note ? [line.note] : []),
    ]);
  return [
    ...fromLines(facts.hostLines),
    ...facts.servers.flatMap((server) => [
      server.name,
      ...fromLines(server.lines),
    ]),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Origin only — a full URL can carry a token in its path or query. */
function serverOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function headerNames(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).sort((a, b) => a.localeCompare(b));
}

function describeProtocol(
  serverOverride: HostConfigDtoV2["serverConnectionOverrides"] extends
    Record<string, infer V> | undefined
    ? V | undefined
    : undefined,
  host: HostConfigDtoV2 | undefined,
): string {
  const effective = resolveEffectiveMcpProtocolVersion(
    serverOverride?.mcpProtocolVersionOverride,
    host?.mcpProfile?.mcpProtocolVersion,
  );
  return effective ? protocolVersionLabel(effective) : "Negotiated at connect";
}

/** Advertised capability names, e.g. "roots, sampling, elicitation". */
function describeCapabilities(host: HostConfigDtoV2 | undefined): string {
  const resolved = resolveEffectiveClientCapabilities({
    host: host ?? null,
    serverConfig: null,
  }) as Record<string, unknown>;
  const names = Object.entries(resolved)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));
  return names.length > 0 ? names.join(", ") : "Defaults";
}

function describeClientInfo(host: HostConfigDtoV2 | undefined): string {
  const clientInfo = host?.mcpProfile?.initialize?.clientInfo;
  if (!isRecord(clientInfo)) return "SDK default";
  const name =
    typeof clientInfo.name === "string" ? clientInfo.name : undefined;
  const version =
    typeof clientInfo.version === "string" ? clientInfo.version : undefined;
  if (!name) return "SDK default";
  return version ? `${name}/${version}` : name;
}

function connectionHostLines(input: StageFactsTargetInput): StageFactLine[] {
  const { host, isHosted } = input;
  const lines: StageFactLine[] = [];

  if (isHosted) {
    const hostDefault = host?.connectionDefaults?.requestTimeout;
    const pinned = typeof hostDefault === "number" && hostDefault > 0;
    lines.push({
      id: "timeout",
      label: "Request timeout",
      value: pinned
        ? `${formatTimeoutMs(hostDefault)} · from this client`
        : `${formatTimeoutMs(WEB_CALL_TIMEOUT_MS)} · default for eval runs`,
      tone: "set",
    });
  } else {
    lines.push({
      id: "timeout",
      label: "Request timeout",
      value: "Resolved per server (below)",
      tone: "set",
    });
  }

  lines.push({
    id: "protocolDefault",
    label: "Protocol default",
    value: describeProtocol(undefined, host),
    tone: "set",
  });

  lines.push({
    id: "clientCapabilities",
    label: "Advertises",
    value: describeCapabilities(host),
    tone: "set",
  });

  const identity = describeClientInfo(host);
  const accepts = host?.mcpProfile?.initialize?.supportedProtocolVersions;
  lines.push({
    id: "clientInfo",
    label: "Identifies as",
    value: identity,
    tone: identity === "SDK default" ? "empty" : "set",
    ...(Array.isArray(accepts) && accepts.length > 0
      ? { note: `Accepts: ${accepts.join(", ")}` }
      : {}),
  });

  const hostHeaders = headerNames(host?.connectionDefaults?.headers);
  if (hostHeaders.length > 0) {
    lines.push({
      id: "hostHeaders",
      label: "Client headers",
      value: hostHeaders.join(", "),
      tone: "set",
      ...(isHosted
        ? {
            note: "Client-level headers are not applied by the inspector on eval runs",
          }
        : {}),
    });
  }

  return lines;
}

function connectionServerLines(
  server: RemoteServer,
  input: StageFactsTargetInput,
): StageFactLine[] {
  const { host, isHosted } = input;
  const override = host?.serverConnectionOverrides?.[server._id];
  const isStdio = server.transportType !== "http";
  const lines: StageFactLine[] = [];

  const origin = serverOrigin(server.url);
  lines.push({
    id: "transport",
    label: "Transport",
    value: isStdio ? "STDIO" : origin ? `HTTP · ${origin}` : "HTTP",
    tone: "set",
    ...(isStdio && isHosted
      ? { note: "Hosted eval runs cannot spawn STDIO servers" }
      : {}),
  });

  if (!isStdio) {
    const auth = server.useXaa
      ? "Cross-App Access"
      : server.useOAuth
        ? "OAuth — Bearer added at run time"
        : server.hasBearerToken
          ? "Stored bearer token"
          : "None";
    lines.push({
      id: "auth",
      label: "Auth",
      value: auth,
      tone: auth === "None" ? "empty" : "set",
    });

    const names = headerNames(server.headers);
    const overrideNames = headerNames(override?.headersOverride);
    lines.push({
      id: "headers",
      label: "Headers",
      value:
        names.length > 0
          ? names.join(", ")
          : server.hasHeaders
            ? "Stored headers — names on the server page"
            : "None",
      tone: names.length > 0 || server.hasHeaders ? "set" : "empty",
      ...(overrideNames.length > 0 && isHosted
        ? {
            note: `This client overrides ${overrideNames.join(", ")} — not applied to eval runs`,
          }
        : {}),
    });
  }

  if (isHosted) {
    const stored = server.timeout;
    const overrideTimeout = override?.requestTimeoutOverride;
    const hostTimeout = host?.connectionDefaults?.requestTimeout;
    // What the run will actually use for THIS server: the client's per-server
    // override, else the client's own timeout, else the eval-run default. The
    // server row's own timeout is not in that chain — a hosted run builds its
    // connection from the client, so a value stored on the server is the one
    // fact here a reader would otherwise assume was in force.
    const effective =
      typeof overrideTimeout === "number" && overrideTimeout > 0
        ? { ms: overrideTimeout, source: "client override" }
        : typeof hostTimeout === "number" && hostTimeout > 0
          ? { ms: hostTimeout, source: "from this client" }
          : { ms: WEB_CALL_TIMEOUT_MS, source: "default for eval runs" };
    lines.push({
      id: "timeout",
      label: "Timeout",
      value: `${formatTimeoutMs(effective.ms)} · ${effective.source}`,
      tone: "set",
      ...(typeof stored === "number" && stored !== effective.ms
        ? {
            note: `This server sets ${formatTimeoutMs(stored)} — eval runs use the client's value`,
          }
        : {}),
    });
  } else {
    const resolved = resolveServerConnectionSettings(
      { headers: server.headers, timeout: server.timeout },
      host?.connectionDefaults ?? {
        headers: {},
        requestTimeout: WEB_CALL_TIMEOUT_MS,
      },
      override,
    );
    const source =
      typeof override?.requestTimeoutOverride === "number"
        ? "client override"
        : typeof server.timeout === "number"
          ? "server"
          : "client default";
    lines.push({
      id: "timeout",
      label: "Timeout",
      value: `${formatTimeoutMs(resolved.timeout)} · ${source}`,
      tone: "set",
    });
  }

  lines.push({
    id: "protocol",
    label: "Protocol",
    value: describeProtocol(override, host),
    tone: "set",
  });

  if (server.clientCapabilities !== undefined) {
    lines.push({
      id: "capabilities",
      label: "Capabilities",
      value: "This server overrides the client's capabilities",
      tone: isHosted ? "attention" : "set",
      note: isHosted ? "Not applied to eval runs" : "Applied on local runs",
    });
  }

  return lines;
}

function discoveryHostLines(input: StageFactsTargetInput): StageFactLine[] {
  const { host, hostId, attachment, serverIds } = input;
  const policy = extractHostExecutionPolicy(
    (host as unknown as Record<string, unknown>) ?? null,
    hostId,
  );

  const count = serverIds.length;
  const scope = attachment
    ? `Server group "${attachment.name}" · ${count} ${count === 1 ? "server" : "servers"}`
    : `Client's own servers · ${count}`;

  return [
    {
      id: "serverScope",
      label: "Discovers from",
      value: scope,
      tone: count > 0 ? "set" : "empty",
    },
    {
      id: "toolVisibility",
      label: "Tool visibility",
      value:
        policy.respectToolVisibility === false
          ? "Every tool is sent to the model"
          : "App-only tools are hidden (spec default)",
      tone: policy.respectToolVisibility === false ? "attention" : "set",
    },
    {
      id: "progressiveDiscovery",
      label: "Progressive discovery",
      value: policy.progressiveDiscoveryEnabled
        ? "On — search_mcp_tools / load_mcp_tools"
        : "Off — full tool list each turn",
      tone: "set",
    },
    {
      id: "pagination",
      label: "Pagination",
      value:
        host?.mcpProfile?.paginationTraversal === "firstPageOnly"
          ? "First page only"
          : "Follows every page (spec default)",
      tone:
        host?.mcpProfile?.paginationTraversal === "firstPageOnly"
          ? "attention"
          : "set",
    },
  ];
}

function discoveryServerLines(server: RemoteServer): StageFactLine[] {
  return [
    {
      id: "transport",
      label: "Transport",
      value: server.transportType === "http" ? "HTTP" : "STDIO",
      tone: "set",
    },
  ];
}

/**
 * Facts for one run target — one environment, or one attached client.
 *
 * Both stages resolve from the same inputs, so they are built together: a
 * caller that rendered Connection from one host and Discovery from another
 * would be describing two different runs on one page.
 */
export function buildSuiteStageFacts(
  input: StageFactsTargetInput,
): SuiteStageFacts {
  const hostLink: StageFactLink = { kind: "host", hostId: input.hostId };

  if (input.hostState === "loading" || input.servers === undefined) {
    const loading = {
      state: "loading" as const,
      message: "Loading client settings…",
    };
    return { connection: loading, discovery: loading };
  }

  if (input.hostState === "missing" || !input.host) {
    const unavailable = {
      state: "unavailable" as const,
      message:
        "This client no longer exists — pick another under Where it runs",
      link: hostLink,
    };
    return { connection: unavailable, discovery: unavailable };
  }

  const byId = new Map(input.servers.map((server) => [server._id, server]));
  const resolved = input.serverIds.map((serverId) => ({
    serverId,
    row: byId.get(serverId),
  }));

  const buildServers = (
    lines: (server: RemoteServer) => StageFactLine[],
  ): StageServerFacts[] =>
    resolved.map(({ serverId, row }) =>
      row
        ? {
            serverId,
            name: row.name,
            missing: false,
            lines: lines(row),
            link: { kind: "server" as const, serverId },
          }
        : {
            serverId,
            name: serverId,
            missing: true,
            lines: [
              {
                id: "missing",
                label: "Server",
                value: "No longer in this project",
                tone: "attention" as const,
              },
            ],
            link: { kind: "server" as const, serverId: null },
          },
    );

  return {
    connection: {
      state: "ready",
      hostLines: connectionHostLines(input),
      hostLink,
      servers: buildServers((server) => connectionServerLines(server, input)),
    },
    discovery: {
      state: "ready",
      hostLines: discoveryHostLines(input),
      hostLink,
      servers: buildServers(discoveryServerLines),
    },
  };
}
