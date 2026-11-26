/**
 * Client rules for MCPJam as an MCP Apps host (ext-apps 2026-01-26).
 *
 * C071 and C072 (the host declares `io.modelcontextprotocol/ui` with the
 * content types it supports) are already proven on the wire in both eras by
 * `tests/support/apps-capability-carrier.integration.test.ts`. C073 is a MAY
 * MCPJam does not use. C074 is proven here: the apps conformance run, which is
 * the code behind the `ui-*` checks, fetches the UI resource a tool declares
 * with a `resources/read` for exactly that URI.
 */

import { describe, expect } from "vitest";
import { MCPAppsConformanceTest } from "../../src/apps-conformance/index.js";
import {
  CONFORMANCE_UI_RESOURCE_URI,
  startConformanceMockServer,
  type ConformanceMockRequest,
} from "../mock-servers/conformance-mcp-server.js";
import {
  createFixtureHandler,
  FIXTURE_APP_WIDGET_URI,
} from "../support/dual-era-fixture.js";
import {
  coveredBy,
  noBehavior,
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  type WireRequest,
} from "./harness.js";

describe("MCP Apps host rules", () => {
  coveredBy(
    "C071",
    "tests/support/apps-capability-carrier.integration.test.ts",
    "legacy: advertises io.modelcontextprotocol/ui in the initialize request's params.capabilities.extensions",
  );

  coveredBy(
    "C072",
    "tests/support/apps-capability-carrier.integration.test.ts",
    "modern (2026-07-28): the empirical carrier for io.modelcontextprotocol/ui",
  );

  noBehavior(
    "C073",
    "MCPJam never prefetches or caches UI resources ahead of a render; a host MAY, so not doing it is allowed",
  );

  ruleTest(
    "C074",
    "the apps run fetches the UI resource a tool declares with resources/read (2025-11-25)",
    async () => {
      const received: ConformanceMockRequest[] = [];
      const server = await startConformanceMockServer({
        onRequest: (record) => received.push(record),
      });
      try {
        const result = await new MCPAppsConformanceTest({
          url: server.url,
          timeout: 10_000,
          __suppressTelemetry: true,
        }).run();
        expect(
          result.checks.find((check) => check.id === "ui-resources-readable")
            ?.status,
        ).toBe("passed");
      } finally {
        await server.stop();
      }
      const reads = received
        .map((record) => record.body as { method?: string; params?: { uri?: unknown } } | undefined)
        .filter((body) => body?.method === "resources/read");
      expect(reads.map((body) => body?.params?.uri)).toContain(
        CONFORMANCE_UI_RESOURCE_URI,
      );
    },
  );

  ruleTest(
    "C074",
    "the apps run fetches the UI resource a tool declares with resources/read (2026-07-28)",
    async () => {
      const requests: WireRequest[] = [];
      const handler = createFixtureHandler({ apps: true });
      const result = await new MCPAppsConformanceTest({
        url: "http://localhost/mcp",
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
        baseFetch: recordingFetch((request) => handler.fetch(request), requests, () => "apps"),
        __suppressTelemetry: true,
      }).run();
      expect(
        result.checks.find((check) => check.id === "ui-resources-readable")
          ?.status,
      ).toBe("passed");
      const reads = requests.filter(
        (request) => rpcMethodOf(request) === "resources/read",
      );
      expect(reads.map((request) => rpcOf(request)?.params?.uri)).toContain(
        FIXTURE_APP_WIDGET_URI,
      );
    },
  );
});
