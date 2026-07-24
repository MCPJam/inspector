/**
 * 2R-store (SEP-2352) — issuer-keyed credential storage.
 *
 * OAuth client registrations and tokens must be bound to the EXACT
 * authorization-server issuer that granted them. A DCR or pre-registered
 * client id issued for AS A must never be reused when protected-resource
 * metadata later points to AS B.
 *
 * On-disk shape (localStorage), version 2:
 *
 *   { "v": 2, "activeIssuer": "<issuer>", "byIssuer": { "<issuer>": <record> } }
 *
 * Pre-migration records are raw (unversioned) JSON with no issuer binding.
 * They are read only as UNBOUND compatibility state — never stamped with the
 * current issuer on read — and are promoted into `byIssuer` on the first
 * issuer-stamped save (the caller having validated/re-authorized against the
 * current issuer). Once keyed, a request for a DIFFERENT issuer returns
 * nothing, so the flow re-registers (DCR) or surfaces a config error
 * (pre-registered) rather than silently reusing another AS's credential.
 */

export const ISSUER_KEYED_STORAGE_VERSION = 2 as const;

export interface IssuerKeyedStore<T> {
  v: typeof ISSUER_KEYED_STORAGE_VERSION;
  activeIssuer?: string;
  byIssuer: Record<string, T>;
}

export function isIssuerKeyedStore<T>(
  value: unknown,
): value is IssuerKeyedStore<T> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === ISSUER_KEYED_STORAGE_VERSION &&
    typeof (value as { byIssuer?: unknown }).byIssuer === "object" &&
    (value as { byIssuer?: unknown }).byIssuer !== null
  );
}

/**
 * True when `value` carries the v2 version marker (`v === 2`) regardless of
 * whether the rest of the issuer-keyed shape is valid. A record that is
 * version-marked but fails `isIssuerKeyedStore` (e.g. `byIssuer` missing, null,
 * or not an object) is a CORRUPT v2 envelope — NOT a legacy unkeyed record.
 * Callers use this to classify such a record as invalid instead of accepting
 * the raw `{ v: 2, ... }` object as an unbound legacy credential bag.
 */
export function hasIssuerKeyedVersionMarker(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === ISSUER_KEYED_STORAGE_VERSION
  );
}

export interface IssuerKeyedRead<T> {
  value: T | undefined;
  /**
   * True when `value` came from a pre-migration (unkeyed) record and is NOT
   * yet bound to any issuer. The caller must validate / re-authorize against
   * the current issuer before trusting it, and promote it on the next save.
   */
  legacyUnbound: boolean;
}

/**
 * Read the credential bound to `issuer` from a raw localStorage string.
 *
 * @param parseLegacy Narrows a raw (pre-migration) parsed value to `T`, or
 *   returns undefined if it is not a usable legacy record.
 */
export function readIssuerKeyed<T>(
  raw: string | null | undefined,
  issuer: string | undefined,
  parseLegacy: (parsed: unknown) => T | undefined,
): IssuerKeyedRead<T> {
  if (!raw) return { value: undefined, legacyUnbound: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: undefined, legacyUnbound: false };
  }

  if (isIssuerKeyedStore<T>(parsed)) {
    if (issuer) {
      // Return ONLY this exact issuer's bucket. A different issuer (AS change)
      // gets nothing — never reuse another AS's credential (SEP-2352).
      return { value: parsed.byIssuer[issuer], legacyUnbound: false };
    }
    // No issuer context supplied — default to the active issuer's bucket.
    const active = parsed.activeIssuer;
    return {
      value: active ? parsed.byIssuer[active] : undefined,
      legacyUnbound: false,
    };
  }

  // Pre-migration raw record: unbound compatibility state.
  const legacy = parseLegacy(parsed);
  return { value: legacy, legacyUnbound: legacy !== undefined };
}

/**
 * Produce the issuer-keyed record to persist for a keyed save. Promotes the
 * value into `byIssuer[issuer]`, sets `activeIssuer`, and DROPS any legacy
 * unkeyed value (it is superseded by this bound save). Existing buckets for
 * OTHER issuers are preserved.
 */
export function writeIssuerKeyed<T>(
  raw: string | null | undefined,
  issuer: string,
  value: T,
): IssuerKeyedStore<T> {
  let existing: IssuerKeyedStore<T> = {
    v: ISSUER_KEYED_STORAGE_VERSION,
    byIssuer: {},
  };
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isIssuerKeyedStore<T>(parsed)) existing = parsed;
    } catch {
      // Corrupt/legacy raw value — replace with a fresh keyed record.
    }
  }
  return {
    v: ISSUER_KEYED_STORAGE_VERSION,
    activeIssuer: issuer,
    byIssuer: { ...existing.byIssuer, [issuer]: value },
  };
}

/**
 * Remove one issuer's bucket (e.g. DCR discard on an AS change). Returns the
 * updated record, or null when nothing remains (caller should delete the key).
 */
export function removeIssuerBucket<T>(
  raw: string | null | undefined,
  issuer: string,
): IssuerKeyedStore<T> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isIssuerKeyedStore<T>(parsed)) return null;
  const { [issuer]: _removed, ...rest } = parsed.byIssuer;
  if (Object.keys(rest).length === 0) return null;
  return {
    v: ISSUER_KEYED_STORAGE_VERSION,
    activeIssuer:
      parsed.activeIssuer === issuer ? undefined : parsed.activeIssuer,
    byIssuer: rest,
  };
}
