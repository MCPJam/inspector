/**
 * What the `data` of an `UnsupportedProtocolVersionError` (`-32022`) has to
 * carry on 2026-07-28.
 *
 * The schema types both members as required (`schema.ts:483-499`):
 *
 *     data: {
 *       supported: string[];   // "Protocol versions the server supports. The
 *                              //  client should choose a mutually supported
 *                              //  version from this list and retry."
 *       requested: string;     // "The protocol version that was requested by
 *                              //  the client."
 *     }
 *
 * A client retries from `supported`, so a list under any other name is a list
 * the client does not find. This module only reads the data; the check decides
 * what a problem costs.
 */

/** The member the schema names. */
const SUPPORTED = "supported";
/** A name some servers use instead. It is not in the schema. */
const SUPPORTED_ALIAS = "supportedVersions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVersionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((version) => typeof version === "string")
  );
}

/** What was read off the error's `data`, for the check's details. */
export interface UnsupportedVersionData {
  /** `data.supported`, when it is a non-empty list of strings. */
  supported?: string[];
  /** `data.requested`, when it is a string. */
  requested?: string;
  /** What is wrong, in the order the schema lists the members. Empty when nothing is. */
  problems: string[];
}

/**
 * Read `error.data` of a `-32022` answer and say what the schema finds
 * missing. With `askedFor`, `requested` must also be that version: it is
 * "the protocol version that was requested by the client".
 */
export function readUnsupportedVersionData(
  data: unknown,
  askedFor?: string
): UnsupportedVersionData {
  if (!isRecord(data)) {
    return {
      problems: [
        "error.data must be an object with the supported protocol versions (supported) and the requested one (requested)",
      ],
    };
  }

  const problems: string[] = [];
  const supported = data[SUPPORTED];
  if (!isVersionList(supported)) {
    problems.push(
      isVersionList(data[SUPPORTED_ALIAS])
        ? `error.data.${SUPPORTED} must list the supported protocol versions as a non-empty array of strings; this error has the list under ${SUPPORTED_ALIAS}, which is not the name the schema gives it`
        : `error.data.${SUPPORTED} must list the supported protocol versions as a non-empty array of strings`
    );
  }
  const requested = data.requested;
  if (typeof requested !== "string") {
    problems.push(
      "error.data.requested must be the protocol version the client asked for, as a string"
    );
  } else if (askedFor !== undefined && requested !== askedFor) {
    problems.push(
      `error.data.requested must be the version the client asked for (${JSON.stringify(askedFor)}); this error has ${JSON.stringify(requested)}`
    );
  }

  return {
    ...(isVersionList(supported) ? { supported } : {}),
    ...(typeof requested === "string" ? { requested } : {}),
    problems,
  };
}
