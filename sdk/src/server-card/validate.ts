/**
 * MCP Server Card validation, from `ext-server-card@526201bbc`
 * (`schema.ts` and `docs/discovery.md`). Pure: no I/O.
 *
 * A card is advisory. Nothing here decides security; it reports what the card
 * declares, which required fields are missing, and whether the card
 * contradicts what the running server reported.
 */

export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
/** Appended to the server's Streamable HTTP URL, not to the domain root. */
export const HOSTED_SERVER_CARD_SUFFIX = "/server-card";
export const SERVER_CARD_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

export const SERVER_CARD_REQUIRED_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
] as const;
export type ServerCardRequiredField =
  (typeof SERVER_CARD_REQUIRED_FIELDS)[number];

export const SERVER_CARD_OPTIONAL_FIELDS = [
  "title",
  "websiteUrl",
  "repository",
  "icons",
] as const;
export type ServerCardOptionalField =
  (typeof SERVER_CARD_OPTIONAL_FIELDS)[number];

const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const REMOTE_URL_PATTERN = /^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/;
const REMOTE_TYPES = new Set(["streamable-http", "sse"]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

/** `^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.x` and `1.*` are ranges, not versions. */
function isVersionRange(version: string): boolean {
  return /^[\^~<>=]/.test(version) || /(^|\.)[xX*](\.|$)/.test(version);
}

function requiredFieldValid(
  card: JsonRecord,
  field: ServerCardRequiredField,
): boolean {
  const value = card[field];
  switch (field) {
    case "$schema":
      return value === SERVER_CARD_SCHEMA_URL;
    case "name":
      return isText(value, 3, 200) && NAME_PATTERN.test(value);
    case "version":
      return isText(value, 1, 255) && !isVersionRange(value);
    case "description":
      return isText(value, 1, 100);
  }
}

function optionalFieldPresent(
  card: JsonRecord,
  field: ServerCardOptionalField,
): boolean {
  const value = card[field];
  switch (field) {
    case "title":
      return isText(value, 1, 100);
    case "websiteUrl":
      return typeof value === "string" && value.length > 0;
    case "repository":
      return (
        isRecord(value) &&
        typeof value.url === "string" &&
        typeof value.source === "string"
      );
    case "icons":
      return (
        Array.isArray(value) &&
        value.some((icon) => isRecord(icon) && typeof icon.src === "string")
      );
  }
}

export interface ServerCardRemote {
  type: "streamable-http" | "sse";
  url: string;
  supportedProtocolVersions?: string[];
}

/** Remotes with a known transport type and a URL the schema accepts. */
export function serverCardRemotes(card: unknown): ServerCardRemote[] {
  if (!isRecord(card) || !Array.isArray(card.remotes)) return [];
  const remotes: ServerCardRemote[] = [];
  for (const entry of card.remotes) {
    if (!isRecord(entry)) continue;
    if (typeof entry.type !== "string" || !REMOTE_TYPES.has(entry.type)) continue;
    if (typeof entry.url !== "string" || !REMOTE_URL_PATTERN.test(entry.url)) continue;
    remotes.push({
      type: entry.type as ServerCardRemote["type"],
      url: entry.url,
      ...(Array.isArray(entry.supportedProtocolVersions)
        ? {
            supportedProtocolVersions: entry.supportedProtocolVersions.filter(
              (version): version is string => typeof version === "string",
            ),
          }
        : {}),
    });
  }
  return remotes;
}

export interface ServerCardValidation {
  /** The document is a JSON object; nothing else can be a card. */
  isObject: boolean;
  requiredFieldsOk: boolean;
  /** Required fields that are absent. Invalid but present fields are not listed. */
  missingFields: ServerCardRequiredField[];
  /** Optional fields present in a usable shape. */
  optionalFields: ServerCardOptionalField[];
  remotesListed: boolean;
  hasMeta: boolean;
}

export function validateServerCard(card: unknown): ServerCardValidation {
  if (!isRecord(card)) {
    return {
      isObject: false,
      requiredFieldsOk: false,
      missingFields: [...SERVER_CARD_REQUIRED_FIELDS],
      optionalFields: [],
      remotesListed: false,
      hasMeta: false,
    };
  }
  return {
    isObject: true,
    requiredFieldsOk: SERVER_CARD_REQUIRED_FIELDS.every((field) =>
      requiredFieldValid(card, field),
    ),
    missingFields: SERVER_CARD_REQUIRED_FIELDS.filter(
      (field) => card[field] === undefined || card[field] === null,
    ),
    optionalFields: SERVER_CARD_OPTIONAL_FIELDS.filter((field) =>
      optionalFieldPresent(card, field),
    ),
    remotesListed: serverCardRemotes(card).length > 0,
    hasMeta: isRecord(card._meta),
  };
}

/**
 * The endpoint a URL names, for comparing a card's remotes with the server
 * MCPJam connected to: scheme, host and path, without query, fragment,
 * credentials or a trailing slash.
 */
export function serverCardEndpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/** The remote that names `serverUrl`, if the card lists one. */
export function remoteForEndpoint(
  card: unknown,
  serverUrl: string,
): ServerCardRemote | undefined {
  const target = serverCardEndpointKey(serverUrl);
  if (!target) return undefined;
  return serverCardRemotes(card).find(
    (remote) => serverCardEndpointKey(remote.url) === target,
  );
}

/** What the connected server reported, for the consistency check. */
export interface ServerCardRuntimeFacts {
  serverInfo?: { name?: string; version?: string; title?: string };
  protocolVersion?: string;
  transport?: "streamable-http" | "sse";
  /** The URL MCPJam connected to. */
  serverUrl?: string;
}

/**
 * Whether the card contradicts the running server: `true` when at least one
 * field could be compared and none disagreed, `false` on any disagreement,
 * `null` when nothing could be compared.
 *
 * Names are compared only when the runtime name is itself reverse-DNS, since
 * most servers report a short name at runtime and the card's `name` is a
 * registry identifier.
 */
export function serverCardMatchesRuntime(
  card: unknown,
  runtime: ServerCardRuntimeFacts | undefined,
): boolean | null {
  if (!isRecord(card) || !runtime) return null;
  const verdicts: boolean[] = [];
  const info = runtime.serverInfo ?? {};
  if (typeof card.version === "string" && info.version) {
    verdicts.push(card.version === info.version);
  }
  if (typeof card.title === "string" && info.title) {
    verdicts.push(card.title === info.title);
  }
  if (typeof card.name === "string" && info.name?.includes("/")) {
    verdicts.push(card.name === info.name);
  }
  const remote = runtime.serverUrl
    ? remoteForEndpoint(card, runtime.serverUrl)
    : undefined;
  if (remote && runtime.transport) {
    verdicts.push(remote.type === runtime.transport);
  }
  if (remote?.supportedProtocolVersions?.length && runtime.protocolVersion) {
    verdicts.push(
      remote.supportedProtocolVersions.includes(runtime.protocolVersion),
    );
  }
  if (verdicts.length === 0) return null;
  return verdicts.every(Boolean);
}

export interface AiCatalogCardEntry {
  /** Absolute URL of the card, when the entry points at one. */
  url?: string;
  /** The card itself, when the entry carries it inline. */
  data?: unknown;
}

/**
 * Server Card entries of an AI Catalog document, or `undefined` when the
 * document is not a catalog. Relative entry URLs resolve against the catalog
 * URL; entries that are neither a usable URL nor inline data are dropped.
 */
export function aiCatalogCardEntries(
  catalog: unknown,
  catalogUrl: string,
): AiCatalogCardEntry[] | undefined {
  if (!isRecord(catalog) || !Array.isArray(catalog.entries)) return undefined;
  const entries: AiCatalogCardEntry[] = [];
  for (const entry of catalog.entries) {
    if (!isRecord(entry) || entry.type !== SERVER_CARD_MEDIA_TYPE) continue;
    if (entry.data !== undefined) {
      entries.push({ data: entry.data });
      continue;
    }
    if (typeof entry.url !== "string") continue;
    try {
      entries.push({ url: new URL(entry.url, catalogUrl).toString() });
    } catch {
      // An entry URL that does not parse names no card.
    }
  }
  return entries;
}

/** Content-Type names the Server Card media type, parameters ignored. */
export function isServerCardMediaType(contentType: string | null | undefined): boolean {
  return (
    (contentType ?? "").split(";")[0]?.trim().toLowerCase() ===
    SERVER_CARD_MEDIA_TYPE
  );
}
