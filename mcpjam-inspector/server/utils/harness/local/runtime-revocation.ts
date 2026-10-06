/**
 * Revoked runtime packs: a small list, signed with the pack key, that names
 * pack tree digests no Inspector may select again — not as desired, not as a
 * fallback (invariant 4).
 *
 * ── Where it comes from ──────────────────────────────────────────────────
 * `mcpjam-inspector/local-harness-revocations/revocations.json` in the
 * repository, signed by `.github/workflows/local-harness-revocations.yml` in
 * the same protected environment as the packs and merged through a reviewed
 * bot PR, then served from main (`MCPJAM_LOCAL_HARNESS_REVOCATIONS_URL`
 * overrides the URL, e.g. for an mcpjam.com front or an internal mirror). It is fetched alongside update checks — at boot and with the
 * Playground's readiness check, at most every few hours — and CACHED under the
 * runtime root, so a machine offline after a revocation still honours it.
 *
 * ── What is trusted ──────────────────────────────────────────────────────
 * Only a list whose detached signature verifies against a key this build
 * carries, and only one at least as new (by `sequence`) as the one already
 * cached: a replayed older list cannot un-revoke a pack. The cache is
 * re-verified every time it is read, so a hand-edited cache is ignored, not
 * believed. Selection never touches the network: it reads the cache.
 *
 * ── What a revocation does ───────────────────────────────────────────────
 * Selection skips the digest. A revoked DESIRED pack is never downloaded; if
 * the permitted previous pack is installed and not revoked, sessions run on
 * it, and otherwise launch fails closed with a message saying so.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import { verifyPackManifestSignature, type PackSigningKey, PACK_SIGNING_KEYS } from "./pack-signing-key.js";
import { runtimeInstallRoot } from "./runtime-root.js";

export const REVOCATION_SCHEMA = "mcpjam.local-harness-revocations/1";

/**
 * The list as merged on main (its `.sig` beside it). A raw file rather than a
 * release asset: releases are immutable, and a revocation list is the one
 * artifact that must change in place — its `sequence` is what makes that safe.
 */
export const DEFAULT_REVOCATIONS_URL =
  "https://raw.githubusercontent.com/MCPJam/inspector/main/mcpjam-inspector/local-harness-revocations/revocations.json";

/** How often a background caller may refetch. Explicit refreshes ignore it. */
export const REVOCATION_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_LIST_BYTES = 256 * 1024;

export interface RevokedPack {
  harnessId: string;
  treeDigest: string;
  reason: string;
}

export interface RevocationList {
  schema: typeof REVOCATION_SCHEMA;
  /** Strictly increasing per published list; replays of older ones are refused. */
  sequence: number;
  issuedAt: string;
  revoked: RevokedPack[];
}

export type ParsedRevocations =
  | { ok: true; list: RevocationList }
  | { ok: false; message: string };

let trustedKeys: readonly PackSigningKey[] = PACK_SIGNING_KEYS;

/** Test seam: a test cannot sign with MCPJam's key, so it brings its own. */
export function setRevocationKeysForTests(keys: readonly PackSigningKey[] | null): void {
  trustedKeys = keys ?? PACK_SIGNING_KEYS;
}

/** Verify and parse a list and its detached base64 signature. */
export function parseRevocationList(
  bytes: Buffer,
  signature: string,
  keys: readonly PackSigningKey[] = trustedKeys,
): ParsedRevocations {
  if (bytes.length > MAX_LIST_BYTES) return { ok: false, message: "the revocation list is implausibly large" };
  const verified = verifyPackManifestSignature(bytes, signature, keys);
  if (!verified.ok) return { ok: false, message: `the revocation list is not signed by MCPJam: ${verified.message}` };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, message: "the revocation list is not JSON" };
  }
  const list = raw as Partial<RevocationList> | null;
  if (
    list === null ||
    list.schema !== REVOCATION_SCHEMA ||
    !Number.isSafeInteger(list.sequence) ||
    (list.sequence ?? -1) < 0 ||
    typeof list.issuedAt !== "string" ||
    !Array.isArray(list.revoked)
  ) {
    return { ok: false, message: "the revocation list has the wrong shape" };
  }
  for (const entry of list.revoked) {
    if (
      typeof entry?.harnessId !== "string" ||
      typeof entry?.treeDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.treeDigest) ||
      typeof entry?.reason !== "string"
    ) {
      return { ok: false, message: "the revocation list has a malformed entry" };
    }
  }
  return { ok: true, list: list as RevocationList };
}

