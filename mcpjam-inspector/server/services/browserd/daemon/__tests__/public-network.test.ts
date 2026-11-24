/**
 * The public-only network a readiness browser boots with: what it refuses as
 * written, what it refuses once a name resolves, and that the egress proxy
 * holds it for a redirect target and a tunnel alike.
 */
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startLocalBrowserProxy } from "../../local/egress-proxy.js";
import {
  createPublicNetworkPolicy,
  isPublicWebUrl,
} from "../public-network.js";

const ANSWERS: Record<string, string[]> = {
  "auth.example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
  "rebind.example.com": ["93.184.216.34", "127.0.0.1"],
  "metadata.example.com": ["169.254.169.254"],
  "nat64.example.com": ["64:ff9b::a9fe:a9fe"],
  "benchmark.example.com": ["2001:2::1"],
  "docs6.example.com": ["3fff::1"],
  "local-nat64.example.com": ["64:ff9b:1::a00:5"],
  "nothing.example.com": [],
};
const fakeLookup = (async (name: string) =>
  (ANSWERS[name] ?? []).map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }))) as never;

describe("a public-only browser", () => {
  it("opens public web pages and nothing else as written", () => {
    for (const url of [
      "https://auth.example.com/login",
      "http://93.184.216.34/",
      "wss://auth.example.com/socket",
      // Neighbours of the ranges that only look public.
      "http://198.20.0.1/",
      "http://198.51.101.1/",
      "http://203.0.114.1/",
      // NAT64 to a public IPv4 address.
      "http://[64:ff9b::808:808]/",
    ]) {
      expect(isPublicWebUrl(url)).toBe(true);
    }
    for (const url of [
      "http://localhost:9222/json",
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[fd00:ec2::254]/",
      // Not globally reachable, though they look public.
      "http://198.18.0.1/",
      "http://192.0.2.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://[2001:db8::1]/",
      "http://[::ffff:198.18.0.1]/",
      "http://[2001:2::1]/",
      "http://[3fff::1]/",
      "http://[2001:0:4136:e378::1]/",
      "http://[2002:a00:1::1]/",
      "http://[64:ff9b:1::a00:5]/",
      // NAT64 to a private IPv4 address.
      "http://[64:ff9b::a00:5]/",
      "file:///etc/passwd",
      "chrome://settings",
      "not a url",
    ]) {
      expect(isPublicWebUrl(url)).toBe(false);
    }
  });

  it("dials a name only when every address it resolves to is public", async () => {
    const policy = createPublicNetworkPolicy(fakeLookup);
    await expect(
      policy.resolveDestination("auth.example.com", 443),
    ).resolves.toHaveLength(2);
    for (const name of [
      "rebind.example.com",
      "metadata.example.com",
      "nat64.example.com",
      "benchmark.example.com",
      "docs6.example.com",
      "local-nat64.example.com",
      "nothing.example.com",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]) {
      await expect(policy.resolveDestination(name, 443)).rejects.toThrow(
        /browser_policy_refused/,
      );
    }
    await expect(
      policy.resolveDestination("auth.example.com", 0),
    ).rejects.toThrow(/browser_policy_refused/);
  });

  it("is held by the egress proxy for requests and tunnels alike", async () => {
    // A page on loopback that an open browser could reach.
    const site = createServer((_req, res) => res.end("internal page"));
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const port = (site.address() as AddressInfo).port;
    const proxy = await startLocalBrowserProxy(
      createPublicNetworkPolicy(fakeLookup),
    );
    const auth = `Basic ${Buffer.from(
      `${proxy.proxy.username}:${proxy.proxy.password}`,
    ).toString("base64")}`;
    const get = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          proxy.proxy.server,
          { path: target, headers: { "Proxy-Authorization": auth } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
        req.end();
      });
    const tunnel = (authority: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(proxy.proxy.server, {
          method: "CONNECT",
          path: authority,
          headers: { "Proxy-Authorization": auth },
        });
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await get(`http://127.0.0.1:${port}/`)).toBe(403);
      expect(await get(`http://rebind.example.com:${port}/`)).toBe(403);
      expect(await tunnel("169.254.169.254:443")).toBe(403);
      expect(await tunnel(`metadata.example.com:443`)).toBe(403);
      expect(await tunnel(`127.0.0.1:${port}`)).toBe(403);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  });
});
