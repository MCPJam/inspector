/**
 * Endpoint checks. Small surface, one subtle rule.
 *
 * The subtle one: a redirect chain that DOWNGRADES in the middle and ends on
 * https still fails. Nothing leaks on that hop, but anyone on the path can
 * rewrite its `Location`, and what they get to choose is where the connector
 * ends up — which decides the auth server a user is later sent to.
 */

import { describe, expect, it } from "vitest";

import { runClaudeEndpointChecks } from "../../src/claude-readiness/checks/endpoint.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };

function byId(
  findings: ReturnType<typeof runClaudeEndpointChecks>,
  id: string,
) {
  return findings.find((finding) => finding.id === id)!;
}

describe("the connector scheme", () => {
  it("passes an https URL", () => {
    expect(
      byId(
        runClaudeEndpointChecks(
          { enteredUrl: "https://mcp.example.com/mcp", redirectChain: [] },
          STAMP,
        ),
        "claude.endpoint.https",
      ).status,
    ).toBe("satisfied");
  });

  it("fails plaintext as a runtime blocker, not a policy item", () => {
    const finding = byId(
      runClaudeEndpointChecks({ enteredUrl: "http://mcp.example.com/mcp" }, STAMP),
      "claude.endpoint.https",
    );
    expect(finding.status).toBe("violated");
    // The distinction matters: Claude never connects, so nothing downstream
    // could have been graded either.
    expect(finding.class).toBe("runtime-blocker");
    expect(finding.lane).toBe("runtime-compatibility");
  });

  it("fails an unparseable URL rather than throwing", () => {
    expect(
      byId(
        runClaudeEndpointChecks({ enteredUrl: "not a url" }, STAMP),
        "claude.endpoint.https",
      ).status,
    ).toBe("violated");
  });
});

describe("the redirect chain", () => {
  it("is not-evaluated when the run never reached the endpoint", () => {
    const findings = runClaudeEndpointChecks(
      { enteredUrl: "https://mcp.example.com/mcp" },
      STAMP,
    );
    expect(byId(findings, "claude.endpoint.redirects-stay-https").status).toBe(
      "not-evaluated",
    );
    expect(byId(findings, "claude.endpoint.redirects-terminate").status).toBe(
      "not-evaluated",
    );
  });

  it("passes a chain that stays on https", () => {
    expect(
      byId(
        runClaudeEndpointChecks(
          {
            enteredUrl: "https://mcp.example.com/mcp",
            redirectChain: [
              {
                url: "https://mcp.example.com/mcp",
                status: 308,
                location: "https://api.example.com/mcp",
              },
              { url: "https://api.example.com/mcp", status: 200 },
            ],
          },
          STAMP,
        ),
        "claude.endpoint.redirects-stay-https",
      ).status,
    ).toBe("satisfied");
  });

  it("fails a mid-chain downgrade even when the chain ends on https", () => {
    const finding = byId(
      runClaudeEndpointChecks(
        {
          enteredUrl: "https://mcp.example.com/mcp",
          redirectChain: [
            {
              url: "https://mcp.example.com/mcp",
              status: 302,
              location: "http://redirect.example.com/mcp",
            },
            {
              url: "http://redirect.example.com/mcp",
              status: 302,
              location: "https://api.example.com/mcp",
            },
            { url: "https://api.example.com/mcp", status: 200 },
          ],
        },
        STAMP,
      ),
      "claude.endpoint.redirects-stay-https",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({
      hops: [{ to: "http://redirect.example.com/mcp" }],
    });
  });

  it("resolves a relative Location against the hop it came from", () => {
    expect(
      byId(
        runClaudeEndpointChecks(
          {
            enteredUrl: "https://mcp.example.com/mcp",
            redirectChain: [
              {
                url: "https://mcp.example.com/mcp",
                status: 308,
                location: "/v2/mcp",
              },
              { url: "https://mcp.example.com/v2/mcp", status: 200 },
            ],
          },
          STAMP,
        ),
        "claude.endpoint.redirects-stay-https",
      ).status,
    ).toBe("satisfied");
  });

  it("fails a chain that ran past the client's limit", () => {
    expect(
      byId(
        runClaudeEndpointChecks(
          {
            enteredUrl: "https://mcp.example.com/mcp",
            redirectChain: [
              { url: "https://mcp.example.com/mcp", status: 302, location: "/a" },
            ],
            redirectLimitHit: true,
          },
          STAMP,
        ),
        "claude.endpoint.redirects-terminate",
      ).status,
    ).toBe("violated");
  });
});
