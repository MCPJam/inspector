import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { getOrCreateLocalSecret } from "./local-secret-store.js";

/**
 * Per-namespace session cookies for local Inspector instances.
 *
 * Every local instance keeps its OWN WorkOS cookie and its OWN guest cookie,
 * named by its session namespace (`local-session-namespace.ts`):
 *
 *     mcpjam_wos_<ns>   sealed { refreshToken }          30 days, renewed
 *     mcpjam_gst_<ns>   sealed { upstream guest cookie }  upstream lifetime
 *
 * There is no shared jar any more. A shared jar is one cookie that every
 * instance rewrites from whatever snapshot its request carried, so two
 * instances refreshing at once overwrote each other's sessions.
 *
 * SEALING. AES-256-GCM under a key derived per (kind, namespace) from the
 * machine-local cookie secret, with the kind, namespace and the two
 * timestamps as associated data. So a value is bound to the cookie it was
 * written as: copying `mcpjam_wos_<a>`'s value into `mcpjam_wos_<b>`, or a
 * guest value into a WorkOS cookie, or editing a timestamp, fails to open.
 * The machine-local secret may stay machine-local — it encrypts cookies, it
 * is not a credential any backend accepts.
 *
 * The issue and expiry times ride in clear in front of the ciphertext, so an
 * instance can prune OTHER namespaces' cookies (expired first, then least
 * recently used) without being able to read them.
 *
 * BUDGET. At most `MAX_SCOPED_NAMESPACES` namespaces and
 * `SCOPED_COOKIE_BYTE_BUDGET` bytes of these cookies per browser. Each
 * response only ever WRITES its own namespace and only ever DELETES others,
 * so two instances answering concurrently cannot overwrite each other's
 * session; the most one can do is evict the other when the other is the
 * stalest namespace in its snapshot. Expired namespaces go first, then the
 * least recently issued.
 *
 * The budget is enforced against each response's own snapshot of the Cookie
 * header — the only state a response has. So N instances signing in for the
 * FIRST time from one snapshot can leave the browser up to N-1 namespaces
 * over the bound, and the very next response from any instance prunes back
 * under it. A hard bound across concurrent responses would need coordination
 * between instances that share nothing but the browser.
 */

export type ScopedCookieKind = "workos" | "guest";

const PREFIX: Record<ScopedCookieKind, string> = {
  workos: "mcpjam_wos_",
  guest: "mcpjam_gst_",
};

export const SCOPED_COOKIE_NAME_PATTERN = /^mcpjam_(wos|gst)_([0-9a-f]{12})$/;

/** Mirrors the long-standing local session bound. */
export const MAX_SCOPED_NAMESPACES = 8;
/** Bytes of `name=value` across all scoped cookies, as the Cookie header carries them. */
export const SCOPED_COOKIE_BYTE_BUDGET = 6 * 1024;
/** Renewable lifetime of a namespace's WorkOS cookie. */
export const WORKOS_SCOPED_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const SEAL_VERSION = "v1";
const AUTH_TAG_BYTES = 16;

export function scopedCookieName(kind: ScopedCookieKind, nsId: string): string {
  return `${PREFIX[kind]}${nsId}`;
}

function kindFromPrefix(tag: string): ScopedCookieKind {
  return tag === "wos" ? "workos" : "guest";
}

function getMachineCookieSecret(): string {
  return getOrCreateLocalSecret({
    fileName: "workos-session-secret",
    envVar: "MCPJAM_WORKOS_SESSION_SECRET",
    productionErrorMessage:
      "MCPJAM_WORKOS_SESSION_SECRET is required for session cookies outside local runtimes.",
    label: "session cookie secret",
    allowLocalFileOutsideDevelopment: true,
  });
}

function deriveKey(
  secret: string,
  kind: ScopedCookieKind,
  nsId: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("mcpjam-scoped-cookie-v1", "utf8"),
      Buffer.from(`${kind}:${nsId}`, "utf8"),
      32,
    ),
  );
}

