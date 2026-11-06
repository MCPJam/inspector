/**
 * The grammar and matching rules for `MCPJAM_PRIVATE_EGRESS_ALLOWLIST`: the
 * private destinations an operator lets a hosted deployment dial when that
 * deployment runs on the operator's own network (a self-hosted install whose
 * MCP servers and model endpoints live next to it).
 *
 * This module only parses and matches. Whether a destination is private, and
 * the floor no entry can lift (cloud metadata, link-local, the unspecified
 * address), belong to `hosted-egress-guard.ts`, which is the one place that
 * asks this list anything.
 *
 * The value is a comma-separated list of:
 *
 *   - CIDRs, IPv4 or IPv6: `10.0.0.0/8`, `fd00::/8`. A bare address is its own
 *     /32 or /128. They match ADDRESSES only — an IP literal in a URL, or an
 *     address a hostname resolved to — never a name.
 *   - Host suffixes: `svc.cluster.local` (a leading dot is optional). They
 *     match NAMES only, on label boundaries: `corp.example` matches
 *     `corp.example` and `mcp.corp.example`, never `evilcorp.example`.
 *
 * ANY INVALID ENTRY VOIDS THE WHOLE LIST. Parsing is strict on purpose, and a
 * value with a typo admits nothing rather than whatever survives the typo:
 * `10.0.0.0/` must not read as `/0`, and dropping one bad entry while keeping
 * the rest would leave a list nobody wrote in force.
 */

import { isIPv6 } from "node:net";

/** An address as bytes: 4 for IPv4, 16 for IPv6. */
type AddressBytes = readonly number[];

interface Cidr {
  bytes: AddressBytes;
  prefix: number;
}

export interface PrivateEgressDestination {
  /** The URL's hostname as written: a name or an IP literal. */
  hostname: string;
  /** One address the hostname resolved to; absent when judging the name alone. */
  address?: string;
}

export interface PrivateEgressAllowlist {
  /** True when nothing was configured, or the value was voided. */
  readonly isEmpty: boolean;
  /** Whether the name matches a listed suffix or the address a listed range. */
  admits(destination: PrivateEgressDestination): boolean;
}

export interface InvalidAllowlistEntry {
  entry: string;
  reason: string;
}

export interface ParsedPrivateEgressAllowlist {
  allowlist: PrivateEgressAllowlist;
  /** Non-empty means the list was voided and admits nothing. */
  invalid: InvalidAllowlistEntry[];
}

const EMPTY_ALLOWLIST: PrivateEgressAllowlist = {
  isEmpty: true,
  admits: () => false,
};

/** Lowercase, brackets and terminal dots off, so every comparison judges one spelling. */
export function normalizeEgressHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, "");
}

/** Dotted-quad only, no leading zeros: `010.0.0.1` is octal to some parsers. */
function ipv4Bytes(text: string): AddressBytes | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) {
    return null;
  }
  const octets = text.split(".").map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * The 16 bytes of an IPv6 literal, or null. A zone id (`fe80::1%eth0`) is
 * refused: it names an interface, not an address anything else can match.
 */
export function ipv6Bytes(text: string): AddressBytes | null {
  if (text.includes("%") || !isIPv6(text)) return null;
  let hex = text;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4Bytes(dotted[2]);
    if (!v4) return null;
    hex = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${(
      (v4[2] << 8) |
      v4[3]
    ).toString(16)}`;
  }
  const groups = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const halves = hex.split("::");
  const hextets =
    halves.length === 2
      ? (() => {
          const left = groups(halves[0]);
          const right = groups(halves[1]);
          return [
            ...left,
            ...new Array<number>(8 - left.length - right.length).fill(0),
            ...right,
          ];
        })()
      : groups(hex);
  if (hextets.length !== 8) return null;
  return hextets.flatMap((hextet) => [hextet >> 8, hextet & 0xff]);
}

/**
 * The bytes a destination address is matched as. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.5`) is the IPv4 address it carries, so a listed IPv4 range
 * covers both spellings and an IPv6 range covers neither.
 */
