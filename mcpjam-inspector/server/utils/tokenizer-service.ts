import type { Context } from "hono";
import { getAttestedClientIp } from "./client-ip.js";
import { guestIpForwardHeaders, hashGuestSpendIp } from "./guest-spend-ip.js";

/** Server-owned headers only. Never copy credentials or IP hashes from input. */
export function tokenizerServiceHeaders(
  ipHash?: string | null,
): Record<string, string> {
  const token = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
  if (!token) return {};
  // Authenticate even when IP attribution is unavailable: Convex deliberately
  // shares one unknown-IP bucket for those requests.
  return {
    "x-inspector-service-token": token,
    ...guestIpForwardHeaders(ipHash),
  };
}

export async function tokenizerClientIpHash(
  c: Context,
): Promise<string | null> {
  const ip = getAttestedClientIp(c);
  return ip ? hashGuestSpendIp(ip) : null;
}
