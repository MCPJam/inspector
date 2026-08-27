/**
 * The DNS half of the pinned transport, extracted so more than one transport
 * can share it.
 *
 * `oauth-proxy.ts` grew this logic for its own buffering request path. A
 * streaming transport (`pinned-stream-fetch.ts`, which the MCP connection
 * itself rides on) needs exactly the same two steps and must never grow a
 * second copy: a divergence between "the addresses OAuth discovery validated"
 * and "the addresses the MCP socket dialled" is precisely the hole this
 * machinery exists to close.
 *
 * The two steps, and why they are two:
 *
 *   1. {@link resolvePinnedAddresses} resolves the hostname ONCE and classifies
 *      every answer under RFC 6890. It returns `null` for a numeric host —
 *      there is no lookup to pin, and the literal has already been classified.
 *   2. {@link createPinnedLookup} feeds those exact addresses back to the
 *      socket as its `lookup`, so the connection cannot re-resolve and land
 *      somewhere the classifier never saw.
 *
 * Node-only: `node:dns` is the whole point. Browser callers get the classifier
 * alone from `oauth/ssrf-guard.js`, which is deliberately not enough on its own.
 */

import { lookup as dnsLookupCb } from "node:dns";
import type { LookupFunction } from "node:net";

import { OAuthProxyError } from "../oauth-proxy-error.js";
import { isDisallowedIpAddress, isLoopbackOAuthUrl, isPrivateHost } from "./ssrf-guard.js";

export interface PinnedAddress {
  address: string;
  family: number;
}

function isLoopbackAddress(address: string): boolean {
  const host = address.includes(":") ? `[${address}]` : address;
  return isLoopbackOAuthUrl(`http://${host}`);
}

/**
 * Resolve `targetUrl`'s host once and refuse every disallowed answer.
 *
 * Returns the surviving addresses for {@link createPinnedLookup} to pin, or
 * `null` when the host is a numeric literal: there is no name to re-resolve,
 * so there is nothing a rebind could change.
 *
 * `allowLoopbackFlow` is narrow on purpose — it permits a loopback TARGET, and
 * then still requires every resolved address to be loopback, so a name that
 * looks local but answers publicly is refused rather than dialled.
 */
export async function resolvePinnedAddresses(
  targetUrl: URL,
  allowLoopbackFlow: boolean,
  signal: AbortSignal | undefined,
  targetLabel = "OAuth metadata target",
): Promise<PinnedAddress[] | null> {
  const targetIsLoopback = isLoopbackOAuthUrl(targetUrl.toString());

  if (isPrivateHost(targetUrl.hostname)) {
    if (!(allowLoopbackFlow && targetIsLoopback)) {
      throw new OAuthProxyError(
        400,
        `${targetLabel} is a private/reserved host (${targetUrl.hostname})`,
      );
    }
  }

  // Numeric IPs are already the exact socket destination, so there is no DNS
  // lookup to pin. The literal-host check above has classified them.
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) ||
    targetUrl.hostname.includes(":")
  ) {
    return null;
  }

  const addresses = await new Promise<PinnedAddress[]>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error(`${targetLabel} request aborted`));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    dnsLookupCb(
      targetUrl.hostname,
      { all: true, verbatim: true },
      (error, resolved) => {
        cleanup();
        if (error) {
          reject(
            new OAuthProxyError(
              400,
              `Could not resolve ${targetLabel.toLowerCase()} ${
                targetUrl.hostname
              }`,
            ),
          );
          return;
        }
        resolve(Array.isArray(resolved) ? resolved : [resolved]);
      },
    );
  });

  if (addresses.length === 0) {
    throw new OAuthProxyError(
      400,
      `Could not resolve ${targetLabel.toLowerCase()} ${targetUrl.hostname}`,
    );
  }

  for (const { address } of addresses) {
    if (targetIsLoopback) {
      if (!isLoopbackAddress(address)) {
        throw new OAuthProxyError(
          400,
          `Loopback ${targetLabel.toLowerCase()} resolved outside loopback (${address})`,
        );
      }
    } else if (isDisallowedIpAddress(address)) {
      throw new OAuthProxyError(
        400,
        `${targetLabel} resolves to a private/reserved IP address (${address})`,
      );
    }
  }

  return addresses;
}

/**
 * The `lookup` that makes the validation binding.
 *
 * The callback shape must follow `options.all`: with autoSelectFamily (the
 * Node ≥20 default) the socket passes `all: true` and expects an ARRAY of
 * `{address, family}` entries; answering with a bare string there makes Node
 * throw `ERR_INVALID_IP_ADDRESS`.
 */
export function createPinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options?.all) {
      return (
        callback as unknown as (
          err: NodeJS.ErrnoException | null,
          resolved: PinnedAddress[],
        ) => void
      )(null, addresses);
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
}
