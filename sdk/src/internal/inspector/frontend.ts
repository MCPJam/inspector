import { operationalError } from "./errors.js";
import {
  canonicalizeInspectorFrontendUrl,
  formatUrlHostname,
  getUrlHostname,
  getUrlPort,
  getUrlProtocol,
  isLoopbackHostname,
  normalizeInspectorFrontendUrl,
} from "./urls.js";

const FRONTEND_PROBE_TIMEOUT_MS = 750;
const ORIGIN_PROBE_TIMEOUT_MS = 750;
const FRONTEND_PORT_SCAN_WINDOW = 10;
const WELL_KNOWN_FRONTEND_PORTS = [5173, 5174, 5175, 8080];

export async function resolveInspectorBrowserBaseUrl(
  baseUrl: string,
  frontendUrl?: string,
  options: { skipDiscovery?: boolean } = {},
): Promise<string> {
  const fastResolution = await resolveInspectorBrowserBaseUrlFast(
    baseUrl,
    frontendUrl,
  );
  if (fastResolution.browserBaseUrl) {
    return fastResolution.browserBaseUrl;
  }

  if (options.skipDiscovery) {
    assertFastFrontendMismatch(fastResolution.candidates);
    return fastResolution.normalizedFrontendUrl ?? baseUrl;
  }

  const discoveredCandidates = await discoverLocalInspectorFrontendCandidates(
    baseUrl,
    fastResolution.normalizedFrontendUrl,
  );

  const usableDiscoveredCandidate = discoveredCandidates.find(
    isUsableInspectorFrontendCandidate,
  );
  if (usableDiscoveredCandidate) {
    return usableDiscoveredCandidate.url;
  }

  const candidates = [...fastResolution.candidates, ...discoveredCandidates];
  assertFullFrontendMismatch(candidates);

  return fastResolution.normalizedFrontendUrl ?? baseUrl;
}

interface InspectorBrowserBaseUrlFastResolution {
  browserBaseUrl?: string;
  candidates: InspectorFrontendCandidate[];
  normalizedFrontendUrl?: string;
}

async function resolveInspectorBrowserBaseUrlFast(
  baseUrl: string,
  frontendUrl?: string,
): Promise<InspectorBrowserBaseUrlFastResolution> {
  const normalizedFrontendUrl = canonicalizeInspectorFrontendUrl(
    baseUrl,
    normalizeInspectorFrontendUrl(frontendUrl),
  );
  const targets: Array<{
    source: InspectorFrontendCandidate["source"];
    url: string;
  }> = [];

  if (normalizedFrontendUrl) {
    targets.push({ source: "advertised", url: normalizedFrontendUrl });
  }
  if (!targets.some((target) => target.url === baseUrl)) {
    targets.push({ source: "base", url: baseUrl });
  }

  const candidates = await inspectInspectorFrontendCandidates(
    baseUrl,
    targets,
  );
  const usableCandidate = candidates.find(isUsableInspectorFrontendCandidate);

  return {
    ...(usableCandidate
      ? { browserBaseUrl: usableCandidate.url }
      : {}),
    candidates,
    ...(normalizedFrontendUrl ? { normalizedFrontendUrl } : {}),
  };
}

async function inspectInspectorFrontendCandidates(
  apiBaseUrl: string,
  targets: ReadonlyArray<{
    source: InspectorFrontendCandidate["source"];
    url: string;
  }>,
): Promise<InspectorFrontendCandidate[]> {
  const settled = await Promise.allSettled(
    targets.map((target) =>
      inspectInspectorFrontendCandidate(apiBaseUrl, target.url, target.source),
    ),
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const target = targets[index]!;
    return {
      isFrontend: false,
      originStatus: "unknown",
      source: target.source,
      url: target.url,
    };
  });
}

