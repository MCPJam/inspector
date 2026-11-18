/**
 * Server Card discovery for one HTTP MCP server, written as a conformance-style
 * read-only check: the AI Catalog at `/.well-known/ai-catalog.json` on the
 * server's origin first, then the hosted `<streamable-http-url>/server-card`.
 *
 * Read-only and credential-free. Every request is a GET with only an `Accept`
 * header: no Authorization, no cookies, no configured headers, and never the
 * configured URL's query or user info, which can carry secrets. A card URL the
 * catalog names is a destination the server chose, so it is dialled only when
 * it is on the server's own origin. Redirects are followed by `fetchFn` and
 * only where they landed is checked: when the metadata destination guard
 * `probeMcpServer` applies refuses the landing, its response is discarded
 * unread. With the default `fetch` every hop has been requested by then, so
 * callers that run on shared infrastructure pass a pinned `fetchFn` that
 * resolves once and re-checks every hop before dialling it.
 *
 * Only a 2xx answer finds a document. 404 and 410 settle that there is none,
 * and so does 405: the location exists but serves no GET, so it serves no
 * card. Any other status (5xx, 429, 401, a redirect left unfollowed) says
 * nothing either way, so it leaves coverage `partial` rather than reporting a
 * missing card.
 *
 * The result is a `ProbeSummary<"server-card">` with exactly the value keys in
 * `ProbeValueKeysMap["server-card"]`. Stored URLs carry no query or user info.
 */

import {
  linkAbortSignal,
  readBoundedText,
} from "../directory-readiness/discovery.js";
import { assertMetadataDestinationAllowed } from "../oauth/metadata-discovery.js";
import { boundedProbeValues } from "../server-features/probe-value-keys.js";
import type {
  CoverageState,
  ProbeStatus,
  ProbeSummary,
  ProbeValue,
  ProbeValueKeysMap,
} from "../server-features/types.js";
import {
  AI_CATALOG_MEDIA_TYPE,
  AI_CATALOG_PATH,
  HOSTED_SERVER_CARD_SUFFIX,
  SERVER_CARD_MEDIA_TYPE,
  aiCatalogCardEntries,
  serverCardEndpointKey,
  isServerCardMediaType,
  remoteForEndpoint,
  serverCardMatchesRuntime,
  validateServerCard,
  type AiCatalogCardEntry,
  type ServerCardRuntimeFacts,
} from "./validate.js";

export interface ServerCardProbeConfig {
  /** The server's Streamable HTTP URL as configured. */
  serverUrl: string;
  /** What the connected server reported; absent skips the consistency check. */
  runtime?: ServerCardRuntimeFacts;
  fetchFn?: typeof fetch;
  /** Per request. */
  timeoutMs?: number;
  /** Cancels the request in flight; the probe sends nothing after it fires. */
  signal?: AbortSignal;
  /**
   * Keep a response whose redirects landed on a private address. Without it
   * that response is discarded, though the request to the address has been
   * sent unless `fetchFn` checks every hop. Set it only when the server URL is
   * itself private, so a public server cannot steer the probe at loopback or
   * the LAN; hosted callers leave it unset.
   */
  allowPrivateNetwork?: boolean;
  now?: () => number;
}

type CardKey = ProbeValueKeysMap["server-card"];

export const SERVER_CARD_REQUEST_TIMEOUT_MS = 5_000;
/** Catalog entries whose card is fetched to find this server's. */
export const MAX_CATALOG_CARD_FETCHES = 3;
/** Larger documents are not read. Cards and catalogs are small. */
export const MAX_SERVER_CARD_DOCUMENT_BYTES = 256 * 1024;

interface Fetched {
  url: string;
  status: number;
  headers: Headers;
  body?: unknown;
}

type FetchOutcome =
  | { kind: "answered"; response: Fetched }
  | { kind: "refused" }
  | { kind: "unreachable" };

/** A body over {@link MAX_SERVER_CARD_DOCUMENT_BYTES}, which was not read. */
const OVERSIZE = Symbol("oversize");

const CANCELLED =
  "The Server Card lookup was cancelled before it finished. Run it again to check for a card.";

function cancelled(config: ServerCardProbeConfig): boolean {
  return config.signal?.aborted === true;
}

