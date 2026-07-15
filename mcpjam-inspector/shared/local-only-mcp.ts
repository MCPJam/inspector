export type LocalOnlyMcpServerConfig = {
  command?: unknown;
  url?: unknown;
};

export function isUnsafeHostedOutboundHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!host) return true;

  if (
    host === "localhost" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  // Docker's magic hostnames resolve to the container's host machine, so a
  // server reachable at these is local-only — the cloud can't route to it.
  if (host === "host.docker.internal" || host === "gateway.docker.internal") {
    return true;
  }

  if (
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host === "metadata.goog"
  ) {
    return true;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((n) => Number(n));
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    ) {
      return true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

    const dotted = host.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
    );
    if (dotted) return isUnsafeHostedOutboundHost(dotted[1]);

    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      if (
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        high >= 0 &&
        high <= 0xffff &&
        low >= 0 &&
        low <= 0xffff
      ) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        return isUnsafeHostedOutboundHost(`${a}.${b}.${c}.${d}`);
      }
    }
    return false;
  }

  return false;
}

export function isUnsafeHostedOutboundUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  return isUnsafeHostedOutboundHost(parsed.hostname);
}

export function isLocalOnlyMcpServerConfig(
  config: LocalOnlyMcpServerConfig | null | undefined,
): boolean {
  if (!config || typeof config !== "object") return false;
  if (typeof config.command === "string") return true;
  if (typeof config.url !== "string" || config.url.trim().length === 0) {
    return false;
  }
  return isUnsafeHostedOutboundUrl(config.url);
}
