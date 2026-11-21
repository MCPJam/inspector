/**
 * `ProbeValueKeysMap` as data, so a producer can drop anything outside the
 * contract and a test can check a summary against it. Exhaustive both ways:
 * a key here that the map lacks, or a key the map has that is missing here,
 * fails typecheck.
 *
 * Browser-safe and pure.
 */

import type {
  ProbeValue,
  ProbeValueKeysMap,
  ServerProbeId,
} from "./types.js";

export const PROBE_VALUE_KEYS = {
  "http-transport": [
    "status",
    "selectedTransport",
    "streamableHttp",
    "legacySse",
    "responseContentType",
    "sessionIdIssued",
    "protocolVersion",
  ],
  authorization: [
    "oauthRequired",
    "oauthOptional",
    "challengeHasResourceMetadata",
    "nonCompliantChallengeStatus",
    "prmFound",
    "prmResource",
    "prmAuthorizationServers",
    "prmScopesSupported",
    "asMetadataFound",
    "asMetadataKind",
    "issuer",
    "grantTypesSupported",
    "tokenEndpointAuthMethods",
    "codeChallengeMethods",
    "responseTypesSupported",
    "registrationEndpoint",
    "cimdSupported",
    "registrationStrategies",
    "authorizationGrantProfiles",
  ],
  "server-card": [
    "aiCatalogFound",
    "catalogEntryFound",
    "serverCardFound",
    "serverCardUrl",
    "mediaTypeOk",
    "requiredFieldsOk",
    "missingFields",
    "optionalFields",
    "remotesListed",
    "hasMeta",
    "consistentWithRuntime",
    "corsAllowed",
    "cacheControl",
    "https",
  ],
  "apps-ui-resources": [
    "uiResourceCount",
    "readCount",
    "readFailures",
    "abandonedInputRequired",
    "htmlProfileOk",
    "cspDeclared",
    "permissionsDeclared",
    "domainDeclared",
    "prefersBorderDeclared",
  ],
  skills: [
    "listed",
    "count",
    "verified",
    "digestFailures",
    "frontmatterFailures",
    "directoryRead",
  ],
  "events-list": ["listed", "eventCount", "deliveryModes"],
} as const satisfies {
  readonly [P in ServerProbeId]: readonly ProbeValueKeysMap[P][];
};

type Listed<P extends ServerProbeId> = (typeof PROBE_VALUE_KEYS)[P][number];
type Unlisted<P extends ServerProbeId> = Exclude<ProbeValueKeysMap[P], Listed<P>>;

// Fails to compile when the map gains a key this list does not have.
const EVERY_KEY_LISTED: {
  [P in ServerProbeId]: [Unlisted<P>] extends [never] ? true : never;
} = {
  "http-transport": true,
  authorization: true,
  "server-card": true,
  "apps-ui-resources": true,
  skills: true,
  "events-list": true,
};
void EVERY_KEY_LISTED;

/** Most entries a list value may carry; the backend refuses longer ones. */
export const MAX_PROBE_LIST_ENTRIES = 64;
/** Longest string a probe value keeps. */
export const MAX_PROBE_STRING_LENGTH = 512;

function boundedScalar(value: unknown): ProbeValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_PROBE_STRING_LENGTH);
  return undefined;
}

/**
 * The values a probe may store: only its contract keys, scalars or lists of
 * scalars, strings and lists bounded. Anything else is dropped.
 */
export function boundedProbeValues<P extends ServerProbeId>(
  probeId: P,
  values: Readonly<Record<string, unknown>>,
): Partial<Record<ProbeValueKeysMap[P], ProbeValue>> {
  const allowed: readonly string[] = PROBE_VALUE_KEYS[probeId];
  const out: Partial<Record<string, ProbeValue>> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, MAX_PROBE_LIST_ENTRIES)
        .map(boundedScalar)
        .filter(
          (entry): entry is Exclude<ProbeValue, readonly unknown[]> =>
            entry !== undefined && !Array.isArray(entry),
        );
      out[key] = entries;
      continue;
    }
    const scalar = boundedScalar(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  return out as Partial<Record<ProbeValueKeysMap[P], ProbeValue>>;
}
