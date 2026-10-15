/**
 * The published egress list lives in two places: the JSON served at
 * /egress-ips.json and the tables on docs/hosted/network.mdx. Customers copy
 * from either into a firewall, so the two must list exactly the same
 * addresses.
 */

import { readFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import egress from "../hosted-egress-ips.json" with { type: "json" };

const DOCS_PAGE = resolve(__dirname, "../../../docs/hosted/network.mdx");

function section(source: string, heading: string): string {
  const start = source.indexOf(`## ${heading}\n`);
  expect(start, `missing "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n## ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** Every backticked address in a section's table rows, as CIDR. */
function tableAddresses(text: string): string[] {
  return [...text.matchAll(/^\| `([0-9a-f.:/]+)` \|/gm)].map(([, address]) =>
    address!.includes("/") ? address! : `${address}/32`,
  );
}

function isCidr(value: string, family: 4 | 6): boolean {
  const [address, prefix, ...rest] = value.split("/");
  const bits = Number(prefix);
  const max = family === 4 ? 32 : 128;
  return (
    rest.length === 0 &&
    (family === 4 ? isIPv4(address!) : isIPv6(address!)) &&
    /^\d+$/.test(prefix ?? "") &&
    bits >= 0 &&
    bits <= max
  );
}

describe("hosted egress list", () => {
  const groups = {
    mcp_servers: egress.mcp_servers,
    authorization_servers: egress.authorization_servers,
  };

  it("holds only valid, unique CIDR blocks", () => {
    for (const [name, group] of Object.entries(groups)) {
      for (const value of group.ipv4)
        expect(isCidr(value, 4), `${name}: ${value}`).toBe(true);
      for (const value of group.ipv6)
        expect(isCidr(value, 6), `${name}: ${value}`).toBe(true);
      const all = [...group.ipv4, ...group.ipv6];
      expect(new Set(all).size, name).toBe(all.length);
    }
    expect(egress.mcp_servers.ipv4.length).toBeGreaterThan(0);
    expect(egress.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the docs page exactly", () => {
    const page = readFileSync(DOCS_PAGE, "utf8");
    const mcp = tableAddresses(section(page, "Your MCP server"));
    const oauth = tableAddresses(
      section(page, "Your OAuth authorization server"),
    );

    expect(mcp.sort()).toEqual(
      [...egress.mcp_servers.ipv4, ...egress.mcp_servers.ipv6].sort(),
    );
    expect(oauth.sort()).toEqual(
      [
        ...egress.authorization_servers.ipv4,
        ...egress.authorization_servers.ipv6,
      ].sort(),
    );
    expect(page).toContain(egress.authorization_servers.source);
    expect(egress.docs).toBe("https://docs.mcpjam.com/hosted/network");
  });
});
