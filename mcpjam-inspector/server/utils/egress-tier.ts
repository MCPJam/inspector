/**
 * Where a hostname or address sits in MCPJam's egress threat model: `never`,
 * `private` or `public`. Pure, and free of server config, so the hosted
 * inspector's guard (`hosted-egress-guard.ts`) and the hosted browser's
 * public-only network (`browserd/daemon/public-network.ts`) judge an address
 * the same way.
 */
import { ipv6Bytes, normalizeEgressHost } from "./private-egress-allowlist.js";

/** Parse a dotted-quad IPv4 literal into octets, or null if not well-formed. */
function parseIpv4Octets(
  host: string,
): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return [o[0], o[1], o[2], o[3]];
}

/** Metadata aliases: they resolve to link-local, but the names are refused too. */
const METADATA_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

/**
 * Names that only mean something on the machine itself or its container host:
 * the loopback aliases `/etc/hosts` ships and Docker's host gateways.
 */
const MACHINE_LOCAL_NAMES = new Set([
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
  "gateway.docker.internal",
]);

/** AWS's IPv6 instance metadata address, inside the ULA range. */
const AWS_IPV6_METADATA = ipv6Bytes("fd00:ec2::254");

export type EgressTier = "never" | "private" | "public";

/**
 * Where a literal hostname or address sits in the threat model above.
 *
 *   - `never`: an empty host, cloud-metadata names and addresses (including
 *     Alibaba's inside CGNAT and AWS's inside ULA), IPv4/IPv6 link-local
 *     (169.254/16, fe80::/10), multicast and reserved space (224/4, 240/4,
 *     ff00::/8), and the unspecified address (0.0.0.0/8, ::).
 *   - `private`: loopback and `.localhost`, the machine-local names above,
 *     RFC-1918, CGNAT (100.64/10), and IPv6 ULA (fc00::/7).
 *   - `public`: everything else, including every other name — a name is
 *     judged again on what it resolves to.
 */
export function egressTier(hostname: string): EgressTier {
  // `normalizeEgressHost` strips a terminal dot. It is the same NAME to a
  // resolver ("localhost." resolves to loopback) but a different STRING to
  // every comparison below, so `http://metadata.google.internal./` would
  // otherwise walk past the alias check.
  const host = normalizeEgressHost(hostname);
  // Nothing left to judge: fail closed.
  if (!host) return "never";
  if (METADATA_NAMES.has(host)) return "never";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    MACHINE_LOCAL_NAMES.has(host)
  ) {
    return "private";
  }

  const v4 = parseIpv4Octets(host);
  if (v4) {
    const [a, b, c, d] = v4;
    if (a === 169 && b === 254) return "never"; // link-local incl. cloud metadata
    if (a === 0) return "never"; // "this network" / unspecified
    if (a >= 224) return "never"; // multicast 224/4, reserved 240/4
    if (a === 100 && b === 100 && c === 100 && d === 200) return "never"; // Alibaba metadata
    if (a === 127) return "private"; // loopback 127.0.0.0/8
    if (a === 10) return "private"; // 10.0.0.0/8
    if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT 100.64.0.0/10
    return "public";
  }

  if (host.includes(":")) {
    // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — judge the embedded v4.
    const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    if (mapped) return egressTier(mapped[1]);
    // The SAME address in hex. `new URL()` rewrites the dotted spelling into
    // this one (`[::ffff:169.254.169.254]` → `[::ffff:a9fe:a9fe]`), so a check
    // that only knew the dotted form let the metadata endpoint through the
    // moment the host came from a parsed URL rather than a raw string.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return egressTier(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
          low & 0xff
        }`,
      );
    }
    if (host === "::") return "never"; // unspecified
    if (/^fe[89ab]/.test(host)) return "never"; // link-local fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(host)) return "never"; // multicast ff00::/8
    const bytes = ipv6Bytes(host);
    if (
      bytes &&
      AWS_IPV6_METADATA &&
      bytes.every((byte, i) => byte === AWS_IPV6_METADATA[i])
    ) {
      return "never";
    }
    if (host === "::1") return "private"; // loopback
    if (/^f[cd]/.test(host)) return "private"; // ULA fc00::/7
    return "public";
  }

  return "public";
}