function assertFastFrontendMismatch(
  candidates: InspectorFrontendCandidate[],
): void {
  const advertisedCandidate = candidates.find(
    (candidate) => candidate.source === "advertised",
  );
  const rejectedLiveCandidate = candidates.find(
    (candidate) => candidate.isFrontend && candidate.originStatus === "rejected",
  );

  if (!rejectedLiveCandidate) {
    return;
  }

  if (advertisedCandidate === rejectedLiveCandidate) {
    throw frontendMismatchError(undefined, rejectedLiveCandidate);
  }
  throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
}

function assertFullFrontendMismatch(
  candidates: InspectorFrontendCandidate[],
): void {
  const advertisedCandidate = candidates.find(
    (candidate) => candidate.source === "advertised",
  );
  const rejectedLiveCandidate = candidates.find(
    (candidate) =>
      candidate !== advertisedCandidate &&
      candidate.isFrontend &&
      candidate.originStatus === "rejected",
  );

  if (
    advertisedCandidate?.isFrontend &&
    advertisedCandidate.originStatus === "rejected"
  ) {
    throw frontendMismatchError(undefined, advertisedCandidate);
  }

  if (
    advertisedCandidate &&
    !advertisedCandidate.isFrontend &&
    advertisedCandidate.originStatus === "accepted"
  ) {
    throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
  }

  if (rejectedLiveCandidate) {
    throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
  }
}

export async function resolveInspectorBrowserBaseUrlForHealth(
  baseUrl: string,
  frontendUrl: string | undefined,
  options: {
    hasActiveClient: boolean;
    openBrowser: boolean;
    skipDiscovery?: boolean;
  },
): Promise<string> {
  const skipDiscovery =
    options.skipDiscovery || (options.hasActiveClient && !options.openBrowser);
  try {
    return await resolveInspectorBrowserBaseUrl(baseUrl, frontendUrl, {
      skipDiscovery,
    });
  } catch (error) {
    if (options.hasActiveClient && !options.openBrowser) {
      return (
        canonicalizeInspectorFrontendUrl(
          baseUrl,
          normalizeInspectorFrontendUrl(frontendUrl),
        ) ?? baseUrl
      );
    }
    throw error;
  }
}

type InspectorOriginStatus = "accepted" | "rejected" | "unknown";

interface InspectorFrontendCandidate {
  isFrontend: boolean;
  originStatus: InspectorOriginStatus;
  source: "advertised" | "base" | "discovered";
  url: string;
}

async function isInspectorFrontendUrl(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(FRONTEND_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      return false;
    }

    const body = await response.text();
    return (
      hasInspectorFrontendMarker(body) ||
      /<title>\s*MCPJam Inspector\s*<\/title>/i.test(body) ||
      body.includes("/mcp_jam.svg")
    );
  } catch {
    return false;
  }
}