function matchableBytes(address: string): AddressBytes | null {
  const v4 = ipv4Bytes(address);
  if (v4) return v4;
  const v6 = ipv6Bytes(address);
  if (!v6) return null;
  const mapped =
    v6.slice(0, 10).every((byte) => byte === 0) &&
    v6[10] === 0xff &&
    v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

function cidrContains(cidr: Cidr, bytes: AddressBytes): boolean {
  if (cidr.bytes.length !== bytes.length) return false;
  for (let bit = 0; bit < cidr.prefix; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    const index = Math.floor(bit / 8);
    if ((cidr.bytes[index] & mask) !== (bytes[index] & mask)) return false;
  }
  return true;
}

function hasHostBits(bytes: AddressBytes, prefix: number): boolean {
  for (let bit = prefix; bit < bytes.length * 8; bit += 1) {
    if (bytes[Math.floor(bit / 8)] & (0x80 >> (bit % 8))) return true;
  }
  return false;
}

function addressBytes(text: string): AddressBytes | null {
  return ipv4Bytes(text) ?? (text.includes(":") ? ipv6Bytes(text) : null);
}

function parseCidr(entry: string): Cidr | InvalidAllowlistEntry {
  const slash = entry.lastIndexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const bytes = addressBytes(address);
  if (!bytes) {
    return { entry, reason: "is not a valid IPv4 or IPv6 address or range" };
  }
  const maxPrefix = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: maxPrefix };
  const rawPrefix = entry.slice(slash + 1);
  const prefix = /^(?:0|[1-9]\d{0,2})$/.test(rawPrefix)
    ? Number(rawPrefix)
    : Number.NaN;
  if (!(prefix <= maxPrefix)) {
    return { entry, reason: `needs a prefix length from 0 to ${maxPrefix}` };
  }
  if (hasHostBits(bytes, prefix)) {
    return {
      entry,
      reason: `has bits set past its /${prefix} prefix; write the network address it should cover`,
    };
  }
  return { bytes, prefix };
}

/** RFC 1123 labels: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseSuffix(entry: string): string | InvalidAllowlistEntry {
  const suffix = normalizeEgressHost(entry.replace(/^\./, ""));
  const labels = suffix.split(".");
  if (
    suffix.length === 0 ||
    suffix.length > 253 ||
    !labels.every((label) => HOST_LABEL.test(label))
  ) {
    return {
      entry,
      reason:
        "is not a host suffix: use letters, digits, hyphens and dots, like svc.cluster.local (no wildcards)",
    };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return {
      entry,
      reason:
        "ends in a number, so it would read as an address; list addresses as CIDRs",
    };
  }
  return suffix;
}

function isIpLiteral(host: string): boolean {
  return ipv4Bytes(host) !== null || host.includes(":");
}

export function parsePrivateEgressAllowlist(
  raw: string | undefined,
): ParsedPrivateEgressAllowlist {
  const cidrs: Cidr[] = [];
  const suffixes: string[] = [];
  const invalid: InvalidAllowlistEntry[] = [];

  for (const piece of (raw ?? "").split(",")) {
    const entry = piece.trim();
    if (!entry) continue;
    // Anything shaped like an address is judged as one: an entry made of
    // digits and dots that fails as an address must not become a suffix.
    const parsed =
      entry.includes("/") || entry.includes(":") || /^[\d.]+$/.test(entry)
        ? parseCidr(entry)
        : parseSuffix(entry);
    if (typeof parsed === "string") suffixes.push(parsed);
    else if ("reason" in parsed) invalid.push(parsed);
    else cidrs.push(parsed);
  }

  if (invalid.length > 0 || (cidrs.length === 0 && suffixes.length === 0)) {
    return { allowlist: EMPTY_ALLOWLIST, invalid };
  }

  return {
    invalid,
    allowlist: {
      isEmpty: false,
      admits({ hostname, address }) {
        const host = normalizeEgressHost(hostname);
        if (
          !isIpLiteral(host) &&
          suffixes.some(
            (suffix) => host === suffix || host.endsWith(`.${suffix}`),
          )
        ) {
          return true;
        }
        const judged =
          address !== undefined
            ? normalizeEgressHost(address)
            : isIpLiteral(host)
              ? host
              : undefined;
        if (judged === undefined) return false;
        const bytes = matchableBytes(judged);
        return (
          bytes !== null && cidrs.some((cidr) => cidrContains(cidr, bytes))
        );
      },
    },
  };
}
