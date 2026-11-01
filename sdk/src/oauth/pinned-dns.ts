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
import {
  isDisallowedIpAddress,
  isLoopbackOAuthUrl,
  isNeverDialableHost,
  isNeverDialableIpAddress,
  isPrivateHost,
} from "./ssrf-guard.js";

export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * What one hop's resolution concluded.
 *
 * `addresses` is `null` for a numeric literal — there is no name to re-resolve,
 * so there is nothing to pin. `targetIsPrivate` reports where the hop actually
 * LANDED, which is the only honest basis for the chain rule below: a hostname
 * that looks public and answers 127.0.0.1 is exactly the case this whole change
 * exists to serve, so "did the chain start private" cannot be asked of the name.
 */
export interface ResolvedTarget {
  addresses: PinnedAddress[] | null;
  targetIsPrivate: boolean;
}

/**
 * A caller's own decision about one private destination: the hostname alone
 * before resolution, then each private address it answered with. Asked only
 * where a destination would otherwise be refused as private, and never about a
 * link-local or cloud-metadata one, so it can open a destination but not the
 * floor under every policy.
 */
export type PrivateDestinationAdmission = (destination: {
  /** The URL's hostname as written: a name or an IP literal. */
  hostname: string;
  /** One private address the hostname resolved to. */
  address?: string;
}) => boolean;

/**
 * What a chain is allowed to reach. Computed ONCE per chain by
 * {@link resolveEgressPolicy} and handed to every hop, so the three buffered
 * entry points and the streaming transport cannot drift apart on the question
 * of what "local" means.
 */
export interface EgressPolicy {
  /**
   * The chain started at a loopback target and the caller opted in, so
   * loopback answers are permitted (and, for a loopback target, required).
   */
  allowLoopbackFlow: boolean;
  /**
   * The caller is a local inspector: every private destination is permitted,
   * and only {@link isNeverDialableHost} stays refused.
   */
  allowPrivateNetwork: boolean;
  /**
   * Private destinations admitted one by one, for a caller that otherwise
   * refuses them all: a hosted deployment on its operator's own network,
   * whose operator listed the ones it may reach. Every hop asks again, so a
   * redirect onto a destination the caller did not admit is refused, and a
   * plaintext hop must land on admitted private addresses only.
   */
  admitPrivateDestination?: PrivateDestinationAdmission;
}

/**
 * Derive the chain policy from a caller's options.
 *
 * `httpsOnly` is the hosted switch and always wins: a hosted deployment fetches
 * on OUR infrastructure, where a private destination means our own network, so
 * neither opt-in survives it. An admission does survive it: it is that
 * deployment naming the private destinations it means, not a blanket opt-in.
 * It also turns the loopback flow off, so a loopback destination is admitted
 * hop by hop like any other rather than inherited from where the chain started.
 */
