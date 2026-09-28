/** Mirrored into Inspector; keep parsing and defaults identical in both runtimes. */
export const EGRESS_POLICY_VERSION = "private-networks-v1";
export const DEFAULT_EGRESS_DENY_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

export function isValidIpv4Cidr(entry: string): boolean {
  const [address, prefix, extra] = entry.split("/");
  if (!address || !prefix || extra !== undefined || !/^\d{1,2}$/.test(prefix)) {
    return false;
  }
  if (Number(prefix) > 32) return false;
  const octets = address.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255
    )
  );
}

/** Preserve the existing operator override: it replaces the complete list. */
export function resolveEgressPolicy(raw: string | undefined) {
  let denyOut: string[] = [...DEFAULT_EGRESS_DENY_CIDRS];
  if (raw !== undefined) {
    denyOut =
      raw.trim() === "" ? [] : raw.split(",").map((entry) => entry.trim());
  }
  if (denyOut.length > 64 || denyOut.some((entry) => !isValidIpv4Cidr(entry))) {
    // Do not echo a malformed env value: it can be a secret pasted into the wrong key.
    throw new Error("E2B_EGRESS_DENY_CIDRS must contain at most 64 IPv4 CIDRs");
  }
  return {
    version: EGRESS_POLICY_VERSION,
    source: raw === undefined ? ("default" as const) : ("override" as const),
    denyOut: [...new Set(denyOut)],
    weakensDefaults: egressOverrideWeakensDefaults(denyOut),
  };
}

export function egressOverrideWeakensDefaults(
  override: readonly string[]
): boolean {
  return DEFAULT_EGRESS_DENY_CIDRS.some((cidr) => !override.includes(cidr));
}
