import { describe, expect, it } from "vitest";
import {
  ISSUER_KEYED_STORAGE_VERSION,
  isIssuerKeyedStore,
  readIssuerKeyed,
  removeIssuerBucket,
  writeIssuerKeyed,
} from "../issuer-keyed-storage";

type Cred = { client_id: string };
const asA = "https://as-a.example.com";
const asB = "https://as-b.example.com";
const parseLegacy = (v: unknown): Cred | undefined =>
  v && typeof v === "object" && typeof (v as Cred).client_id === "string"
    ? { client_id: (v as Cred).client_id }
    : undefined;

describe("issuer-keyed-storage", () => {
  it("writes a v2 record keyed by issuer with activeIssuer set", () => {
    const rec = writeIssuerKeyed<Cred>(null, asA, { client_id: "a" });
    expect(rec).toEqual({
      v: ISSUER_KEYED_STORAGE_VERSION,
      activeIssuer: asA,
      byIssuer: { [asA]: { client_id: "a" } },
    });
    expect(isIssuerKeyedStore(rec)).toBe(true);
  });

  it("returns the bucket for the exact issuer and nothing for another (SEP-2352)", () => {
    const raw = JSON.stringify(writeIssuerKeyed<Cred>(null, asA, { client_id: "a" }));
    expect(readIssuerKeyed<Cred>(raw, asA, parseLegacy).value).toEqual({
      client_id: "a",
    });
    // AS change: a client id issued for AS A must never be reused for AS B.
    expect(readIssuerKeyed<Cred>(raw, asB, parseLegacy).value).toBeUndefined();
  });

  it("preserves other issuers' buckets across writes", () => {
    const raw1 = JSON.stringify(writeIssuerKeyed<Cred>(null, asA, { client_id: "a" }));
    const rec2 = writeIssuerKeyed<Cred>(raw1, asB, { client_id: "b" });
    expect(rec2.byIssuer).toEqual({
      [asA]: { client_id: "a" },
      [asB]: { client_id: "b" },
    });
    expect(rec2.activeIssuer).toBe(asB);
  });

  it("reads a legacy (unversioned) record as unbound compatibility", () => {
    const legacy = JSON.stringify({ client_id: "legacy" });
    const read = readIssuerKeyed<Cred>(legacy, asA, parseLegacy);
    expect(read.value).toEqual({ client_id: "legacy" });
    expect(read.legacyUnbound).toBe(true);
  });

  it("promotes a legacy value into byIssuer on the first keyed save and drops the legacy form", () => {
    const legacy = JSON.stringify({ client_id: "legacy" });
    const promoted = writeIssuerKeyed<Cred>(legacy, asA, { client_id: "legacy" });
    expect(promoted).toEqual({
      v: ISSUER_KEYED_STORAGE_VERSION,
      activeIssuer: asA,
      byIssuer: { [asA]: { client_id: "legacy" } },
    });
    // Once keyed, a later different-issuer read gets nothing (no legacy reuse).
    const raw = JSON.stringify(promoted);
    expect(readIssuerKeyed<Cred>(raw, asB, parseLegacy).value).toBeUndefined();
    expect(readIssuerKeyed<Cred>(raw, asB, parseLegacy).legacyUnbound).toBe(false);
  });

  it("returns nothing (no legacy fallback) once a v2 record exists but lacks the issuer", () => {
    const raw = JSON.stringify(writeIssuerKeyed<Cred>(null, asA, { client_id: "a" }));
    const read = readIssuerKeyed<Cred>(raw, asB, parseLegacy);
    expect(read.value).toBeUndefined();
    expect(read.legacyUnbound).toBe(false);
  });

  it("defaults to the active issuer when no issuer context is supplied", () => {
    const raw = JSON.stringify(writeIssuerKeyed<Cred>(null, asA, { client_id: "a" }));
    expect(readIssuerKeyed<Cred>(raw, undefined, parseLegacy).value).toEqual({
      client_id: "a",
    });
  });

  it("is idempotent: re-saving the same issuer/value yields an equal record", () => {
    const raw1 = JSON.stringify(writeIssuerKeyed<Cred>(null, asA, { client_id: "a" }));
    const rec2 = writeIssuerKeyed<Cred>(raw1, asA, { client_id: "a" });
    expect(JSON.stringify(rec2)).toBe(raw1);
  });

  it("removeIssuerBucket drops one issuer, keeps others, and clears a matching activeIssuer", () => {
    const raw = JSON.stringify({
      v: ISSUER_KEYED_STORAGE_VERSION,
      activeIssuer: asA,
      byIssuer: { [asA]: { client_id: "a" }, [asB]: { client_id: "b" } },
    });
    const after = removeIssuerBucket<Cred>(raw, asA);
    expect(after).toEqual({
      v: ISSUER_KEYED_STORAGE_VERSION,
      activeIssuer: undefined,
      byIssuer: { [asB]: { client_id: "b" } },
    });
    // Removing the last bucket returns null (caller deletes the key).
    const empty = removeIssuerBucket<Cred>(JSON.stringify(after), asB);
    expect(empty).toBeNull();
  });

  it("treats corrupt JSON as absent on read and replaces it on write", () => {
    expect(readIssuerKeyed<Cred>("{not json", asA, parseLegacy).value).toBeUndefined();
    const rec = writeIssuerKeyed<Cred>("{not json", asA, { client_id: "a" });
    expect(rec.byIssuer).toEqual({ [asA]: { client_id: "a" } });
  });
});
