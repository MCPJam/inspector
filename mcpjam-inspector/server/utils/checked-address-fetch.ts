/**
 * A `fetch` that dials only the addresses the hosted egress guard checked.
 *
 * `createGuardedFetch` checks what a name resolves to and then lets `fetch`
 * resolve it again, so a DNS server that answers public for the check and
 * private for the connection reaches a private service. Here the socket's
 * `lookup` answers with the checked addresses and nothing else. The URL keeps
 * its hostname, so TLS verifies the certificate for that name (SNI) and the
 * Host header names it. Node's `fetch` is undici's, so it takes the agent as
 * its `dispatcher`.
 *
 * Redirects come back as responses and are never followed, since the next
 * hop was never checked. Outside hosted mode this is plain `fetch`: a local
 * Inspector reaching localhost is the product.
 */
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { HOSTED_MODE } from "../config.js";
import {
  assertAllowedHostedTargetUrl,
  type EgressHostResolver,
} from "./hosted-egress-guard.js";
import { normalizeEgressHost } from "./private-egress-allowlist.js";

/**
 * A socket `lookup` that answers `host` with the checked addresses and
 * nothing else: no second DNS query, so the connection goes where the check
 * looked. Any other host is not found, never resolved.
 */
export function checkedAddressLookup(
  host: string,
  addresses: readonly string[],
): LookupFunction {
  const checkedHost = normalizeEgressHost(host);
  const answers = addresses.map((address) => ({
    address,
    family: isIP(address),
  }));
  return (hostname, options, callback) => {
    const first = answers[0];
    if (!first || normalizeEgressHost(hostname) !== checkedHost) {
      const error: NodeJS.ErrnoException = new Error(
        `${hostname} is not the host that was checked`,
      );
      error.code = "ENOTFOUND";
      callback(error, []);
      return;
    }
    if (options.all) callback(null, answers);
    else callback(null, first.address, first.family);
  };
}

/** `resolver` and `baseFetch` stand in for DNS and the network in tests. */
export function createCheckedAddressFetch(
  options: {
    resolver?: EgressHostResolver;
    hosted?: boolean;
    baseFetch?: typeof fetch;
  } = {},
): typeof fetch {
  const baseFetch = options.baseFetch ?? fetch;
  if (!(options.hosted ?? HOSTED_MODE)) return baseFetch;

  return async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const addresses = await assertAllowedHostedTargetUrl(url, "Request URL", {
      resolver: options.resolver,
      hosted: true,
    });
    const agent = new Agent({
      connect: {
        lookup: checkedAddressLookup(new URL(url).hostname, addresses),
      },
    });
    const pinned: RequestInit & { dispatcher: Agent } = {
      ...init,
      redirect: "manual",
      dispatcher: agent,
    };
    try {
      return await baseFetch(input, pinned);
    } finally {
      // Lets this request finish, body included, then ends the socket, so a
      // connection never outlives the check it was opened for. Closing fails
      // only on an agent already closed, which leaves nothing open.
      agent.close(() => undefined);
    }
  };
}