function isFound(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A 2xx finds the document; 404, 405 and 410 settle that there is none. */
function settles(
  outcome: FetchOutcome,
): outcome is Extract<FetchOutcome, { kind: "answered" }> {
  if (outcome.kind !== "answered") return false;
  const { status, body } = outcome.response;
  if (isFound(status)) return body !== OVERSIZE;
  return status === 404 || status === 405 || status === 410;
}

/** Whether `candidate` is on the server's own scheme and host. */
function onServerOrigin(candidate: string, serverUrl: string): boolean {
  try {
    const target = new URL(candidate);
    const server = new URL(serverUrl);
    return (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.protocol === server.protocol &&
      target.host === server.host
    );
  } catch {
    // Unparseable: not the server's origin.
    return false;
  }
}

/** `serverUrl` without query, fragment or user info; `undefined` if unusable. */
export function serverCardBaseUrl(serverUrl: string): URL | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

/** The hosted card location: the Streamable HTTP URL plus `/server-card`. */
export function hostedServerCardUrl(base: URL): string {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${HOSTED_SERVER_CARD_SUFFIX}`;
  return url.toString();
}

/** A URL as it may be stored: no query, fragment or user info. */
function storableUrl(url: string): string | null {
  return serverCardBaseUrl(url)?.toString() ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Releases the connection behind a body the probe does not read. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancelling fails only for a body that has already errored, which holds
    // nothing left to release.
  }
}

/** The parsed body, stopping at the size cap; {@link OVERSIZE} past it. */
async function readBoundedJson(
  response: Response,
): Promise<unknown | typeof OVERSIZE> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SERVER_CARD_DOCUMENT_BYTES) {
    await discardBody(response);
    return OVERSIZE;
  }
  const text = await readBoundedText(response, MAX_SERVER_CARD_DOCUMENT_BYTES);
  return text === undefined ? OVERSIZE : parseJson(text);
}

async function getDocument(
  config: ServerCardProbeConfig,
  url: string,
  accept: string,
  sameOriginOnly: boolean,
): Promise<FetchOutcome> {
  const fetchFn = config.fetchFn ?? fetch;
  if (sameOriginOnly && !onServerOrigin(url, config.serverUrl)) {
    return { kind: "refused" };
  }
  const controller = new AbortController();
  const detachCaller = linkAbortSignal(config.signal, controller);
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? SERVER_CARD_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    // Where a redirect landed is the server's choice too. Every hop has been
    // requested already, so a refused landing only has its response
    // discarded. A fetch that reports no URL leaves nothing to check, which is
    // why shared callers pass a pinned fetch that guards every hop itself.
    if (response.url && response.url !== url) {
      try {
        assertMetadataDestinationAllowed(
          response.url,
          config.serverUrl,
          config.allowPrivateNetwork,
        );
      } catch {
        await discardBody(response);
        return { kind: "refused" };
      }
    }
    const found = isFound(response.status);
    if (!found) await discardBody(response);
    return {
      kind: "answered",
      response: {
        url: response.url || url,
        status: response.status,
        headers: response.headers,
        body: found ? await readBoundedJson(response) : undefined,
      },
    };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
    detachCaller();
  }
}

interface FoundCard {
  card: unknown;
  /** The response that served the card (the catalog's, for inline data). */
  servedBy: Fetched;
  /** Where the card lives; the catalog URL for inline data. */
  url: string;
  mediaTypeOk: boolean;
}

function cardFromResponse(response: Fetched): FoundCard | undefined {
  if (!isFound(response.status) || response.body === OVERSIZE) return undefined;
  if (!validateServerCard(response.body).isObject) return undefined;
  return {
    card: response.body,
    servedBy: response,
    url: response.url,
    mediaTypeOk: isServerCardMediaType(response.headers.get("content-type")),
  };
}

/** Catalog entries most likely to be this server's card first. */
function orderEntries(
  entries: AiCatalogCardEntry[],
  hostedUrl: string,
): AiCatalogCardEntry[] {
  const hosted = serverCardEndpointKey(hostedUrl);
  return [...entries].sort(
    (a, b) =>
      Number(b.url !== undefined && serverCardEndpointKey(b.url) === hosted) -
      Number(a.url !== undefined && serverCardEndpointKey(a.url) === hosted),
  );
}

/** The catalog entry describing this server: its URL is the hosted card, or its card lists this endpoint. */
async function findCatalogCard(
  config: ServerCardProbeConfig,
  catalog: Fetched,
  entries: AiCatalogCardEntry[],
  hostedUrl: string,
  note: (outcome: FetchOutcome) => void,
): Promise<FoundCard | undefined> {
  let fetches = 0;
  for (const entry of orderEntries(entries, hostedUrl)) {
    if (cancelled(config)) return undefined;
    if (entry.data !== undefined) {
      if (remoteForEndpoint(entry.data, config.serverUrl)) {
        return {
          card: entry.data,
          servedBy: catalog,
          url: catalog.url,
          mediaTypeOk: true,
        };
      }
      continue;
    }
    if (entry.url === undefined || fetches >= MAX_CATALOG_CARD_FETCHES) continue;
    fetches += 1;
    const outcome = await getDocument(
      config,
      entry.url,
      SERVER_CARD_MEDIA_TYPE,
      true,
    );
    note(outcome);
    if (outcome.kind !== "answered") continue;
    const found = cardFromResponse(outcome.response);
    if (
      found &&
      (serverCardEndpointKey(entry.url) === serverCardEndpointKey(hostedUrl) ||
        remoteForEndpoint(found.card, config.serverUrl))
    ) {
      return found;
    }
  }
  return undefined;
}

function summary(
  config: ServerCardProbeConfig,
  status: ProbeStatus,
  coverage: CoverageState,
  values: Partial<Record<CardKey, ProbeValue>>,
  detail?: string,
): ProbeSummary<"server-card"> {
  return {
    probeId: "server-card",
    status,
    coverage,
    at: (config.now ?? Date.now)(),
    ...(detail ? { detail } : {}),
    values: boundedProbeValues("server-card", values),
  };
}

function cancelledSummary(
  config: ServerCardProbeConfig,
): ProbeSummary<"server-card"> {
  return summary(config, "abandoned", "not-captured", {}, CANCELLED);
}

/**
 * Looks for this server's card and grades it. Never throws: an unusable URL
 * is a `failed` summary, a request that got no answer leaves coverage
 * `partial`, and a cancelled probe is `abandoned` with nothing captured.
 */
export async function probeServerCard(
  config: ServerCardProbeConfig,
): Promise<ProbeSummary<"server-card">> {
  const base = serverCardBaseUrl(config.serverUrl);
  if (!base) {
    return summary(
      config,
      "failed",
      "not-captured",
      {},
      "The server URL is not an HTTP URL.",
    );
  }
  if (cancelled(config)) return cancelledSummary(config);
  const hostedUrl = hostedServerCardUrl(base);
  let answered = 0;
  let missed = 0;
  const note = (outcome: FetchOutcome) => {
    if (settles(outcome)) answered += 1;
    else missed += 1;
  };

  const values: Partial<Record<CardKey, ProbeValue>> = {};
  const catalogUrl = new URL(AI_CATALOG_PATH, base.origin).toString();
  const catalog = await getDocument(
    config,
    catalogUrl,
    `${AI_CATALOG_MEDIA_TYPE}, application/json`,
    false,
  );
  note(catalog);
  if (cancelled(config)) return cancelledSummary(config);
  let found: FoundCard | undefined;
  if (settles(catalog)) {
    const entries = isFound(catalog.response.status)
      ? aiCatalogCardEntries(catalog.response.body, catalog.response.url)
      : undefined;
    values.aiCatalogFound = entries !== undefined;
    if (entries !== undefined) {
      found = await findCatalogCard(
        config,
        catalog.response,
        entries,
        hostedUrl,
        note,
      );
      if (cancelled(config)) return cancelledSummary(config);
      values.catalogEntryFound = found !== undefined;
    }
  }

  if (!found) {
    const hosted = await getDocument(config, hostedUrl, SERVER_CARD_MEDIA_TYPE, false);
    note(hosted);
    if (cancelled(config)) return cancelledSummary(config);
    if (hosted.kind === "answered") found = cardFromResponse(hosted.response);
  }

  if (answered === 0) {
    return summary(
      config,
      "failed",
      "not-captured",
      values,
      "Neither the AI Catalog nor the hosted Server Card location gave a usable answer.",
    );
  }
  const coverage: CoverageState = missed > 0 ? "partial" : "complete";
  values.serverCardFound = found !== undefined;
  values.serverCardUrl = found ? storableUrl(found.url) : null;
  if (!found) return summary(config, "ok", coverage, values);

  const validation = validateServerCard(found.card);
  const servedBy = found.servedBy;
  const servedUrl = serverCardBaseUrl(servedBy.url);
  values.mediaTypeOk = found.mediaTypeOk;
  values.requiredFieldsOk = validation.requiredFieldsOk;
  values.missingFields = validation.missingFields;
  values.optionalFields = validation.optionalFields;
  values.remotesListed = validation.remotesListed;
  values.hasMeta = validation.hasMeta;
  values.consistentWithRuntime = serverCardMatchesRuntime(found.card, {
    ...config.runtime,
    serverUrl: config.runtime?.serverUrl ?? config.serverUrl,
  });
  values.corsAllowed = Boolean(
    servedBy.headers.get("access-control-allow-origin")?.trim(),
  );
  values.cacheControl = Boolean(servedBy.headers.get("cache-control")?.trim());
  values.https = servedUrl?.protocol === "https:";
  return summary(config, "ok", coverage, values);
}
