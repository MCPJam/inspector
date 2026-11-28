import { describe, expect, it, vi } from "vitest";
import { withCatalogStructuredContentRule } from "../src/suite-file-run/preflight.js";
import { seedHostTemplate } from "../src/host-config/templates/index.js";
import {
  bundledHostCompatCatalog,
  type HostCompatCatalog,
} from "../src/host-compat/catalog.js";
import { structuredContentRuleOf } from "../src/mcp-client-manager/tool-result-rule.js";
import {
  HOST_CONFIG_FEATURES,
  HOST_CONFIG_FEATURES_HEADER,
  PlatformApiClient,
} from "../src/platform/index.js";

describe("local runs take the catalog row's client rule (KES-1007)", () => {
  const catalogWith = (rule?: "fallback"): HostCompatCatalog =>
    ({
      hostsById: {
        "claude-desktop": {
          id: "claude-desktop",
          modelVisibleMcpToolResults: {
            directContent: { image: true },
            ...(rule ? { structuredContent: rule } : {}),
          },
        },
      },
    }) as unknown as HostCompatCatalog;

  it("copies only structuredContent onto the compiled template", () => {
    const seeded = seedHostTemplate("claude-desktop");
    const withRule = withCatalogStructuredContentRule(
      "claude-desktop",
      seeded,
      catalogWith("fallback")
    ) as { modelVisibleMcpToolResults?: unknown };
    expect(withRule.modelVisibleMcpToolResults).toEqual({
      ...((seeded as { modelVisibleMcpToolResults?: object })
        .modelVisibleMcpToolResults ?? {}),
      structuredContent: "fallback",
    });
  });

  it("leaves the template untouched when the catalog row has no rule", () => {
    const seeded = seedHostTemplate("claude-desktop");
    expect(
      withCatalogStructuredContentRule("claude-desktop", seeded, catalogWith())
    ).toBe(seeded);
  });

  it("the bundled catalog carries a rule for the measured clients only", () => {
    const rules = Object.entries(bundledHostCompatCatalog().hostsById)
      .map(([id, host]) => [
        id,
        structuredContentRuleOf(host.modelVisibleMcpToolResults),
      ])
      .filter(([, rule]) => rule !== undefined);
    expect(Object.fromEntries(rules)).toEqual({
      "claude-desktop": "fallback",
      "claude-code": "preferred",
      "codex-cli": "preferred",
    });
    const local = withCatalogStructuredContentRule(
      "claude-desktop",
      seedHostTemplate("claude-desktop")
    ) as { modelVisibleMcpToolResults?: { structuredContent?: string } };
    expect(local.modelVisibleMcpToolResults?.structuredContent).toBe(
      "fallback"
    );
  });
});

describe("PlatformApiClient declares the host-config keys it understands", () => {
  it("sends the features header on every request", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ id: "u_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    await new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    }).getMe();
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers[HOST_CONFIG_FEATURES_HEADER]).toBe(HOST_CONFIG_FEATURES);
  });
});
