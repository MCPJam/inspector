/**
 * Whether the configured MCP server is itself on a private network, which is
 * what lets the local Inspector's HTTP probes (authorization metadata, Server
 * Card) follow a pointer to a private address. A public server never gets
 * that: whatever its metadata or catalog names, the probes will not dial the
 * user's loopback or LAN for it.
 *
 * Private means a loopback name, a special-use address literal, or a name
 * every one of whose addresses is special-use. A name that does not resolve in
 * time counts as public.
 *
 * Limit: this lookup is separate from the one the pinned transport makes when
 * it dials, and the transport takes one allow-private setting for the whole
 * probe, so it cannot reuse this answer. A name whose DNS answers private here
 * and public a moment later is treated as a private server, and its metadata
 * and card pointers may then lead the local probes to the user's network.
 * That takes control of the server's DNS and applies only locally: hosted
 * never allows a private target.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isDisallowedIpAddress, isPrivateHost } from "@mcpjam/sdk/oauth/node";

export const RESOLVE_TIMEOUT_MS = 2_000;

export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

export async function serverOnPrivateNetwork(
  serverUrl: string,
  resolve: ResolveHost = resolveHost,
): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname;
  } catch {
    // Not a URL: nothing private is allowed for it.
    return false;
  }
  if (isPrivateHost(hostname)) return true;
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string[]>((done) => {
    timer = setTimeout(() => done([]), RESOLVE_TIMEOUT_MS);
  });
  try {
    const addresses = await Promise.race([resolve(hostname), late]);
    return addresses.length > 0 && addresses.every(isDisallowedIpAddress);
  } catch {
    // A name that does not resolve is not known to be private.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
