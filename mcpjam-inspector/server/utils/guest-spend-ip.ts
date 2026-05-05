import { isIP, isIPv4, isIPv6 } from "node:net";
import type { webcrypto } from "node:crypto";
import { getGuestSessionHashPepper } from "./guest-session-pepper.js";

const SCOPE = "guest-spend-ip";

let cachedKeyPepper: string | null = null;
let cachedKeyPromise: Promise<webcrypto.CryptoKey> | null = null;

async function getHmacKey(): Promise<webcrypto.CryptoKey | null> {
  // The pepper helper throws in non-dev environments when the env var is
  // unset (test, prod-without-config, ephemeral staging). Treat that as
  // "no pepper" and return null so callers can degrade to the `_unknown`
  // sentinel — same end state as a request with no resolvable IP. We
  // never want a missing pepper to bubble up as a 500 from the chat /
  // guest-session routes.
  let pepper: string;
  try {
    pepper = getGuestSessionHashPepper();
  } catch {
    return null;
  }
  if (cachedKeyPepper === pepper && cachedKeyPromise) {
    return cachedKeyPromise;
  }
  cachedKeyPepper = pepper;
  cachedKeyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedKeyPromise;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

// Canonicalize a raw client IP into the form we hash. Same client must always
// hash to the same key, so:
//   - IPv4-mapped IPv6 (::ffff:1.2.3.4) collapses to its dotted-quad form. We
//     can't rely on `new URL(...).hostname` here because Node normalizes the
//     mapped form to compressed `[::ffff:102:304]`, which would key a v4
//     client differently depending on whether the proxy hands us the v4 or
//     the v6 representation.
//   - Other IPv6 addresses are normalized via URL parsing (which lowercases
//     and applies RFC 5952 compression). The bracketed form Node returns is
//     stripped.
//   - IPv4 passes through unchanged.
//   - Anything else returns null so the caller can fall back to a sentinel.
export function canonicalizeClientIp(rawIp: string): string | null {
  const trimmed = rawIp.trim();
  if (!trimmed) return null;

  const mapped = trimmed.match(IPV4_MAPPED_RE);
  if (mapped && isIPv4(mapped[1])) {
    return mapped[1];
  }

  if (isIPv4(trimmed)) {
    return trimmed;
  }

  if (isIPv6(trimmed)) {
    try {
      const normalized = new URL(`http://[${trimmed}]`).hostname.toLowerCase();
      // Node returns IPv6 hostnames bracketed (e.g. "[::1]"); strip them.
      return normalized.startsWith("[") && normalized.endsWith("]")
        ? normalized.slice(1, -1)
        : normalized;
    } catch {
      return null;
    }
  }

  return isIP(trimmed) ? trimmed.toLowerCase() : null;
}

// HMAC the canonicalized IP with the guest-session pepper under a dedicated
// scope. Same scope/pepper used by the cookie hash path, but separate scope
// prefix so the two hashes can't be cross-substituted. Returns null when
// the IP can't be canonicalized OR the pepper is unavailable; caller falls
// back to the `_unknown` sentinel.
export async function hashGuestSpendIp(rawIp: string): Promise<string | null> {
  const canonical = canonicalizeClientIp(rawIp);
  if (!canonical) return null;
  const key = await getHmacKey();
  if (!key) return null;
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${SCOPE}:${canonical}`),
  );
  return bytesToBase64Url(new Uint8Array(sig));
}