function hasInspectorFrontendMarker(body: string): boolean {
  return /<meta\b(?=[^>]*\bname=["']mcpjam-inspector["'])[^>]*>/i.test(body);
}

async function inspectInspectorFrontendCandidate(
  apiBaseUrl: string,
  frontendBaseUrl: string,
  source: InspectorFrontendCandidate["source"],
): Promise<InspectorFrontendCandidate> {
  const [isFrontend, originStatus] = await Promise.all([
    isInspectorFrontendUrl(frontendBaseUrl),
    getInspectorApiOriginStatus(apiBaseUrl, frontendBaseUrl),
  ]);

  return {
    isFrontend,
    originStatus,
    source,
    url: frontendBaseUrl,
  };
}

function isUsableInspectorFrontendCandidate(
  candidate: InspectorFrontendCandidate,
): boolean {
  return candidate.isFrontend && candidate.originStatus !== "rejected";
}

async function getInspectorApiOriginStatus(
  apiBaseUrl: string,
  frontendBaseUrl: string,
): Promise<InspectorOriginStatus> {
  try {
    const origin = new URL(frontendBaseUrl).origin;
    const response = await fetch(`${apiBaseUrl}/api/session-token`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(ORIGIN_PROBE_TIMEOUT_MS),
    });
    return response.status === 403 ? "rejected" : "accepted";
  } catch {
    return "unknown";
  }
}

function frontendMismatchError(
  advertisedCandidate: InspectorFrontendCandidate | undefined,
  rejectedLiveCandidate: InspectorFrontendCandidate | undefined,
) {
  const details = {
    ...(advertisedCandidate
      ? {
          advertisedFrontendUrl: advertisedCandidate.url,
          advertisedFrontendReachable: advertisedCandidate.isFrontend,
          advertisedOriginStatus: advertisedCandidate.originStatus,
        }
      : {}),
    ...(rejectedLiveCandidate
      ? {
          rejectedFrontendUrl: rejectedLiveCandidate.url,
          rejectedOriginStatus: rejectedLiveCandidate.originStatus,
        }
      : {}),
  };

  if (advertisedCandidate && rejectedLiveCandidate) {
    return operationalError(
      `Inspector backend advertises ${advertisedCandidate.url}, but no Inspector frontend responded there. A frontend was found at ${rejectedLiveCandidate.url}, but the Inspector backend rejects that origin. Start Inspector's frontend on the advertised URL or restart Inspector with matching frontend/backend ports.`,
      details,
    );
  }

  if (advertisedCandidate) {
    return operationalError(
      `Inspector backend advertises ${advertisedCandidate.url}, but no Inspector frontend responded there. Start Inspector's frontend on the advertised URL or restart Inspector with matching frontend/backend ports.`,
      details,
    );
  }

  return operationalError(
    `Inspector frontend ${
      rejectedLiveCandidate?.url ?? "URL"
    } is reachable, but the Inspector backend rejects that origin. Restart Inspector with matching frontend/backend ports.`,
    details,
  );
}

async function discoverLocalInspectorFrontendCandidates(
  baseUrl: string,
  frontendUrl?: string,
): Promise<InspectorFrontendCandidate[]> {
  const hosts = getLocalInspectorCandidateHosts(baseUrl, frontendUrl);
  if (hosts.length === 0) {
    return [];
  }

  const protocol =
    getUrlProtocol(frontendUrl) ?? getUrlProtocol(baseUrl) ?? "http:";
  const targets: string[] = [];
  for (const port of getFrontendProbePorts(frontendUrl)) {
    for (const host of hosts) {
      const candidate = `${protocol}//${formatUrlHostname(host)}:${port}`;
      if (candidate === frontendUrl || candidate === baseUrl) {
        continue;
      }
      targets.push(candidate);
    }
  }

  const inspectedCandidates = await inspectInspectorFrontendCandidates(
    baseUrl,
    targets.map((candidate) => ({
      source: "discovered" as const,
      url: candidate,
    })),
  );
  return inspectedCandidates.filter((candidate) => candidate.isFrontend);
}

function getLocalInspectorCandidateHosts(
  baseUrl: string,
  frontendUrl?: string,
): string[] {
  const hosts = new Set<string>();
  for (const value of [frontendUrl, baseUrl]) {
    const hostname = getUrlHostname(value);
    if (!hostname || !isLoopbackHostname(hostname)) {
      continue;
    }
    hosts.add(hostname);
    if (hostname === "localhost") {
      hosts.add("127.0.0.1");
    }
    if (hostname === "127.0.0.1") {
      hosts.add("localhost");
    }
  }
  return [...hosts];
}

function getFrontendProbePorts(frontendUrl?: string): number[] {
  const ports = new Set<number>();
  const hintedPort = getUrlPort(frontendUrl);
  if (hintedPort) {
    ports.add(hintedPort);
    for (let offset = 1; offset <= FRONTEND_PORT_SCAN_WINDOW; offset += 1) {
      ports.add(hintedPort + offset);
    }
  }
  for (const port of WELL_KNOWN_FRONTEND_PORTS) {
    ports.add(port);
  }
  return [...ports].filter((port) => port > 0 && port < 65_536);
}