function aad(
  kind: ScopedCookieKind,
  nsId: string,
  iat: string,
  exp: string,
): Buffer {
  return Buffer.from(
    `mcpjam-scoped-cookie|${SEAL_VERSION}|${kind}|${nsId}|${iat}|${exp}`,
    "utf8",
  );
}

export interface ScopedCookieMeta {
  issuedAtMs: number;
  expiresAtMs: number;
}

/** Read the clear-text timestamps without opening the value. */
export function parseScopedCookieMeta(value: string): ScopedCookieMeta | null {
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== SEAL_VERSION) return null;
  const iat = Number.parseInt(parts[1] ?? "", 36);
  const exp = Number.parseInt(parts[2] ?? "", 36);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  return { issuedAtMs: iat * 1000, expiresAtMs: exp * 1000 };
}

export function sealScopedCookie(args: {
  kind: ScopedCookieKind;
  nsId: string;
  payload: unknown;
  issuedAtMs: number;
  expiresAtMs: number;
  secret?: string;
}): string {
  const iat = Math.floor(args.issuedAtMs / 1000).toString(36);
  const exp = Math.floor(args.expiresAtMs / 1000).toString(36);
  const key = deriveKey(
    args.secret ?? getMachineCookieSecret(),
    args.kind,
    args.nsId,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(args.kind, args.nsId, iat, exp));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(args.payload), "utf8"),
    cipher.final(),
  ]);
  return [
    SEAL_VERSION,
    iat,
    exp,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Open a value written for exactly this (kind, namespace); null otherwise or once expired. */
export function unsealScopedCookie(args: {
  kind: ScopedCookieKind;
  nsId: string;
  value: string | null | undefined;
  nowMs?: number;
  secret?: string;
}): unknown {
  if (!args.value) return null;
  const parts = args.value.split(".");
  if (parts.length !== 6 || parts[0] !== SEAL_VERSION) return null;
  const [, iat, exp, ivPart, tagPart, ctPart] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const meta = parseScopedCookieMeta(args.value);
  if (!meta || meta.expiresAtMs <= (args.nowMs ?? Date.now())) return null;
  const tag = Buffer.from(tagPart, "base64url");
  if (tag.length !== AUTH_TAG_BYTES) return null;
  // Outside the try: a secret-store failure is a configuration error, not an
  // unreadable cookie, and must not quietly sign the user out.
  const key = deriveKey(
    args.secret ?? getMachineCookieSecret(),
    args.kind,
    args.nsId,
  );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart, "base64url"),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(aad(args.kind, args.nsId, iat, exp));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

/** `name=value` pairs from a Cookie header, first occurrence of a name wins. */
export function parseCookieHeader(
  header: string | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function readScopedCookie(
  cookieHeader: string | null | undefined,
  kind: ScopedCookieKind,
  nsId: string,
): string | null {
  return (
    parseCookieHeader(cookieHeader).get(scopedCookieName(kind, nsId)) || null
  );
}

function buildSetCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** An immediately-expiring cookie of any name, path `/`. */
export function buildDeletionCookie(name: string, secure = false): string {
  return buildSetCookie(name, "", 0, secure);
}

export interface ScopedCookieWrite {
  kind: ScopedCookieKind;
  /** A sealed value, or `null` to delete this namespace's cookie of `kind`. */
  value: string | null;
  /** Required with a value. */
  maxAgeSeconds?: number;
}

export interface ScopedCookiePlan {
  setCookies: string[];
  /** Namespaces whose cookies this response deletes. */
  prunedNamespaces: string[];
  /** The current namespace alone exceeds the byte budget. */
  overBudget: boolean;
}

function cookieBytes(name: string, value: string): number {
  // `name=value` plus the `; ` separator the Cookie header puts between them.
  return name.length + 1 + value.length + 2;
}

/**
 * The `Set-Cookie` headers for one response: this namespace's writes, plus
 * deletions that keep every browser within the namespace and byte budgets.
 *
 * Pure: everything it knows comes from the request's Cookie header, so it can
 * be exercised against a simulated cookie jar with interleaved responses.
 */
export function planScopedCookieHeaders(args: {
  cookieHeader: string | null | undefined;
  nsId: string;
  writes: ScopedCookieWrite[];
  nowMs: number;
  secure: boolean;
}): ScopedCookiePlan {
  type Entry = {
    name: string;
    value: string;
    ns: string;
    meta: ScopedCookieMeta | null;
  };
  const entries = new Map<string, Entry>();
  for (const [name, value] of parseCookieHeader(args.cookieHeader)) {
    const match = SCOPED_COOKIE_NAME_PATTERN.exec(name);
    if (!match) continue;
    entries.set(name, {
      name,
      value,
      ns: match[2] as string,
      meta: parseScopedCookieMeta(value),
    });
  }

  const setCookies: string[] = [];
  const deleted = new Set<string>();
  const deleteCookie = (name: string) => {
    if (deleted.has(name)) return;
    deleted.add(name);
    entries.delete(name);
    setCookies.push(buildDeletionCookie(name, args.secure));
  };

  // 1. This namespace's own writes.
  for (const write of args.writes) {
    const name = scopedCookieName(write.kind, args.nsId);
    if (write.value === null) {
      deleteCookie(name);
      continue;
    }
    entries.set(name, {
      name,
      value: write.value,
      ns: args.nsId,
      meta: parseScopedCookieMeta(write.value),
    });
    setCookies.push(
      buildSetCookie(name, write.value, write.maxAgeSeconds ?? 0, args.secure),
    );
  }

  // 2. Other namespaces' expired or unreadable cookies.
  for (const entry of [...entries.values()]) {
    if (entry.ns === args.nsId) continue;
    if (!entry.meta || entry.meta.expiresAtMs <= args.nowMs) {
      deleteCookie(entry.name);
    }
  }

  // 3. Least-recently-used other namespaces, until both budgets hold.
  const pruned = new Set<string>();
  const totals = () => {
    const namespaces = new Set<string>();
    let bytes = 0;
    for (const entry of entries.values()) {
      namespaces.add(entry.ns);
      bytes += cookieBytes(entry.name, entry.value);
    }
    return { namespaces, bytes };
  };
  for (;;) {
    const { namespaces, bytes } = totals();
    if (
      namespaces.size <= MAX_SCOPED_NAMESPACES &&
      bytes <= SCOPED_COOKIE_BYTE_BUDGET
    ) {
      break;
    }
    const lastUsed = new Map<string, number>();
    for (const entry of entries.values()) {
      if (entry.ns === args.nsId) continue;
      const used = entry.meta?.issuedAtMs ?? 0;
      lastUsed.set(entry.ns, Math.max(lastUsed.get(entry.ns) ?? 0, used));
    }
    if (lastUsed.size === 0) break;
    const [victim] = [...lastUsed.entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    )[0] as [string, number];
    pruned.add(victim);
    for (const entry of [...entries.values()]) {
      if (entry.ns === victim) deleteCookie(entry.name);
    }
  }

  for (const name of deleted) {
    const match = SCOPED_COOKIE_NAME_PATTERN.exec(name);
    if (match && match[2] !== args.nsId) pruned.add(match[2] as string);
  }

  return {
    setCookies,
    prunedNamespaces: [...pruned],
    overBudget: totals().bytes > SCOPED_COOKIE_BYTE_BUDGET,
  };
}

/** Kind of a scoped cookie name, for diagnostics. */
export function scopedCookieKindOf(name: string): ScopedCookieKind | null {
  const match = SCOPED_COOKIE_NAME_PATTERN.exec(name);
  return match ? kindFromPrefix(match[1] as string) : null;
}