export function resolveEgressPolicy(options: {
  httpsOnly?: boolean;
  allowPrivateNetwork?: boolean;
  admitPrivateDestination?: PrivateDestinationAdmission;
  startUrl: string;
}): EgressPolicy {
  const admission = options.admitPrivateDestination
    ? { admitPrivateDestination: options.admitPrivateDestination }
    : {};
  if (options.httpsOnly === true) {
    return {
      allowLoopbackFlow: false,
      allowPrivateNetwork: false,
      ...admission,
    };
  }
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  return {
    // Private-network callers get loopback as a subset, so a chain that starts
    // on a private host is not held to the loopback-only rule below.
    allowLoopbackFlow:
      !allowPrivateNetwork &&
      !options.admitPrivateDestination &&
      isLoopbackOAuthUrl(options.startUrl),
    allowPrivateNetwork,
    ...admission,
  };
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
 * `policy.allowLoopbackFlow` is narrow on purpose — it permits a loopback
 * TARGET, and then still requires every resolved address to be loopback, so a
 * name that looks local but answers publicly is refused rather than dialled.
 *
 * `policy.allowPrivateNetwork` is the local inspector's wider allowance: any
 * private answer is fine, so the rebinding question becomes "did it land on
 * something never-dialable", not "did it land off loopback". Resolution is
 * still done ONCE and still pinned, so the address that was classified is the
 * address that gets dialled.
 *
 * `policy.admitPrivateDestination` sits between the two: a private literal
 * or a private answer is dialled only when it admits it, and it is asked at
 * pin time, about exactly the addresses that will be pinned.
 */
export async function resolvePinnedAddresses(
  targetUrl: URL,
  policy: EgressPolicy,
  signal: AbortSignal | undefined,
  targetLabel = "OAuth metadata target",
): Promise<ResolvedTarget> {
  const targetIsLoopback = isLoopbackOAuthUrl(targetUrl.toString());
  const admit = policy.admitPrivateDestination;
  const admitted = (address?: string) =>
    admit?.({
      hostname: targetUrl.hostname,
      ...(address === undefined ? {} : { address }),
    }) === true;

  if (isNeverDialableHost(targetUrl.hostname)) {
    throw new OAuthProxyError(
      400,
      `${targetLabel} is a link-local or cloud-metadata host (${targetUrl.hostname})`,
    );
  }

  if (!policy.allowPrivateNetwork && isPrivateHost(targetUrl.hostname)) {
    if (!(policy.allowLoopbackFlow && targetIsLoopback) && !admitted()) {
      throw new OAuthProxyError(
        400,
        `${targetLabel} is a private/reserved host (${targetUrl.hostname})`,
      );
    }
  }

  // Plaintext that no blanket allowance covers: an admitting caller's http hop
  // reaches resolution so the answer can decide it, and it may only land on
  // private addresses — each of which the loop below admits or refuses.
  const plaintextNeedsAdmission =
    admit !== undefined &&
    targetUrl.protocol === "http:" &&
    !policy.allowPrivateNetwork &&
    !(policy.allowLoopbackFlow && targetIsLoopback);
  const refusePublicPlaintext = () =>
    new OAuthProxyError(
      400,
      `Refusing a plaintext connection to "${targetUrl.hostname}": it is a public host, so the target must be served over https.`,
    );

  // Numeric IPs are already the exact socket destination, so there is no DNS
  // lookup to pin. The literal-host check above has classified them.
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) ||
    targetUrl.hostname.includes(":")
  ) {
    const targetIsPrivate = isPrivateHost(targetUrl.hostname);
    if (plaintextNeedsAdmission && !targetIsPrivate) {
      throw refusePublicPlaintext();
    }
    return { addresses: null, targetIsPrivate };
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

  // EVERY answer must be private for the hop to count as private, not just one.
  // A mixed `[public, private]` answer is pinned as a set and the socket may
  // pick either, so "one of them was private" would hand a chain that can dial
  // a public address the permission meant for one that cannot.
  const landedPrivate = addresses.every(({ address }) =>
    isDisallowedIpAddress(address),
  );
  const targetIsPrivate = isPrivateHost(targetUrl.hostname) || landedPrivate;

  // PLAINTEXT IS FOR PRIVATE DESTINATIONS, and now the resolver knows which
  // those are. `allowPrivateNetwork` exists so a local developer can reach
  // their own http server; it is not a reason to put a request to a PUBLIC
  // host on the wire in the clear, where anyone on the path can read a bearer
  // token or rewrite a redirect. The scheme gate upstream cannot make this
  // call — `auth.local` reads as public and answers loopback — so it defers
  // to here, which is still before any socket opens.
  if (
    policy.allowPrivateNetwork &&
    targetUrl.protocol === "http:" &&
    !targetIsPrivate
  ) {
    throw refusePublicPlaintext();
  }
  if (plaintextNeedsAdmission && !landedPrivate) {
    throw refusePublicPlaintext();
  }
  for (const { address } of addresses) {
    if (isNeverDialableIpAddress(address)) {
      throw new OAuthProxyError(
        400,
        `${targetLabel} resolves to a link-local or cloud-metadata address (${address})`,
      );
    }
    if (policy.allowPrivateNetwork) {
      // Every remaining answer is dialable for a local caller; the pin below
      // still binds the socket to exactly what was classified here.
      continue;
    }
    if (targetIsLoopback) {
      if (!isLoopbackAddress(address)) {
        throw new OAuthProxyError(
          400,
          `Loopback ${targetLabel.toLowerCase()} resolved outside loopback (${address})`,
        );
      }
    } else if (isDisallowedIpAddress(address) && !admitted(address)) {
      throw new OAuthProxyError(
        400,
        `${targetLabel} resolves to a private/reserved IP address (${address})`,
      );
    }
  }

  return { addresses, targetIsPrivate };
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