/** Is this pack revoked by this list? */
export function revocationFor(
  list: RevocationList | null,
  harnessId: string,
  treeDigest: string,
): RevokedPack | null {
  return list?.revoked.find((entry) => entry.harnessId === harnessId && entry.treeDigest === treeDigest) ?? null;
}

/**
 * ONE file holding the list's exact bytes and their signature, replaced by a
 * single rename: a reader sees the old pair or the new pair, never a list
 * with somebody else's signature (which it would discard — and with it every
 * revocation the list carried).
 */
const cacheFile = (root: string) => join(root, "revocations.cache.json");
interface CacheEnvelope {
  list: string;
  signature: string;
}

/** The cached, re-verified list, or null when there is none worth believing. */
export async function readCachedRevocations(
  root: string = runtimeInstallRoot(),
  keys: readonly PackSigningKey[] = trustedKeys,
): Promise<RevocationList | null> {
  try {
    const envelope = JSON.parse(await readFile(cacheFile(root), "utf8")) as CacheEnvelope;
    const parsed = parseRevocationList(Buffer.from(envelope.list, "utf8"), envelope.signature, keys);
    if (!parsed.ok) {
      logger.warn("[local-harness] ignoring an unverifiable cached revocation list", { message: parsed.message });
      return null;
    }
    return parsed.list;
  } catch {
    return null;
  }
}

/** Is a pack revoked, according to the cache? Never touches the network. */
export async function isPackRevoked(
  harnessId: string,
  treeDigest: string,
  root: string = runtimeInstallRoot(),
): Promise<RevokedPack | null> {
  return revocationFor(await readCachedRevocations(root), harnessId, treeDigest);
}

export function revocationsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCPJAM_LOCAL_HARNESS_REVOCATIONS_URL?.trim() || DEFAULT_REVOCATIONS_URL;
}

export type RevocationRefresh =
  | { state: "updated" | "unchanged"; list: RevocationList }
  | { state: "skipped" | "failed"; list: RevocationList | null; message?: string };

let lastRefreshAt = 0;
let inflight: Promise<RevocationRefresh> | null = null;

/** Test seam. */
export function resetRevocationRefreshForTests(): void {
  lastRefreshAt = 0;
  inflight = null;
}

/**
 * Fetch, verify and cache the published list. A failure (offline, 404 before
 * the first list is published, a bad signature) keeps the cache as it was.
 */
export async function refreshRevocations(options: {
  force?: boolean;
  root?: string;
  url?: string;
  fetchImpl?: typeof fetch;
  keys?: readonly PackSigningKey[];
} = {}): Promise<RevocationRefresh> {
  const root = options.root ?? runtimeInstallRoot();
  const keys = options.keys ?? trustedKeys;
  if (!options.force && Date.now() - lastRefreshAt < REVOCATION_REFRESH_INTERVAL_MS) {
    return { state: "skipped", list: await readCachedRevocations(root, keys) };
  }
  if (inflight !== null) return inflight;
  inflight = (async (): Promise<RevocationRefresh> => {
    lastRefreshAt = Date.now();
    const cached = await readCachedRevocations(root, keys);
    const url = options.url ?? revocationsUrl();
    const fetcher = options.fetchImpl ?? fetch;
    try {
      const [listResponse, signatureResponse] = await Promise.all([fetcher(url), fetcher(`${url}.sig`)]);
      if (!listResponse.ok || !signatureResponse.ok) {
        return { state: "failed", list: cached, message: `${url} responded ${listResponse.status}/${signatureResponse.status}` };
      }
      const bytes = Buffer.from(await listResponse.arrayBuffer());
      const signature = await signatureResponse.text();
      const parsed = parseRevocationList(bytes, signature, keys);
      if (!parsed.ok) return { state: "failed", list: cached, message: parsed.message };
      if (cached !== null && parsed.list.sequence < cached.sequence) {
        return {
          state: "failed",
          list: cached,
          message: `refusing revocation list ${parsed.list.sequence}: ${cached.sequence} is already cached`,
        };
      }
      if (cached !== null && parsed.list.sequence === cached.sequence) return { state: "unchanged", list: cached };
      await mkdir(root, { recursive: true, mode: 0o700 });
      const tmp = `${cacheFile(root)}.${process.pid}.${randomUUID()}.tmp`;
      const envelope: CacheEnvelope = { list: bytes.toString("utf8"), signature: signature.trim() };
      await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 });
      await rename(tmp, cacheFile(root));
      logger.info("[local-harness] revocation list updated", { sequence: parsed.list.sequence, revoked: parsed.list.revoked.length });
      return { state: "updated", list: parsed.list };
    } catch (error) {
      return { state: "failed", list: cached, message: error instanceof Error ? error.message : String(error) };
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
